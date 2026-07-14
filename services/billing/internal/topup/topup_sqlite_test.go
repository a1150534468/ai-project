package topup

import (
	"fmt"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/resource"
	"ai-assistant-billing/internal/store"
)

func openTopupSQLiteStore(t *testing.T) *store.Store {
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
		&model.PlatformConfig{},
		&model.PointBucket{},
		&model.TopUp{},
	); err != nil {
		t.Fatal(err)
	}

	return &store.Store{DB: db}
}

func TestCreditByTradeNoSplitsPaidAndGiftBuckets_when_no_gift_points(t *testing.T) {
	// Given
	st := openTopupSQLiteStore(t)
	if err := resource.New(st).SetRechargeRatio(100); err != nil {
		t.Fatal(err)
	}
	svc := New(st)
	if err := svc.CreateOrder(&model.TopUp{
		TradeNo:   "t1",
		UserID:    "u1",
		AmountFen: 1900,
		Points:    1000,
		Provider:  "epay",
	}); err != nil {
		t.Fatal(err)
	}

	// When
	if err := svc.CreditByTradeNoWith("t1", "alipay", nil); err != nil {
		t.Fatal(err)
	}

	// Then
	var buckets []model.PointBucket
	if err := st.DB.Order("source asc").Find(&buckets, "user_id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 1 {
		t.Fatalf("bucket count=%d, want 1", len(buckets))
	}
	if buckets[0].Source != bucket.SourceTopupPaid || buckets[0].Remaining != 1000 {
		t.Fatalf("paid bucket mismatch: %+v", buckets[0])
	}
}

func TestCreditByTradeNoSplitsPaidAndGiftBuckets_when_order_has_gift_points(t *testing.T) {
	// Given
	st := openTopupSQLiteStore(t)
	if err := resource.New(st).SetRechargeRatio(100); err != nil {
		t.Fatal(err)
	}
	svc := New(st)
	if err := svc.CreateOrder(&model.TopUp{
		TradeNo:   "t2",
		UserID:    "u1",
		AmountFen: 1000,
		Points:    1200,
		Provider:  "epay",
	}); err != nil {
		t.Fatal(err)
	}

	// When
	if err := svc.CreditByTradeNoWith("t2", "alipay", nil); err != nil {
		t.Fatal(err)
	}

	// Then
	var buckets []model.PointBucket
	if err := st.DB.Order("source asc, id asc").Find(&buckets, "user_id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 2 {
		t.Fatalf("bucket count=%d, want 2", len(buckets))
	}
	if buckets[0].Source != bucket.SourceTopupGift || buckets[0].Remaining != 200 {
		t.Fatalf("gift bucket mismatch: %+v", buckets[0])
	}
	if buckets[1].Source != bucket.SourceTopupPaid || buckets[1].Remaining != 1000 {
		t.Fatalf("paid bucket mismatch: %+v", buckets[1])
	}
}
