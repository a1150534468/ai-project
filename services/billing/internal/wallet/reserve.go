package wallet

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/vip"
)

func (w *Wallet) Reserve(opID, userID, typ, modelName string, reserve int64) (int64, error) {
	return w.ReservePriced(opID, userID, typ, modelName, reserve)
}

func (w *Wallet) ReservePriced(opID, userID, typ, modelName string, originalReserve int64) (int64, error) {
	if originalReserve < 0 {
		originalReserve = 0
	}

	var reservedActual int64
	err := w.st.DB.Transaction(func(tx *gorm.DB) error {
		if err := lockUsageOperation(tx, opID); err != nil {
			return err
		}

		var existing model.UsageRecord
		err := tx.First(&existing, "operation_id = ?", opID).Error
		if err == nil {
			reservedActual = existing.ReservedPoints
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		vipSummary, err := reserveVIPSummary(tx, userID)
		if err != nil {
			return err
		}

		result, err := bucket.ConsumePricedInTx(tx, userID, originalReserve, vipSummary.DiscountBps)
		if errors.Is(err, bucket.ErrInsufficient) {
			return ErrInsufficient
		}
		if err != nil {
			return err
		}

		reservedActual = result.ActualPoints
		allocJSON, _ := json.Marshal(result.Allocations)
		rec := model.UsageRecord{
			OperationID:     opID,
			UserID:          userID,
			Type:            typ,
			Model:           modelName,
			Status:          "reserved",
			ReservedPoints:  result.ActualPoints,
			ActualPoints:    0,
			OriginalPoints:  originalReserve,
			VipLevelID:      vipSummary.LevelID,
			VipLevelName:    vipSummary.LevelName,
			VipDiscountBps:  vipSummary.DiscountBps,
			VipSavedPoints:  result.SavedPoints,
			VipGrowthPoints: 0,
			Allocations:     string(allocJSON),
			CreatedAt:       time.Now(),
		}
		return tx.Create(&rec).Error
	})
	return reservedActual, err
}

func reserveVIPSummary(tx *gorm.DB, userID string) (vip.Summary, error) {
	summary, err := vip.New(tx).SnapshotForPricingInTx(userID)
	if err != nil {
		return vip.Summary{}, err
	}

	if summary.DiscountBps <= 0 {
		summary.DiscountBps = vip.DiscountFullBps
	}
	if summary.LevelName == "" {
		summary.LevelName = "普通会员"
	}
	return summary, nil
}
