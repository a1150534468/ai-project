package registry

import (
	"gorm.io/gorm"
	"yc-billing/internal/model"
	"yc-billing/internal/resource"
)

type MarketplaceMeta struct {
	Description          string
	CapabilityTags       string
	ContextWindow        int64
	MaxOutputTokens      int64
	UseCases             string
	MarketplaceSortOrder int
	ShowInMarketplace    bool
}

type MarketplaceMetaPatch struct {
	Description          *string
	CapabilityTags       *string
	ContextWindow        *int64
	MaxOutputTokens      *int64
	UseCases             *string
	MarketplaceSortOrder *int
	ShowInMarketplace    *bool
}

func (s *Service) UpdateMarketplace(modelName string, meta MarketplaceMeta) error {
	return s.UpdateMarketplaceFields(modelName, MarketplaceMetaPatch{
		Description:          &meta.Description,
		CapabilityTags:       &meta.CapabilityTags,
		ContextWindow:        &meta.ContextWindow,
		MaxOutputTokens:      &meta.MaxOutputTokens,
		UseCases:             &meta.UseCases,
		MarketplaceSortOrder: &meta.MarketplaceSortOrder,
		ShowInMarketplace:    &meta.ShowInMarketplace,
	})
}

func (s *Service) UpdateMarketplaceFields(modelName string, meta MarketplaceMetaPatch) error {
	updates := map[string]any{}
	if meta.Description != nil {
		updates["description"] = *meta.Description
	}
	if meta.CapabilityTags != nil {
		updates["capability_tags"] = *meta.CapabilityTags
	}
	if meta.ContextWindow != nil {
		updates["context_window"] = *meta.ContextWindow
	}
	if meta.MaxOutputTokens != nil {
		updates["max_output_tokens"] = *meta.MaxOutputTokens
	}
	if meta.UseCases != nil {
		updates["use_cases"] = *meta.UseCases
	}
	if meta.MarketplaceSortOrder != nil {
		updates["marketplace_sort_order"] = *meta.MarketplaceSortOrder
	}
	if meta.ShowInMarketplace != nil {
		updates["show_in_marketplace"] = *meta.ShowInMarketplace
	}
	if len(updates) == 0 {
		return nil
	}

	res := s.st.DB.Model(&model.PriceRule{}).Where("model = ?", modelName).Updates(updates)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (s *Service) ListMarketplace() ([]model.PriceRule, error) {
	var rows []model.PriceRule
	err := s.st.DB.Where("enabled = ? AND show_in_marketplace = ?", true, true).
		Order("marketplace_sort_order asc, model asc").
		Find(&rows).Error
	if err != nil {
		return rows, err
	}
	ratio := resource.New(s.st).RechargeRatio()
	for i := range rows {
		if normalizePriceRule(&rows[i], ratio) {
			if err := s.persistRMBPricing(rows[i]); err != nil {
				return nil, err
			}
		}
	}
	return rows, nil
}
