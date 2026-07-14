package wallet

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/vip"
)

func (w *Wallet) Settle(opID string, actual int64) error {
	return w.SettleWithTokens(opID, actual, TokenUsage{})
}

func (w *Wallet) SettleWithTokens(opID string, actual int64, usage TokenUsage) error {
	if actual < 0 {
		actual = 0
	}

	return w.st.DB.Transaction(func(tx *gorm.DB) error {
		if err := lockUsageOperation(tx, opID); err != nil {
			return err
		}

		var rec model.UsageRecord
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&rec, "operation_id = ?", opID).Error
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotReserved
			}
			return err
		}
		if rec.Status != "reserved" {
			return nil
		}

		allocs, err := usageAllocations(rec)
		if err != nil {
			return err
		}
		final, err := settlePricedUsage(tx, rec, allocs, actual)
		if err != nil {
			return err
		}

		allocJSON, _ := json.Marshal(final.Allocations)
		if final.GrowthPoints > 0 {
			_, _, err := vip.New(tx).AddGrowthInTx(tx, vip.AddGrowthInput{
				OperationID:             "usage:" + opID,
				UserID:                  rec.UserID,
				SourceType:              "usage",
				GrowthPoints:            final.GrowthPoints,
				RelatedUsageOperationID: opID,
				Note:                    "settled paid topup points",
				OccurredAt:              time.Now(),
			})
			if err != nil {
				return err
			}
		}

		now := time.Now()
		result := tx.Model(&model.UsageRecord{}).
			Where("operation_id = ? AND status = ?", opID, "reserved").
			Updates(map[string]any{
				"status":              "settled",
				"original_points":     actual,
				"actual_points":       final.ActualPoints,
				"vip_saved_points":    final.SavedPoints,
				"vip_growth_points":   final.GrowthPoints,
				"allocations":         string(allocJSON),
				"settled_at":          &now,
				"input_tokens":        usage.InputTokens,
				"output_tokens":       usage.OutputTokens,
				"cache_input_tokens":  usage.CacheInputTokens,
				"cache_output_tokens": usage.CacheOutputTokens,
			})
		return result.Error
	})
}

func usageAllocations(rec model.UsageRecord) ([]bucket.Alloc, error) {
	var allocs []bucket.Alloc
	if rec.Allocations == "" {
		return allocs, nil
	}
	if err := json.Unmarshal([]byte(rec.Allocations), &allocs); err != nil {
		return nil, err
	}

	discountBps := effectiveDiscountBps(rec.VipDiscountBps)
	for i := range allocs {
		if allocs[i].OriginalAmount <= 0 {
			allocs[i].OriginalAmount = allocs[i].Amount
		}
		if allocs[i].DiscountBps <= 0 {
			allocs[i].DiscountBps = discountBps
		}
	}
	return allocs, nil
}

func settlePricedUsage(tx *gorm.DB, rec model.UsageRecord, allocs []bucket.Alloc, actualOriginal int64) (bucket.PricedConsumeResult, error) {
	reservedOriginal := rec.OriginalPoints
	if reservedOriginal <= 0 {
		reservedOriginal = rec.ReservedPoints
	}

	keepOriginal := actualOriginal
	if keepOriginal > reservedOriginal {
		keepOriginal = reservedOriginal
	}

	final := bucket.TrimPricedAllocations(allocs, keepOriginal)
	if actualOriginal > reservedOriginal {
		extraOriginal := actualOriginal - reservedOriginal
		extra, err := bucket.ConsumePricedBestEffortInTx(tx, rec.UserID, extraOriginal, effectiveDiscountBps(rec.VipDiscountBps))
		if err != nil {
			return bucket.PricedConsumeResult{}, err
		}
		final.OriginalPoints += extra.OriginalPoints
		final.ActualPoints += extra.ActualPoints
		final.GrowthPoints += extra.GrowthPoints
		final.SavedPoints += extra.SavedPoints
		final.Allocations = append(final.Allocations, extra.Allocations...)
		return final, nil
	}

	if rec.ReservedPoints > final.ActualPoints {
		if err := bucket.RefundInTx(tx, allocs, rec.ReservedPoints-final.ActualPoints); err != nil {
			return bucket.PricedConsumeResult{}, err
		}
	}
	return final, nil
}

func effectiveDiscountBps(discountBps int) int {
	if discountBps <= 0 {
		return vip.DiscountFullBps
	}
	return discountBps
}
