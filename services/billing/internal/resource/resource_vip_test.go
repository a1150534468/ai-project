package resource

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/store"
	"yc-billing/internal/vip"
)

func openResourceSQLiteStore(t *testing.T) *store.Store {
	t.Helper()

	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)

	if err := db.AutoMigrate(
		&model.ResourcePrice{},
		&model.PlatformConfig{},
		&model.PointBucket{},
		&model.UsageRecord{},
		&model.VipLevel{},
		&model.UserVipState{},
		&model.VipGrowthLedger{},
	); err != nil {
		t.Fatal(err)
	}
	if err := vip.New(db).EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}

	return &store.Store{DB: db}
}

func seedResourceVIP(t *testing.T, db *gorm.DB, userID string) {
	t.Helper()

	if _, _, err := vip.New(db).AddGrowthInTx(db, vip.AddGrowthInput{
		OperationID:  "seed:" + userID,
		UserID:       userID,
		SourceType:   "test",
		GrowthPoints: 10000,
		OccurredAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestResourceChargeAppliesVipToPaidBuckets(t *testing.T) {
	// Given
	st := openResourceSQLiteStore(t)
	seedResourceVIP(t, st.DB, "u1")
	svc := New(st)
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "workflow_test",
		DisplayName: "Workflow Test",
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

	// When
	charged, err := svc.Charge("resource:vip:1", "u1", "workflow_test", 1)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if charged != 90 {
		t.Fatalf("charged=%d, want 90", charged)
	}

	var rec model.UsageRecord
	if err := st.DB.First(&rec, "operation_id = ?", "resource:vip:1").Error; err != nil {
		t.Fatal(err)
	}
	if rec.OriginalPoints != 100 || rec.ActualPoints != 90 || rec.VipGrowthPoints != 90 {
		t.Fatalf("bad resource record: %+v", rec)
	}
	if rec.VipLevelName != "银卡会员" || rec.VipDiscountBps != 9000 || rec.VipSavedPoints != 10 {
		t.Fatalf("bad vip snapshot: %+v", rec)
	}

	summary, err := vip.New(st.DB).Summary("u1")
	if err != nil {
		t.Fatal(err)
	}
	if summary.GrowthPoints != 10090 {
		t.Fatalf("growth=%d, want 10090", summary.GrowthPoints)
	}
}

func TestResourceRefundChargeReversesVipGrowthWithoutDowngrade(t *testing.T) {
	st := openResourceSQLiteStore(t)
	seedResourceVIP(t, st.DB, "u1")
	svc := New(st)
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "workflow_refund",
		DisplayName: "Workflow Refund",
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
	if _, err := svc.Charge("resource:refund:1", "u1", "workflow_refund", 1); err != nil {
		t.Fatal(err)
	}

	if err := svc.RefundCharge("resource:refund:1"); err != nil {
		t.Fatal(err)
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
	if summary.LevelName != "银卡会员" {
		t.Fatalf("level=%s, want 银卡会员", summary.LevelName)
	}

	var refundLedger model.VipGrowthLedger
	if err := st.DB.First(&refundLedger, "operation_id = ?", "refund:usage:resource:refund:1").Error; err != nil {
		t.Fatal(err)
	}
	if refundLedger.GrowthPoints != -90 || refundLedger.SourceType != "usage_refund" || refundLedger.RelatedUsageOperationID != "resource:refund:1" {
		t.Fatalf("refund ledger=%+v", refundLedger)
	}
}
