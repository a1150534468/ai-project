package vip

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yc-billing/internal/model"
)

func openSQLiteVIPTestDB(t *testing.T) *gorm.DB {
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
		&model.Account{},
		&model.PointBucket{},
		&model.VipLevel{},
		&model.UserVipState{},
		&model.VipGrowthLedger{},
	); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestReverseGrowthInTxReducesGrowthWithoutDowngrade(t *testing.T) {
	db := openSQLiteVIPTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.AddGrowthInTx(db, AddGrowthInput{
		OperationID:             "usage:reverse-base",
		UserID:                  "u-reverse",
		SourceType:              "usage",
		GrowthPoints:            10000,
		RelatedUsageOperationID: "reverse-op",
		OccurredAt:              time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	before, after, err := svc.ReverseGrowthInTx(db, ReverseGrowthInput{
		OperationID:             "refund:reverse-op",
		UserID:                  "u-reverse",
		SourceType:              "usage_refund",
		GrowthPoints:            90,
		RelatedUsageOperationID: "reverse-op",
		OccurredAt:              time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if before.GrowthPoints != 10000 || after.GrowthPoints != 9910 {
		t.Fatalf("before=%+v after=%+v", before, after)
	}
	if after.LevelName != "银卡会员" {
		t.Fatalf("after level=%s, want 银卡会员", after.LevelName)
	}
	var ledger model.VipGrowthLedger
	if err := db.First(&ledger, "operation_id = ?", "refund:reverse-op").Error; err != nil {
		t.Fatal(err)
	}
	if ledger.GrowthPoints != -90 || ledger.SourceType != "usage_refund" {
		t.Fatalf("ledger=%+v", ledger)
	}
}
