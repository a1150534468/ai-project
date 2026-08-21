package store

import (
	"os"
	"strconv"
	"time"

	"ai-assistant-billing/internal/model"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Store struct{ DB *gorm.DB }

func envPositiveInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func Open(dsn string) (*Store, error) {
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(envPositiveInt("BILLING_DB_MAX_OPEN_CONNS", 5))
	sqlDB.SetMaxIdleConns(envPositiveInt("BILLING_DB_MAX_IDLE_CONNS", 2))
	sqlDB.SetConnMaxIdleTime(5 * time.Minute)
	sqlDB.SetConnMaxLifetime(30 * time.Minute)
	if err := db.AutoMigrate(&model.Account{}, &model.PriceRule{}, &model.UsageRecord{}, &model.TopUp{}, &model.Redemption{}, &model.Subscription{}, &model.BalanceAdjustment{}, &model.PointBucket{}, &model.VideoPointAccount{}, &model.ResourcePrice{}, &model.PlatformConfig{}, &model.VipLevel{}, &model.UserVipState{}, &model.VipGrowthLedger{}, &model.MembershipCard{}, &model.UserMembership{}, &model.MembershipGrant{}); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	return &Store{DB: db}, nil
}
