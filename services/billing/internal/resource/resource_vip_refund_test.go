package resource

import (
	"sync"
	"testing"

	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/vip"
)

func TestResourceRefundChargeIsIdempotent(t *testing.T) {
	st := openResourceSQLiteStore(t)
	seedResourceVIP(t, st.DB, "u1")
	svc := New(st)
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "workflow_refund_twice",
		DisplayName: "Workflow Refund Twice",
		PricingType: "PER_CALL",
		Rate:        100,
		PerUnits:    1,
		Enabled:     true,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Charge("resource:refund:2", "u1", "workflow_refund_twice", 1); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- svc.RefundCharge("resource:refund:2")
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}

	balance, err := bucket.Balance(st.DB, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if balance != 100 {
		t.Fatalf("balance=%d, want 100", balance)
	}

	summary, err := vip.New(st.DB).Summary("u1")
	if err != nil {
		t.Fatal(err)
	}
	if summary.GrowthPoints != 10000 {
		t.Fatalf("growth=%d, want 10000", summary.GrowthPoints)
	}

	var refundLedgerCount int64
	if err := st.DB.Model(&model.VipGrowthLedger{}).
		Where("operation_id = ?", "refund:usage:resource:refund:2").
		Count(&refundLedgerCount).Error; err != nil {
		t.Fatal(err)
	}
	if refundLedgerCount != 1 {
		t.Fatalf("refundLedgerCount=%d, want 1", refundLedgerCount)
	}
}

func TestResourceChargeReusesRefundedOperationConsistently(t *testing.T) {
	st := openResourceSQLiteStore(t)
	seedResourceVIP(t, st.DB, "u1")
	svc := New(st)
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "workflow_recharge",
		DisplayName: "Workflow Recharge",
		PricingType: "PER_CALL",
		Rate:        100,
		PerUnits:    1,
		Enabled:     true,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := bucket.GrantPoints(st.DB, "u1", 200, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}

	firstCharge, err := svc.Charge("resource:refund:3", "u1", "workflow_recharge", 1)
	if err != nil {
		t.Fatal(err)
	}
	if firstCharge != 90 {
		t.Fatalf("firstCharge=%d, want 90", firstCharge)
	}
	if err := svc.RefundCharge("resource:refund:3"); err != nil {
		t.Fatal(err)
	}

	secondCharge, err := svc.Charge("resource:refund:3", "u1", "workflow_recharge", 1)
	if err != nil {
		t.Fatal(err)
	}
	if secondCharge != 90 {
		t.Fatalf("secondCharge=%d, want 90", secondCharge)
	}

	balance, err := bucket.Balance(st.DB, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if balance != 110 {
		t.Fatalf("balance=%d, want 110", balance)
	}

	summary, err := vip.New(st.DB).Summary("u1")
	if err != nil {
		t.Fatal(err)
	}
	if summary.GrowthPoints != 10090 {
		t.Fatalf("growth=%d, want 10090", summary.GrowthPoints)
	}

	var usage model.UsageRecord
	if err := st.DB.First(&usage, "operation_id = ?", "resource:refund:3").Error; err != nil {
		t.Fatal(err)
	}
	if usage.Status != "settled" || usage.ActualPoints != 90 || usage.VipGrowthPoints != 90 {
		t.Fatalf("usage=%+v", usage)
	}

	var positiveLedgerCount int64
	if err := st.DB.Model(&model.VipGrowthLedger{}).
		Where("user_id = ? AND related_usage_operation_id = ? AND growth_points > 0", "u1", "resource:refund:3").
		Count(&positiveLedgerCount).Error; err != nil {
		t.Fatal(err)
	}
	if positiveLedgerCount != 2 {
		t.Fatalf("positiveLedgerCount=%d, want 2", positiveLedgerCount)
	}

	if err := svc.RefundCharge("resource:refund:3"); err != nil {
		t.Fatal(err)
	}

	balance, err = bucket.Balance(st.DB, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if balance != 200 {
		t.Fatalf("balance=%d, want 200", balance)
	}

	summary, err = vip.New(st.DB).Summary("u1")
	if err != nil {
		t.Fatal(err)
	}
	if summary.GrowthPoints != 10000 {
		t.Fatalf("growth=%d, want 10000", summary.GrowthPoints)
	}

	var refundLedgerCount int64
	if err := st.DB.Model(&model.VipGrowthLedger{}).
		Where("user_id = ? AND related_usage_operation_id = ? AND growth_points < 0", "u1", "resource:refund:3").
		Count(&refundLedgerCount).Error; err != nil {
		t.Fatal(err)
	}
	if refundLedgerCount != 2 {
		t.Fatalf("refundLedgerCount=%d, want 2", refundLedgerCount)
	}
}
