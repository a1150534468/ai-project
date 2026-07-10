package resource

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/videopoint"
	"yc-billing/internal/vip"
	"yc-billing/internal/wallet"
)

func (s *Service) Charge(opID, userID, resourceKey string, units int64) (int64, error) {
	cost, err := s.Quote(resourceKey, units)
	if err != nil {
		return 0, err
	}

	charged := int64(0)
	err = s.st.DB.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		if err := lockUsageOperation(tx, opID); err != nil {
			return err
		}

		var existing model.UsageRecord
		rechargeRefunded := false
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&existing, "operation_id = ?", opID).Error
		if err == nil {
			if existing.Status != "refunded" {
				charged = existing.ActualPoints
				return nil
			}
			rechargeRefunded = true
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		vipSummary, err := vip.New(tx).SnapshotForPricingInTx(userID)
		if err != nil {
			return err
		}

		priced, err := bucket.ConsumePricedInTx(tx, userID, cost, vipSummary.DiscountBps)
		if errors.Is(err, bucket.ErrInsufficient) {
			return ErrInsufficient
		}
		if err != nil {
			return err
		}
		charged = priced.ActualPoints

		growthOperationID := "usage:" + opID
		if rechargeRefunded {
			growthOperationID = fmt.Sprintf("usage:%s:recharge:%d", opID, now.UnixNano())
		}
		if priced.GrowthPoints > 0 {
			if _, _, err := vip.New(tx).AddGrowthInTx(tx, vip.AddGrowthInput{
				OperationID:             growthOperationID,
				UserID:                  userID,
				SourceType:              "usage",
				GrowthPoints:            priced.GrowthPoints,
				RelatedUsageOperationID: opID,
				Note:                    "settled resource paid topup points",
				OccurredAt:              now,
			}); err != nil {
				return err
			}
		}

		allocJSON, err := json.Marshal(priced.Allocations)
		if err != nil {
			return err
		}
		fields := map[string]interface{}{
			"user_id":           userID,
			"type":              resourceKey,
			"model":             resourceKey,
			"status":            "settled",
			"reserved_points":   priced.ActualPoints,
			"actual_points":     priced.ActualPoints,
			"original_points":   cost,
			"vip_level_id":      vipSummary.LevelID,
			"vip_level_name":    vipSummary.LevelName,
			"vip_discount_bps":  vipSummary.DiscountBps,
			"vip_saved_points":  priced.SavedPoints,
			"vip_growth_points": priced.GrowthPoints,
			"allocations":       string(allocJSON),
			"created_at":        now,
			"settled_at":        &now,
		}
		if rechargeRefunded {
			result := tx.Model(&model.UsageRecord{}).
				Where("operation_id = ? AND status = ?", opID, "refunded").
				Updates(fields)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return gorm.ErrRecordNotFound
			}
			return nil
		}
		return tx.Create(&model.UsageRecord{
			OperationID:     opID,
			UserID:          userID,
			Type:            resourceKey,
			Model:           resourceKey,
			Status:          "settled",
			ReservedPoints:  priced.ActualPoints,
			ActualPoints:    priced.ActualPoints,
			OriginalPoints:  cost,
			VipLevelID:      vipSummary.LevelID,
			VipLevelName:    vipSummary.LevelName,
			VipDiscountBps:  vipSummary.DiscountBps,
			VipSavedPoints:  priced.SavedPoints,
			VipGrowthPoints: priced.GrowthPoints,
			Allocations:     string(allocJSON),
			CreatedAt:       now,
			SettledAt:       &now,
		}).Error
	})
	if err != nil {
		return 0, err
	}
	return charged, nil
}

// ChargeVideo 扣「视频点」余额（与算力点分账户）。视频点为预购余额，不走 VIP 折扣。
func (s *Service) ChargeVideo(opID, userID, resourceKey string, units int64) (int64, error) {
	cost, err := s.Quote(resourceKey, units)
	if err != nil {
		return 0, err
	}
	return s.chargeVideoCost(opID, userID, resourceKey, cost)
}

// ChargeVideoIO 扣「视频点」余额，按复合计价（输入秒 × 输入单价 + 输出秒 × 输出单价）。
func (s *Service) ChargeVideoIO(opID, userID, resourceKey string, inputSec, outputSec int64) (int64, error) {
	cost, err := s.QuoteVideoIO(resourceKey, inputSec, outputSec)
	if err != nil {
		return 0, err
	}
	return s.chargeVideoCost(opID, userID, resourceKey, cost)
}

// SettleVideoIO 按实际输出秒结算视频用量，退回「预扣最大时长」多扣的差额。
// resourceKey 为 _text 时按纯输出计价、为 _with_video 时按复合计价，均由 QuoteVideoIO 处理。
func (s *Service) SettleVideoIO(opID, resourceKey string, inputSec, outputSec int64) (int64, error) {
	actualCost, err := s.QuoteVideoIO(resourceKey, inputSec, outputSec)
	if err != nil {
		return 0, err
	}
	var settled int64
	err = s.st.DB.Transaction(func(tx *gorm.DB) error {
		var e error
		settled, e = videopoint.SettleVideoInTx(tx, opID, actualCost)
		return e
	})
	if err != nil {
		return 0, err
	}
	return settled, nil
}

// chargeVideoCost 在事务内按预算好的成本扣视频点，幂等由 videopoint.ChargeInTx 的 operationId 保证。
func (s *Service) chargeVideoCost(opID, userID, resourceKey string, cost int64) (int64, error) {
	err := s.st.DB.Transaction(func(tx *gorm.DB) error {
		_, e := videopoint.ChargeInTx(tx, opID, userID, resourceKey, cost)
		if errors.Is(e, videopoint.ErrInsufficient) {
			return ErrInsufficient
		}
		return e
	})
	if err != nil {
		return 0, err
	}
	return cost, nil
}

func (s *Service) Reserve(opID, userID, resourceKey string, units int64) (int64, error) {
	cost, err := s.Quote(resourceKey, units)
	if err != nil {
		return 0, err
	}
	reserved, err := wallet.New(s.st).ReservePriced(opID, userID, resourceKey, resourceKey, cost)
	if errors.Is(err, wallet.ErrInsufficient) {
		return 0, ErrInsufficient
	}
	return reserved, err
}

func (s *Service) Settle(opID, resourceKey string, actualUnits int64) (int64, error) {
	actual, err := s.Quote(resourceKey, actualUnits)
	if err != nil {
		return 0, err
	}
	if err := wallet.New(s.st).Settle(opID, actual); err != nil {
		return 0, err
	}
	var rec model.UsageRecord
	if err := s.st.DB.First(&rec, "operation_id = ?", opID).Error; err != nil {
		return 0, err
	}
	return rec.ActualPoints, nil
}

func (s *Service) RefundCharge(opID string) error {
	return s.st.DB.Transaction(func(tx *gorm.DB) error {
		if err := lockUsageOperation(tx, opID); err != nil {
			return err
		}
		var rec model.UsageRecord
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&rec, "operation_id = ?", opID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		// 视频点扣费按视频点原路退回（与算力点分账户）
		if rec.Type == videopoint.UsageType {
			return videopoint.RefundUsageRecordInTx(tx, &rec)
		}
		refundPoints := refundablePoints(rec)
		if refundPoints < 0 {
			return nil
		}
		var allocs []bucket.Alloc
		if rec.Allocations != "" {
			if err := json.Unmarshal([]byte(rec.Allocations), &allocs); err != nil {
				return err
			}
		}
		if err := bucket.RefundInTx(tx, allocs, refundPoints); err != nil {
			return err
		}
		if rec.Status == "settled" && rec.VipGrowthPoints > 0 {
			refundGrowthOpID, err := refundGrowthOperationID(tx, rec)
			if err != nil {
				return err
			}
			if _, _, err := vip.New(tx).ReverseGrowthInTx(tx, vip.ReverseGrowthInput{
				OperationID:             refundGrowthOpID,
				UserID:                  rec.UserID,
				SourceType:              "usage_refund",
				GrowthPoints:            rec.VipGrowthPoints,
				RelatedUsageOperationID: opID,
				Note:                    "refunded resource paid topup points",
				OccurredAt:              time.Now(),
			}); err != nil {
				return err
			}
		}
		updates := map[string]interface{}{"status": "refunded"}
		if rec.Status == "reserved" {
			now := time.Now()
			updates["actual_points"] = int64(0)
			updates["settled_at"] = &now
		}
		return tx.Model(&rec).Updates(updates).Error
	})
}

func refundGrowthOperationID(tx *gorm.DB, rec model.UsageRecord) (string, error) {
	var ledger model.VipGrowthLedger
	err := tx.Where(
		"user_id = ? AND related_usage_operation_id = ? AND source_type = ? AND growth_points > 0",
		rec.UserID, rec.OperationID, "usage",
	).Order("id DESC").First(&ledger).Error
	if err == nil && ledger.OperationID != "" {
		return "refund:" + ledger.OperationID, nil
	}
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return "", err
	}
	return fmt.Sprintf("refund:%s:%d", rec.OperationID, usageLifecycleUnixNano(rec)), nil
}

func usageLifecycleUnixNano(rec model.UsageRecord) int64 {
	if rec.SettledAt != nil && !rec.SettledAt.IsZero() {
		return rec.SettledAt.UnixNano()
	}
	if !rec.CreatedAt.IsZero() {
		return rec.CreatedAt.UnixNano()
	}
	return time.Now().UnixNano()
}

func refundablePoints(rec model.UsageRecord) int64 {
	switch rec.Status {
	case "reserved":
		return rec.ReservedPoints
	case "settled":
		return rec.ActualPoints
	default:
		return -1
	}
}
