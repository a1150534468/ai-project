package videopoint

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"ai-assistant-billing/internal/model"
)

var (
	ErrInsufficient          = errors.New("视频点余额不足")
	ErrOperationTypeMismatch = errors.New("operation id already belongs to another usage type")
)

const (
	TopUpKind          = "video_points"
	UsageType          = "video"
	FixedPointsPerYuan = int64(100)
)

func Balance(db *gorm.DB, userID string) (int64, error) {
	var account model.VideoPointAccount
	err := db.First(&account, "user_id = ?", userID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, nil
	}
	return account.Balance, err
}

func CreditInTx(tx *gorm.DB, userID string, amount int64) error {
	if amount <= 0 {
		return nil
	}
	now := time.Now()
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.VideoPointAccount{
		UserID:    userID,
		Balance:   0,
		UpdatedAt: now,
	}).Error; err != nil {
		return err
	}
	return tx.Model(&model.VideoPointAccount{}).
		Where("user_id = ?", userID).
		Updates(map[string]interface{}{
			"balance":    gorm.Expr("balance + ?", amount),
			"updated_at": now,
		}).Error
}

// DeductInTx 管理端直接扣减视频点余额（不建用量记录）；余额不足返回 ErrInsufficient。
func DeductInTx(tx *gorm.DB, userID string, amount int64) error {
	if amount <= 0 {
		return nil
	}
	if err := ensureAccountLocked(tx, userID); err != nil {
		return err
	}
	var account model.VideoPointAccount
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&account, "user_id = ?", userID).Error; err != nil {
		return err
	}
	if account.Balance < amount {
		return ErrInsufficient
	}
	return tx.Model(&account).Updates(map[string]interface{}{
		"balance":    gorm.Expr("balance - ?", amount),
		"updated_at": time.Now(),
	}).Error
}

func ChargeInTx(tx *gorm.DB, opID, userID, resourceKey string, cost int64) (int64, error) {
	var existing model.UsageRecord
	rechargeRefunded := false
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&existing, "operation_id = ?", opID).Error; err == nil {
		if existing.Type != UsageType {
			return 0, ErrOperationTypeMismatch
		}
		if existing.Status != "refunded" {
			return existing.ActualPoints, nil
		}
		rechargeRefunded = true
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, err
	}

	if cost > 0 {
		if err := ensureAccountLocked(tx, userID); err != nil {
			return 0, err
		}
		var account model.VideoPointAccount
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&account, "user_id = ?", userID).Error; err != nil {
			return 0, err
		}
		if account.Balance < cost {
			return 0, ErrInsufficient
		}
		if err := tx.Model(&account).Updates(map[string]interface{}{
			"balance":    gorm.Expr("balance - ?", cost),
			"updated_at": time.Now(),
		}).Error; err != nil {
			return 0, err
		}
	}

	now := time.Now()
	if rechargeRefunded {
		return cost, tx.Model(&model.UsageRecord{}).
			Where("operation_id = ? AND status = ?", opID, "refunded").
			Updates(map[string]interface{}{
				"user_id":         userID,
				"type":            UsageType,
				"model":           resourceKey,
				"status":          "settled",
				"reserved_points": cost,
				"actual_points":   cost,
				"allocations":     "",
				"created_at":      now,
				"settled_at":      &now,
			}).Error
	}
	return cost, tx.Create(&model.UsageRecord{
		OperationID:    opID,
		UserID:         userID,
		Type:           UsageType,
		Model:          resourceKey,
		Status:         "settled",
		ReservedPoints: cost,
		ActualPoints:   cost,
		Allocations:    "",
		CreatedAt:      now,
		SettledAt:      &now,
	}).Error
}

// SettleVideoInTx 结算一条已预扣的视频用量：把实际成本下调到 actualCost，并把多预扣的差额退回余额。
// 用于「自动时长」先按最大 15s 预扣、出结果后按实际输出秒结算的场景。
// 幂等：以相同 actualCost 重复调用第二次差额为 0、不重复退款；永不结算高于已预扣（安全下限）。
func SettleVideoInTx(tx *gorm.DB, opID string, actualCost int64) (int64, error) {
	if actualCost < 0 {
		actualCost = 0
	}
	var rec model.UsageRecord
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&rec, "operation_id = ?", opID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		return 0, err
	}
	if rec.Type != UsageType {
		return 0, ErrOperationTypeMismatch
	}
	if rec.Status == "refunded" {
		return 0, nil
	}
	if actualCost > rec.ActualPoints {
		actualCost = rec.ActualPoints
	}
	delta := rec.ActualPoints - actualCost
	if delta <= 0 {
		return rec.ActualPoints, nil
	}
	if err := CreditInTx(tx, rec.UserID, delta); err != nil {
		return 0, err
	}
	now := time.Now()
	if err := tx.Model(&model.UsageRecord{}).
		Where("operation_id = ?", opID).
		Updates(map[string]interface{}{
			"actual_points": actualCost,
			"settled_at":    &now,
		}).Error; err != nil {
		return 0, err
	}
	return actualCost, nil
}

func RefundUsageRecordInTx(tx *gorm.DB, rec *model.UsageRecord) error {
	refundPoints := int64(-1)
	switch rec.Status {
	case "reserved":
		refundPoints = rec.ReservedPoints
	case "settled":
		refundPoints = rec.ActualPoints
	}
	if refundPoints < 0 {
		return nil
	}
	if err := CreditInTx(tx, rec.UserID, refundPoints); err != nil {
		return err
	}
	// 已把全部点数退回，净实扣为 0：无论原状态是 reserved 还是 settled 都清零 actual_points，
	// 避免退款记录仍显示「实扣 140」、也避免消费统计把已退款计入。
	now := time.Now()
	updates := map[string]interface{}{
		"status":        "refunded",
		"actual_points": int64(0),
		"settled_at":    &now,
	}
	return tx.Model(rec).Updates(updates).Error
}

func ensureAccountLocked(tx *gorm.DB, userID string) error {
	now := time.Now()
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.VideoPointAccount{
		UserID:    userID,
		Balance:   0,
		UpdatedAt: now,
	}).Error; err != nil {
		return err
	}
	return nil
}
