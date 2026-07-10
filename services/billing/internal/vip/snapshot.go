package vip

import (
	"errors"

	"gorm.io/gorm"
	"yc-billing/internal/model"
)

func (s *Service) SnapshotForPricingInTx(userID string) (Summary, error) {
	trimmedUserID := trimField(userID)
	if trimmedUserID == "" {
		return Summary{}, ErrInvalidUserID
	}
	return snapshotForPricingInTx(s.db, trimmedUserID)
}

func snapshotForPricingInTx(tx *gorm.DB, userID string) (Summary, error) {
	var state model.UserVipState
	err := tx.First(&state, "user_id = ?", userID).Error
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return Summary{}, err
		}
		return defaultSummaryForPricing(tx, userID)
	}

	var level model.VipLevel
	if err := tx.First(&level, "id = ?", state.VipLevelID).Error; err != nil {
		return Summary{}, err
	}
	return pricingSummaryFromLevel(userID, state, level), nil
}

func defaultSummaryForPricing(tx *gorm.DB, userID string) (Summary, error) {
	level, err := defaultLevelForNewUser(tx)
	if err != nil {
		return Summary{}, err
	}
	return Summary{
		UserID:      userID,
		LevelID:     level.ID,
		LevelName:   level.Name,
		DiscountBps: normalizeDiscountBps(level.DiscountBps),
	}, nil
}

func pricingSummaryFromLevel(userID string, state model.UserVipState, level model.VipLevel) Summary {
	return Summary{
		UserID:             userID,
		LevelID:            level.ID,
		LevelName:          level.Name,
		DiscountBps:        normalizeDiscountBps(level.DiscountBps),
		GrowthPoints:       state.GrowthPoints,
		UpgradedAtUnixNano: state.UpgradedAt.UnixNano(),
	}
}

func normalizeDiscountBps(discountBps int) int {
	if discountBps <= 0 {
		return DiscountFullBps
	}
	return discountBps
}
