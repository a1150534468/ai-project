package wallet

import (
	"errors"
	"sync"
	"testing"

	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/vip"
)

func TestWalletReservePricedReturnsExistingReservationForConcurrentOperationID(t *testing.T) {
	st := openWalletTestStore(t)
	seedVipLevels(t, st.DB)
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	w := New(st)
	results := make(chan int64, 2)
	errCh := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			reserved, err := w.ReservePriced("same-op", "u1", "chat", "GLM-5.2", 100)
			if err != nil {
				errCh <- err
				return
			}
			results <- reserved
		}()
	}
	wg.Wait()
	close(results)
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	for reserved := range results {
		if reserved != 90 {
			t.Fatalf("reserved=%d, want 90", reserved)
		}
	}
	var count int64
	if err := st.DB.Model(&model.UsageRecord{}).Where("operation_id = ?", "same-op").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("usage record count=%d, want 1", count)
	}
	if balance := bal(st, "u1"); balance != 10 {
		t.Fatalf("balance=%d, want 10", balance)
	}
}

func TestWalletConcurrentSettleDoesNotDoubleRefundOrGrowth(t *testing.T) {
	st := openWalletTestStore(t)
	seedVipLevels(t, st.DB)
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	w := New(st)
	if _, err := w.ReservePriced("op-concurrent-settle", "u1", "chat", "GLM-5.2", 100); err != nil {
		t.Fatal(err)
	}
	errCh := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- w.SettleWithTokens("op-concurrent-settle", 80, TokenUsage{})
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	if balance := bal(st, "u1"); balance != 28 {
		t.Fatalf("balance=%d, want 28", balance)
	}
	var count int64
	if err := st.DB.Model(&model.VipGrowthLedger{}).Where("operation_id = ?", "usage:op-concurrent-settle").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("ledger count=%d, want 1", count)
	}
	var state model.UserVipState
	if err := st.DB.First(&state, "user_id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if state.GrowthPoints != 10072 {
		t.Fatalf("growth=%d, want 10072", state.GrowthPoints)
	}
}

func TestWalletSettleExtraInsufficientStillSettlesAndCapsGrowth(t *testing.T) {
	st := openWalletTestStore(t)
	seedVipLevels(t, st.DB)
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	w := New(st)
	if _, err := w.ReservePriced("op-best-effort-extra", "u1", "chat", "GLM-5.2", 100); err != nil {
		t.Fatal(err)
	}
	if err := w.SettleWithTokens("op-best-effort-extra", 120, TokenUsage{}); err != nil {
		t.Fatal(err)
	}
	var rec model.UsageRecord
	if err := st.DB.First(&rec, "operation_id = ?", "op-best-effort-extra").Error; err != nil {
		t.Fatal(err)
	}
	if rec.OriginalPoints != 120 || rec.ActualPoints != 100 || rec.VipSavedPoints != 11 || rec.VipGrowthPoints != 100 {
		t.Fatalf("bad usage record: %+v", rec)
	}
	if balance := bal(st, "u1"); balance != 0 {
		t.Fatalf("balance=%d, want 0", balance)
	}
	var state model.UserVipState
	if err := st.DB.First(&state, "user_id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if state.GrowthPoints != 10100 {
		t.Fatalf("growth=%d, want 10100", state.GrowthPoints)
	}
}

func TestWalletReservePricedRejectsBlankUserID(t *testing.T) {
	st := openWalletTestStore(t)
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	w := New(st)
	_, err := w.ReservePriced("blank-user", "   ", "chat", "GLM-5.2", 50)
	if !errors.Is(err, vip.ErrInvalidUserID) {
		t.Fatalf("err=%v, want vip.ErrInvalidUserID", err)
	}
	var count int64
	if err := st.DB.Model(&model.UsageRecord{}).Where("operation_id = ?", "blank-user").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("usage record count=%d, want 0", count)
	}
}

func TestWalletReservePricedFailsWithoutDefaultVIPLevels(t *testing.T) {
	st := openWalletTestStoreWithoutVIPSeed(t)
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	w := New(st)
	_, err := w.ReservePriced("missing-default", "u1", "chat", "GLM-5.2", 50)
	if !errors.Is(err, vip.ErrInvalidLevel) {
		t.Fatalf("err=%v, want vip.ErrInvalidLevel", err)
	}
	var count int64
	if err := st.DB.Model(&model.UsageRecord{}).Where("operation_id = ?", "missing-default").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("usage record count=%d, want 0", count)
	}
}
