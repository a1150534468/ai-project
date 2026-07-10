package store

import (
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"yc-billing/internal/model"
)

type Store struct{ DB *gorm.DB }

func Open(dsn string) (*Store, error) {
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		return nil, err
	}
	if err := db.AutoMigrate(&model.Account{}, &model.PriceRule{}, &model.UsageRecord{}, &model.TopUp{}, &model.Redemption{}, &model.Subscription{}, &model.BalanceAdjustment{}, &model.PointBucket{}, &model.VideoPointAccount{}, &model.ResourcePrice{}, &model.PlatformConfig{}, &model.VipLevel{}, &model.UserVipState{}, &model.VipGrowthLedger{}, &model.MembershipCard{}, &model.UserMembership{}, &model.MembershipGrant{}); err != nil {
		return nil, err
	}
	return &Store{DB: db}, nil
}
