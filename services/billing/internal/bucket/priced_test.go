package bucket

import (
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestConsumePricedInTxDiscountsOnlyPaidSource(t *testing.T) {
	db := openBucketTestDB(t)
	userID := "u1"
	if err := GrantPoints(db, userID, 100, nil, SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	result, err := ConsumePricedInTx(db, userID, 100, 9000)
	if err != nil {
		t.Fatal(err)
	}
	if result.OriginalPoints != 100 || result.ActualPoints != 90 || result.GrowthPoints != 90 || result.SavedPoints != 10 {
		t.Fatalf("bad result: %+v", result)
	}
	if len(result.Allocations) != 1 || result.Allocations[0].OriginalAmount != 100 || result.Allocations[0].Amount != 90 || result.Allocations[0].Source != SourceTopupPaid {
		t.Fatalf("bad allocation: %+v", result.Allocations)
	}
}

func TestConsumePricedInTxPrioritizesAdjustmentBeforePaidTopupBuckets(t *testing.T) {
	db := openBucketTestDB(t)
	userID := "u1"
	if err := GrantPoints(db, userID, 1000, nil, SourceAdjust); err != nil {
		t.Fatal(err)
	}
	if err := GrantPoints(db, userID, 100, nil, SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	result, err := ConsumePricedInTx(db, userID, 80, 9000)
	if err != nil {
		t.Fatal(err)
	}
	if result.ActualPoints != 80 || result.GrowthPoints != 0 || result.SavedPoints != 0 {
		t.Fatalf("adjust points should be consumed before paid topup without vip growth, got %+v", result)
	}
	if len(result.Allocations) != 1 || result.Allocations[0].Source != SourceAdjust {
		t.Fatalf("expected adjustment allocation first, got %+v", result.Allocations)
	}
}

func TestConsumePricedInTxPrioritizesGiftBeforePaidTopupBuckets(t *testing.T) {
	db := openBucketTestDB(t)
	userID := "u1"
	if err := GrantPoints(db, userID, 100, nil, SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	if err := GrantPoints(db, userID, 100, nil, SourceTopupGift); err != nil {
		t.Fatal(err)
	}
	result, err := ConsumePricedInTx(db, userID, 80, 9000)
	if err != nil {
		t.Fatal(err)
	}
	if result.ActualPoints != 80 || result.GrowthPoints != 0 || result.SavedPoints != 0 {
		t.Fatalf("gift points should be consumed before paid topup without vip growth, got %+v", result)
	}
	if len(result.Allocations) != 1 || result.Allocations[0].Source != SourceTopupGift {
		t.Fatalf("expected gift allocation first, got %+v", result.Allocations)
	}
}

func TestConsumePricedInTxTreatsLegacyTopupSourceAsPaidTopup(t *testing.T) {
	db := openBucketTestDB(t)
	userID := "u1"
	if err := GrantPoints(db, userID, 100, nil, SourceLegacyTopup); err != nil {
		t.Fatal(err)
	}
	result, err := ConsumePricedInTx(db, userID, 100, 9000)
	if err != nil {
		t.Fatal(err)
	}
	if result.ActualPoints != 90 || result.GrowthPoints != 90 || result.SavedPoints != 10 {
		t.Fatalf("legacy topup source should receive paid topup pricing, got %+v", result)
	}
}

func TestConsumePricedInTxDoesNotDiscountTemporaryOrGiftSources(t *testing.T) {
	db := openBucketTestDB(t)
	userID := "u1"
	exp := ptr(time.Now().Add(time.Hour))
	if err := GrantPoints(db, userID, 40, exp, SourceMembership); err != nil {
		t.Fatal(err)
	}
	if err := GrantPoints(db, userID, 60, nil, SourceTopupGift); err != nil {
		t.Fatal(err)
	}
	result, err := ConsumePricedInTx(db, userID, 100, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if result.ActualPoints != 100 || result.GrowthPoints != 0 || result.SavedPoints != 0 {
		t.Fatalf("non-paid sources should not discount: %+v", result)
	}
}

func TestConsumePricedInTxMixedSourcesUseSegmentedDiscount(t *testing.T) {
	db := openBucketTestDB(t)
	userID := "u1"
	exp := ptr(time.Now().Add(time.Hour))
	if err := GrantPoints(db, userID, 40, exp, SourceMembership); err != nil {
		t.Fatal(err)
	}
	if err := GrantPoints(db, userID, 100, nil, SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	result, err := ConsumePricedInTx(db, userID, 100, 9000)
	if err != nil {
		t.Fatal(err)
	}
	if result.ActualPoints != 94 || result.GrowthPoints != 54 || result.SavedPoints != 6 {
		t.Fatalf("bad mixed source pricing: %+v", result)
	}
}

func TestConsumePricedInTxRoundingIsAggregatedAcrossPaidBuckets(t *testing.T) {
	db := openBucketTestDB(t)
	userID := "u1"
	if err := GrantPoints(db, userID, 1, nil, SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	if err := GrantPoints(db, userID, 1, nil, SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	result, err := ConsumePricedInTx(db, userID, 2, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if result.ActualPoints != 1 || result.GrowthPoints != 1 || result.SavedPoints != 1 {
		t.Fatalf("rounding must be aggregated, got %+v", result)
	}
}

func TestTrimPricedAllocations(t *testing.T) {
	allocs := []Alloc{
		{BucketID: 1, OriginalAmount: 40, Source: SourceMembership, DiscountBps: 9000},
		{BucketID: 2, OriginalAmount: 60, Source: SourceTopupPaid, DiscountBps: 9000},
	}
	got := TrimPricedAllocations(allocs, 70)
	if got.OriginalPoints != 70 || got.ActualPoints != 67 || got.GrowthPoints != 27 || got.SavedPoints != 3 {
		t.Fatalf("trimmed result mismatch: %+v", got)
	}
	if len(got.Allocations) != 2 || got.Allocations[1].OriginalAmount != 30 || got.Allocations[1].Amount != 27 {
		t.Fatalf("trimmed allocations mismatch: %+v", got.Allocations)
	}
}

func TestConsumePricedInTxInsufficientRollsBack(t *testing.T) {
	db := openBucketTestDB(t)
	userID := "u1"
	if err := GrantPoints(db, userID, 10, nil, SourceMembership); err != nil {
		t.Fatal(err)
	}
	err := db.Transaction(func(tx *gorm.DB) error {
		_, err := ConsumePricedInTx(tx, userID, 20, 9000)
		return err
	})
	if err != ErrInsufficient {
		t.Fatalf("err=%v, want ErrInsufficient", err)
	}
	balance, err := Balance(db, userID)
	if err != nil {
		t.Fatal(err)
	}
	if balance != 10 {
		t.Fatalf("balance=%d, want 10", balance)
	}
}
