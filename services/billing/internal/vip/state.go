package vip

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"ai-assistant-billing/internal/model"
)

func stateForUpdate(tx *gorm.DB, userID string, now time.Time) (model.UserVipState, error) {
	var state model.UserVipState
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&state, "user_id = ?", userID).Error
	if err == nil {
		return state, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return state, err
	}

	level, err := defaultLevelForNewUser(tx)
	if err != nil {
		return state, err
	}
	state = model.UserVipState{
		UserID:       userID,
		VipLevelID:   level.ID,
		GrowthPoints: 0,
		UpgradedAt:   now,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}},
		DoNothing: true,
	}).Create(&state).Error; err != nil {
		return model.UserVipState{}, err
	}
	err = tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&state, "user_id = ?", userID).Error
	return state, err
}

func defaultLevelForNewUser(tx *gorm.DB) (model.VipLevel, error) {
	var level model.VipLevel
	err := tx.Where("enabled = ? AND threshold_points = ?", true, 0).
		Order("sort_order asc, id asc").
		First(&level).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.VipLevel{}, ErrInvalidLevel
	}
	return level, err
}

func bestLevelForGrowth(tx *gorm.DB, growth int64, upgradeOnly bool) (model.VipLevel, error) {
	var level model.VipLevel
	q := tx.Where("enabled = ? AND threshold_points <= ?", true, growth)
	if upgradeOnly {
		q = q.Where("upgrade_enabled = ?", true)
	}
	err := q.Order("threshold_points desc, sort_order desc, id desc").First(&level).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.VipLevel{}, ErrInvalidLevel
	}
	return level, err
}

func summaryInTx(tx *gorm.DB, userID string, now time.Time) (Summary, error) {
	state, err := stateForUpdate(tx, userID, now)
	if err != nil {
		return Summary{}, err
	}

	var level model.VipLevel
	if err := tx.First(&level, "id = ?", state.VipLevelID).Error; err != nil {
		return Summary{}, err
	}

	var levels []model.VipLevel
	if err := tx.Where("enabled = ? AND upgrade_enabled = ?", true, true).
		Order("threshold_points asc, sort_order asc, id asc").
		Find(&levels).Error; err != nil {
		return Summary{}, err
	}

	out := Summary{
		UserID:             userID,
		LevelID:            level.ID,
		LevelName:          level.Name,
		DiscountBps:        level.DiscountBps,
		GrowthPoints:       state.GrowthPoints,
		HighestLevel:       true,
		UpgradedAtUnixNano: state.UpgradedAt.UnixNano(),
	}
	for _, next := range levels {
		if next.ThresholdPoints > state.GrowthPoints {
			nextID := next.ID
			out.NextLevelID = &nextID
			out.NextLevelName = next.Name
			out.NextThreshold = next.ThresholdPoints
			out.PointsToNextLevel = next.ThresholdPoints - state.GrowthPoints
			out.HighestLevel = false
			break
		}
	}
	return out, nil
}

func levelThresholdByID(tx *gorm.DB, id uint) (int64, error) {
	var level model.VipLevel
	if err := tx.First(&level, "id = ?", id).Error; err != nil {
		return 0, err
	}
	return level.ThresholdPoints, nil
}
