package vip

import (
	"gorm.io/gorm"
	"ai-assistant-billing/internal/model"
)

func DiscountedPoints(original int64, discountBps int) int64 {
	if original <= 0 {
		return 0
	}
	if discountBps <= 0 {
		return 1
	}
	discounted := (original*int64(discountBps) + DiscountFullBps - 1) / DiscountFullBps
	if discounted < 1 {
		return 1
	}
	return discounted
}

func (s *Service) EnsureDefaultLevels(rechargeRatio int64) error {
	if rechargeRatio <= 0 {
		rechargeRatio = 100
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := lockDefaultSeed(tx); err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&model.VipLevel{}).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return validateLevels(tx)
		}
		for i, row := range defaultLevels {
			level := model.VipLevel{
				Name:               row.name,
				SortOrder:          (i + 1) * 10,
				ThresholdRMBFen:    row.thresholdFen,
				ThresholdPoints:    row.thresholdFen * rechargeRatio / 100,
				SavedRechargeRatio: rechargeRatio,
				DiscountBps:        row.discountBps,
				Enabled:            true,
				UpgradeEnabled:     true,
			}
			if err := tx.Create(&level).Error; err != nil {
				return err
			}
		}
		return validateLevels(tx)
	})
}

func (s *Service) ListLevels(enabledOnly bool) ([]model.VipLevel, error) {
	var rows []model.VipLevel
	q := s.db.Model(&model.VipLevel{}).Order("sort_order asc, id asc")
	if enabledOnly {
		q = q.Where("enabled = ?", true)
	}
	return rows, q.Find(&rows).Error
}

func (s *Service) UpsertLevel(input UpsertLevelInput) (model.VipLevel, error) {
	name := trimField(input.Name)
	if name == "" || input.ThresholdRMBFen < 0 || input.RechargeRatio <= 0 || input.DiscountBps <= 0 || input.DiscountBps > DiscountFullBps {
		return model.VipLevel{}, ErrInvalidLevel
	}

	var row model.VipLevel
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if input.ID != 0 {
			if err := tx.First(&row, "id = ?", input.ID).Error; err != nil {
				return err
			}
		}
		row.Name = name
		row.SortOrder = input.SortOrder
		row.ThresholdRMBFen = input.ThresholdRMBFen
		row.ThresholdPoints = input.ThresholdRMBFen * input.RechargeRatio / 100
		row.SavedRechargeRatio = input.RechargeRatio
		row.DiscountBps = input.DiscountBps
		row.Enabled = input.Enabled
		row.UpgradeEnabled = input.UpgradeEnabled
		if input.ID == 0 {
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		} else {
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
		}
		// 规避 GORM default:true 陷阱：布尔零值(false)在 Create 时会被当作"未设置"而落库为默认 true，
		// 导致无法停用等级或关闭升级。显式回写这两列，且必须在 validateLevels 之前生效。
		if err := tx.Model(&model.VipLevel{}).Where("id = ?", row.ID).
			Updates(map[string]any{"enabled": input.Enabled, "upgrade_enabled": input.UpgradeEnabled}).Error; err != nil {
			return err
		}
		return validateLevels(tx)
	})
	return row, err
}

func (s *Service) DeleteLevel(id uint) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.UserVipState{}).Where("vip_level_id = ?", id).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrLevelOccupied
		}
		result := tx.Delete(&model.VipLevel{}, "id = ?", id)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return validateLevels(tx)
	})
}

func validateLevels(tx *gorm.DB) error {
	var rows []model.VipLevel
	if err := tx.Where("enabled = ?", true).Order("sort_order asc, id asc").Find(&rows).Error; err != nil {
		return err
	}
	if len(rows) == 0 {
		return ErrInvalidLevel
	}

	defaultCount := 0
	lastThreshold := int64(-1)
	for _, row := range rows {
		if row.DiscountBps <= 0 || row.DiscountBps > DiscountFullBps {
			return ErrInvalidLevel
		}
		if row.ThresholdPoints < lastThreshold {
			return ErrInvalidLevel
		}
		if row.ThresholdPoints == 0 {
			defaultCount++
		}
		lastThreshold = row.ThresholdPoints
	}
	if defaultCount != 1 {
		return ErrInvalidLevel
	}
	return nil
}
