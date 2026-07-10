package vip

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"yc-billing/internal/model"
)

func (s *Service) Summary(userID string) (Summary, error) {
	trimmedUserID := trimField(userID)
	if trimmedUserID == "" {
		return Summary{}, ErrInvalidGrowthInput
	}
	var out Summary
	err := s.db.Transaction(func(tx *gorm.DB) error {
		var err error
		out, err = summaryInTx(tx, trimmedUserID, time.Now())
		return err
	})
	return out, err
}

func (s *Service) AddGrowthInTx(tx *gorm.DB, input AddGrowthInput) (Summary, Summary, error) {
	if tx == nil {
		return Summary{}, Summary{}, gorm.ErrInvalidDB
	}
	normalized, err := normalizeAddGrowthInput(input)
	if err != nil {
		return Summary{}, Summary{}, err
	}

	var before Summary
	var after Summary
	err = tx.Transaction(func(inner *gorm.DB) error {
		var innerErr error
		before, after, innerErr = addGrowth(inner, normalized)
		return innerErr
	})
	return before, after, err
}

func addGrowth(tx *gorm.DB, input AddGrowthInput) (Summary, Summary, error) {
	if err := lockGrowthOperation(tx, input.OperationID); err != nil {
		return Summary{}, Summary{}, err
	}
	before, err := summaryInTx(tx, input.UserID, input.OccurredAt)
	if err != nil {
		return Summary{}, Summary{}, err
	}
	if input.GrowthPoints == 0 {
		return before, before, nil
	}

	var ledger model.VipGrowthLedger
	err = tx.First(&ledger, "operation_id = ?", input.OperationID).Error
	if err == nil {
		after, summaryErr := summaryInTx(tx, input.UserID, input.OccurredAt)
		return before, after, summaryErr
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return Summary{}, Summary{}, err
	}

	state, err := stateForUpdate(tx, input.UserID, input.OccurredAt)
	if err != nil {
		return Summary{}, Summary{}, err
	}

	currentThreshold, err := levelThresholdByID(tx, state.VipLevelID)
	if err != nil {
		return Summary{}, Summary{}, err
	}

	state.GrowthPoints += input.GrowthPoints
	target, err := bestLevelForGrowth(tx, state.GrowthPoints, true)
	if err != nil {
		return Summary{}, Summary{}, err
	}
	if target.ID != 0 && target.ID != state.VipLevelID && target.ThresholdPoints >= currentThreshold {
		state.VipLevelID = target.ID
		state.UpgradedAt = input.OccurredAt
	}
	state.UpdatedAt = input.OccurredAt
	if err := tx.Save(&state).Error; err != nil {
		return Summary{}, Summary{}, err
	}

	after, err := summaryInTx(tx, input.UserID, input.OccurredAt)
	if err != nil {
		return Summary{}, Summary{}, err
	}

	ledger = model.VipGrowthLedger{
		OperationID:             input.OperationID,
		UserID:                  input.UserID,
		SourceType:              input.SourceType,
		GrowthPoints:            input.GrowthPoints,
		RelatedUsageOperationID: input.RelatedUsageOperationID,
		RelatedTradeNo:          input.RelatedTradeNo,
		VipLevelBefore:          before.LevelName,
		VipLevelAfter:           after.LevelName,
		Note:                    input.Note,
		CreatedAt:               input.OccurredAt,
	}
	if err := tx.Create(&ledger).Error; err != nil {
		return Summary{}, Summary{}, err
	}
	return before, after, nil
}

func normalizeAddGrowthInput(input AddGrowthInput) (AddGrowthInput, error) {
	input.OperationID = trimField(input.OperationID)
	input.UserID = trimField(input.UserID)
	input.SourceType = trimField(input.SourceType)
	if input.OperationID == "" || input.UserID == "" || input.SourceType == "" || input.GrowthPoints < 0 {
		return AddGrowthInput{}, ErrInvalidGrowthInput
	}
	if input.OccurredAt.IsZero() {
		input.OccurredAt = time.Now()
	}
	return input, nil
}
