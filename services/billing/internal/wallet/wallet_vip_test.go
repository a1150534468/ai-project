package wallet

import (
	"testing"
	"time"

	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/vip"
)

func seedVipLevels(t *testing.T, db *gorm.DB) {
	t.Helper()
	svc := vip.New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	_, _, err := svc.AddGrowthInTx(db, vip.AddGrowthInput{
		OperationID:  "seed-growth",
		UserID:       "u1",
		SourceType:   "test",
		GrowthPoints: 10000,
		OccurredAt:   time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestWalletReserveAndSettleRecordsVipSnapshot(t *testing.T) {
	st := openWalletTestStore(t)
	seedVipLevels(t, st.DB)
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	w := New(st)
	reserved, err := w.ReservePriced("op1", "u1", "chat", "GLM-5.2", 100)
	if err != nil {
		t.Fatal(err)
	}
	if reserved != 90 {
		t.Fatalf("reserved=%d, want 90", reserved)
	}
	if err := w.SettleWithTokens("op1", 80, TokenUsage{InputTokens: 100}); err != nil {
		t.Fatal(err)
	}
	var rec model.UsageRecord
	if err := st.DB.First(&rec, "operation_id = ?", "op1").Error; err != nil {
		t.Fatal(err)
	}
	if rec.OriginalPoints != 80 || rec.ActualPoints != 72 || rec.VipLevelName != "银卡会员" || rec.VipDiscountBps != 9000 || rec.VipSavedPoints != 8 || rec.VipGrowthPoints != 72 {
		t.Fatalf("bad usage record: %+v", rec)
	}
	var state model.UserVipState
	if err := st.DB.First(&state, "user_id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if state.GrowthPoints != 10072 {
		t.Fatalf("growth=%d, want 10072", state.GrowthPoints)
	}
}

func TestWalletSettleIsIdempotentForVipGrowth(t *testing.T) {
	st := openWalletTestStore(t)
	seedVipLevels(t, st.DB)
	if err := bucket.GrantPoints(st.DB, "u1", 1000, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	w := New(st)
	if _, err := w.ReservePriced("op1", "u1", "chat", "GLM-5.2", 100); err != nil {
		t.Fatal(err)
	}
	if err := w.SettleWithTokens("op1", 100, TokenUsage{}); err != nil {
		t.Fatal(err)
	}
	if err := w.SettleWithTokens("op1", 100, TokenUsage{}); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := st.DB.Model(&model.VipGrowthLedger{}).Where("operation_id = ?", "usage:op1").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("ledger count=%d, want 1", count)
	}
}

func TestWalletSettleChargesExtraPaidWithVipDiscount(t *testing.T) {
	st := openWalletTestStore(t)
	seedVipLevels(t, st.DB)
	if err := bucket.GrantPoints(st.DB, "u1", 200, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	w := New(st)
	if _, err := w.ReservePriced("op-extra", "u1", "chat", "GLM-5.2", 100); err != nil {
		t.Fatal(err)
	}
	if err := w.SettleWithTokens("op-extra", 120, TokenUsage{}); err != nil {
		t.Fatal(err)
	}
	var rec model.UsageRecord
	if err := st.DB.First(&rec, "operation_id = ?", "op-extra").Error; err != nil {
		t.Fatal(err)
	}
	if rec.OriginalPoints != 120 || rec.ActualPoints != 108 || rec.VipSavedPoints != 12 || rec.VipGrowthPoints != 108 {
		t.Fatalf("bad settled usage record: %+v", rec)
	}
	if balance := bal(st, "u1"); balance != 92 {
		t.Fatalf("balance=%d, want 92", balance)
	}
}
