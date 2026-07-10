package bucket

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yc-billing/internal/model"
)

var ErrInsufficient = errors.New("余额不足")

// GrantPoints 建一个桶（amount<=0 no-op）。expiresAt=nil 永久。
func GrantPoints(db *gorm.DB, userID string, amount int64, expiresAt *time.Time, source string) error {
	if amount <= 0 {
		return nil
	}
	return db.Create(&model.PointBucket{
		UserID: userID, Remaining: amount, ExpiresAt: expiresAt, Source: source, CreatedAt: time.Now(),
	}).Error
}

// Balance 存活桶 remaining 之和。
func Balance(db *gorm.DB, userID string) (int64, error) {
	var total int64
	err := db.Model(&model.PointBucket{}).
		Where("user_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)", userID, time.Now()).
		Select("COALESCE(SUM(remaining),0)").Scan(&total).Error
	return total, err
}

// BatchBalances 多用户存活桶求和。
func BatchBalances(db *gorm.DB, userIDs []string) (map[string]int64, error) {
	out := map[string]int64{}
	for _, id := range userIDs {
		out[id] = 0
	}
	if len(userIDs) == 0 {
		return out, nil
	}
	type row struct {
		UserID string
		Sum    int64
	}
	var rows []row
	err := db.Model(&model.PointBucket{}).
		Select("user_id, COALESCE(SUM(remaining),0) AS sum").
		Where("user_id IN ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)", userIDs, time.Now()).
		Group("user_id").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.UserID] = r.Sum
	}
	return out, nil
}

// ConsumeInTx 事务内按"最早过期先扣"贪心扣 amount，返回分配明细。不足→ErrInsufficient。
func ConsumeInTx(tx *gorm.DB, userID string, amount int64) ([]Alloc, error) {
	if amount <= 0 {
		return []Alloc{}, nil
	}
	var buckets []model.PointBucket
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)", userID, time.Now()).
		Order(pointBucketConsumeOrder()).Find(&buckets).Error; err != nil {
		return nil, err
	}
	var total int64
	for _, b := range buckets {
		total += b.Remaining
	}
	if total < amount {
		return nil, ErrInsufficient
	}
	allocs := make([]Alloc, 0, len(buckets))
	need := amount
	for _, b := range buckets {
		if need <= 0 {
			break
		}
		take := b.Remaining
		if take > need {
			take = need
		}
		if err := tx.Model(&model.PointBucket{}).Where("id = ?", b.ID).
			Update("remaining", gorm.Expr("remaining - ?", take)).Error; err != nil {
			return nil, err
		}
		allocs = append(allocs, Alloc{BucketID: b.ID, Amount: take})
		need -= take
	}
	return allocs, nil
}

// RefundInTx 按 allocs 逆序退回 refundTotal（跳过已过期/不存在的桶）。
func RefundInTx(tx *gorm.DB, allocs []Alloc, refundTotal int64) error {
	now := time.Now()
	remaining := refundTotal
	for i := len(allocs) - 1; i >= 0 && remaining > 0; i-- {
		a := allocs[i]
		back := a.Amount
		if back > remaining {
			back = remaining
		}
		res := tx.Model(&model.PointBucket{}).
			Where("id = ? AND (expires_at IS NULL OR expires_at > ?)", a.BucketID, now).
			Update("remaining", gorm.Expr("remaining + ?", back))
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 1 { // 桶存活才算退成功；过期则跳过该笔
			remaining -= back
		}
	}
	return nil
}

// ChargeExtraInTx 尽力补扣 amount（不足也不报错，扣到 0 为止；用于 settle 少补）。
func ChargeExtraInTx(tx *gorm.DB, userID string, amount int64) error {
	if amount <= 0 {
		return nil
	}
	_, err := ConsumeInTx(tx, userID, amount)
	if err == ErrInsufficient {
		// 余额不足以补扣：尽力扣光存活桶（既成用量不回滚）
		return tx.Model(&model.PointBucket{}).
			Where("user_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)", userID, time.Now()).
			Update("remaining", 0).Error
	}
	return err
}

// SweepExpired 把过期且仍有余的桶置 0，返回处理行数（账务清理，正确性不依赖它）。
func SweepExpired(db *gorm.DB) (int64, error) {
	res := db.Model(&model.PointBucket{}).
		Where("expires_at IS NOT NULL AND expires_at <= ? AND remaining > 0", time.Now()).
		Update("remaining", 0)
	return res.RowsAffected, res.Error
}
