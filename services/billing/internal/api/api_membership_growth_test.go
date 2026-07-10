package api

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yc-billing/internal/model"
	"yc-billing/internal/store"
	"yc-billing/internal/vip"
)

func openAPISQLiteStore(t *testing.T) *store.Store {
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
		&model.MembershipCard{},
		&model.UserMembership{},
		&model.MembershipGrant{},
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

func TestActivateMembershipOrderAddsPaymentGrowth(t *testing.T) {
	// Given
	st := openAPISQLiteStore(t)
	h := New(st, "token", nil)
	now := time.Now()
	if err := h.resource.SetRechargeRatio(100); err != nil {
		t.Fatal(err)
	}
	card := model.MembershipCard{
		Name:         "月卡",
		PriceFen:     3000,
		DurationDays: 30,
		Cadence:      "DAILY",
		GrantPoints:  500,
		Enabled:      true,
	}
	if err := st.DB.Create(&card).Error; err != nil {
		t.Fatal(err)
	}
	order := &model.TopUp{
		TradeNo:   "trade-1",
		UserID:    "u1",
		AmountFen: 3000,
		Points:    0,
		Provider:  "epay",
		Kind:      "membership",
		CardID:    card.ID,
	}

	// When
	err := st.DB.Transaction(func(tx *gorm.DB) error {
		return h.activateMembershipOrderInTx(tx, order, now)
	})

	// Then
	if err != nil {
		t.Fatal(err)
	}

	var ledger model.VipGrowthLedger
	if err := st.DB.First(&ledger, "operation_id = ?", "membership:trade-1").Error; err != nil {
		t.Fatal(err)
	}
	if ledger.GrowthPoints != 3000 || ledger.SourceType != "membership_purchase" || ledger.RelatedTradeNo != "trade-1" {
		t.Fatalf("ledger=%+v", ledger)
	}

	var bucket model.PointBucket
	if err := st.DB.First(&bucket, "user_id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if bucket.Source != "membership" || bucket.Remaining != 500 {
		t.Fatalf("bucket=%+v", bucket)
	}

	summary, err := vip.New(st.DB).Summary("u1")
	if err != nil {
		t.Fatal(err)
	}
	if summary.GrowthPoints != 3000 {
		t.Fatalf("growth=%d, want 3000", summary.GrowthPoints)
	}
}
