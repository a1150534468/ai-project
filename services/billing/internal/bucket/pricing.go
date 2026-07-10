package bucket

import (
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yc-billing/internal/model"
)

const (
	SourceLegacyTopup = "topup"
	SourceTopupPaid   = "topup_paid"
	SourceTopupGift   = "topup_gift"
	SourceMembership  = "membership"
	SourceRedeem      = "redeem"
	SourceAdjust      = "adjust"
	SourceSystem      = "system"
)

const discountFullBps = 10000

type Alloc struct {
	BucketID       uint   `json:"bucketId"`
	Amount         int64  `json:"amount"`
	OriginalAmount int64  `json:"originalAmount,omitempty"`
	Source         string `json:"source,omitempty"`
	DiscountBps    int    `json:"discountBps,omitempty"`
	GrowthPoints   int64  `json:"growthPoints,omitempty"`
	SavedPoints    int64  `json:"savedPoints,omitempty"`
}

type PricedConsumeResult struct {
	OriginalPoints int64   `json:"originalPoints"`
	ActualPoints   int64   `json:"actualPoints"`
	GrowthPoints   int64   `json:"growthPoints"`
	SavedPoints    int64   `json:"savedPoints"`
	Allocations    []Alloc `json:"allocations"`
}

func SourceEnjoysVIPDiscount(source string) bool {
	return source == SourceTopupPaid || source == SourceLegacyTopup
}

func pointBucketConsumeOrder() string {
	return "CASE WHEN expires_at IS NOT NULL THEN 0 WHEN source IN ('topup_paid','topup') THEN 2 ELSE 1 END, expires_at ASC NULLS LAST, id ASC"
}

func discountedPoints(original int64, discountBps int) int64 {
	if original <= 0 {
		return 0
	}
	if discountBps <= 0 {
		return 1
	}
	out := (original*int64(discountBps) + discountFullBps - 1) / discountFullBps
	if out < 1 {
		return 1
	}
	return out
}

func paidOriginalCapacity(actualRemaining int64, discountBps int) int64 {
	if actualRemaining <= 0 {
		return 0
	}
	if discountBps <= 0 {
		return actualRemaining
	}
	return actualRemaining * discountFullBps / int64(discountBps)
}

func ConsumePricedInTx(tx *gorm.DB, userID string, originalPoints int64, discountBps int) (PricedConsumeResult, error) {
	return consumePriced(tx, userID, originalPoints, discountBps, false)
}

func ConsumePricedBestEffortInTx(tx *gorm.DB, userID string, originalPoints int64, discountBps int) (PricedConsumeResult, error) {
	return consumePriced(tx, userID, originalPoints, discountBps, true)
}

func consumePriced(tx *gorm.DB, userID string, originalPoints int64, discountBps int, allowPartial bool) (PricedConsumeResult, error) {
	if originalPoints <= 0 {
		return PricedConsumeResult{}, nil
	}

	var buckets []model.PointBucket
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)", userID, time.Now()).
		Order(pointBucketConsumeOrder()).Find(&buckets).Error; err != nil {
		return PricedConsumeResult{}, err
	}

	allocs, remainingOriginal := allocatePricedBuckets(buckets, originalPoints, discountBps)
	if remainingOriginal > 0 && !allowPartial {
		return PricedConsumeResult{}, ErrInsufficient
	}
	consumedOriginal := originalPoints - remainingOriginal
	if consumedOriginal <= 0 {
		return PricedConsumeResult{}, nil
	}

	priceAllocations(allocs, discountBps)
	for _, a := range allocs {
		if err := tx.Model(&model.PointBucket{}).Where("id = ?", a.BucketID).
			Update("remaining", gorm.Expr("remaining - ?", a.Amount)).Error; err != nil {
			return PricedConsumeResult{}, err
		}
	}
	return summarizeAllocations(consumedOriginal, allocs), nil
}

func allocatePricedBuckets(buckets []model.PointBucket, originalPoints int64, discountBps int) ([]Alloc, int64) {
	allocs := make([]Alloc, 0, len(buckets))
	remainingOriginal := originalPoints
	for _, b := range buckets {
		if remainingOriginal <= 0 {
			break
		}

		takeOriginal := b.Remaining
		if SourceEnjoysVIPDiscount(b.Source) {
			takeOriginal = paidOriginalCapacity(b.Remaining, discountBps)
		}
		if takeOriginal > remainingOriginal {
			takeOriginal = remainingOriginal
		}
		if takeOriginal <= 0 {
			continue
		}

		allocs = append(allocs, Alloc{
			BucketID:       b.ID,
			OriginalAmount: takeOriginal,
			Source:         b.Source,
			DiscountBps:    discountBps,
		})
		remainingOriginal -= takeOriginal
	}
	return allocs, remainingOriginal
}

func priceAllocations(allocs []Alloc, discountBps int) {
	var paidOriginalPrefix int64
	for i := range allocs {
		if !SourceEnjoysVIPDiscount(allocs[i].Source) {
			allocs[i].Amount = allocs[i].OriginalAmount
			allocs[i].GrowthPoints = 0
			allocs[i].SavedPoints = 0
			continue
		}
		beforeOriginal := paidOriginalPrefix
		paidOriginalPrefix += allocs[i].OriginalAmount
		beforeActual := discountedPoints(beforeOriginal, discountBps)
		afterActual := discountedPoints(paidOriginalPrefix, discountBps)
		actual := afterActual - beforeActual
		if actual < 0 {
			actual = 0
		}
		allocs[i].Amount = actual
		allocs[i].GrowthPoints = actual
		allocs[i].SavedPoints = allocs[i].OriginalAmount - actual
	}
}

func summarizeAllocations(originalPoints int64, allocs []Alloc) PricedConsumeResult {
	result := PricedConsumeResult{
		OriginalPoints: originalPoints,
		Allocations:    allocs,
	}
	for _, a := range allocs {
		result.ActualPoints += a.Amount
		result.GrowthPoints += a.GrowthPoints
		result.SavedPoints += a.SavedPoints
	}
	return result
}

func TrimPricedAllocations(allocs []Alloc, keepOriginal int64) PricedConsumeResult {
	if keepOriginal <= 0 {
		return PricedConsumeResult{Allocations: []Alloc{}}
	}
	kept := make([]Alloc, 0, len(allocs))
	remaining := keepOriginal
	discountBps := discountFullBps
	for _, a := range allocs {
		if a.DiscountBps > 0 {
			discountBps = a.DiscountBps
			break
		}
	}
	for _, a := range allocs {
		if remaining <= 0 {
			break
		}
		next := a
		if next.OriginalAmount > remaining {
			next.OriginalAmount = remaining
		}
		kept = append(kept, next)
		remaining -= next.OriginalAmount
	}
	priceAllocations(kept, discountBps)
	return summarizeAllocations(keepOriginal, kept)
}
