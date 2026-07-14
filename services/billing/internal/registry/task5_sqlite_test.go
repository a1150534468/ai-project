package registry

import (
	"fmt"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/resource"
	"ai-assistant-billing/internal/store"
)

func openTask5RegistrySQLiteStore(t *testing.T) *store.Store {
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

	if err := db.AutoMigrate(&model.PriceRule{}, &model.PlatformConfig{}); err != nil {
		t.Fatal(err)
	}

	st := &store.Store{DB: db}
	if err := resource.New(st).SetRechargeRatio(100); err != nil {
		t.Fatal(err)
	}
	return st
}

func TestListMarketplaceFiltersVisibleEnabledAndSorts(t *testing.T) {
	st := openTask5RegistrySQLiteStore(t)
	svc := New(st)
	rows := []map[string]any{
		{
			"model":                   "visible-b",
			"display_name":            "Visible B",
			"model_ratio":             0,
			"completion_ratio":        0,
			"enabled":                 true,
			"show_in_marketplace":     true,
			"marketplace_sort_order":  20,
			"input_price_per_million": 100,
		},
		{
			"model":                   "visible-a",
			"display_name":            "Visible A",
			"model_ratio":             0,
			"completion_ratio":        0,
			"enabled":                 true,
			"show_in_marketplace":     true,
			"marketplace_sort_order":  10,
			"input_price_per_million": 200,
		},
		{
			"model":               "hidden",
			"display_name":        "Hidden",
			"model_ratio":         0,
			"completion_ratio":    0,
			"enabled":             true,
			"show_in_marketplace": false,
		},
		{
			"model":               "disabled",
			"display_name":        "Disabled",
			"model_ratio":         0,
			"completion_ratio":    0,
			"enabled":             false,
			"show_in_marketplace": true,
		},
	}
	for _, row := range rows {
		if err := st.DB.Model(&model.PriceRule{}).Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}

	got, err := svc.ListMarketplace()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("rows=%d, want 2", len(got))
	}
	if got[0].Model != "visible-a" || got[1].Model != "visible-b" {
		t.Fatalf("unexpected order: %+v", got)
	}
}

func TestUpdateMarketplacePersistsMetadata(t *testing.T) {
	st := openTask5RegistrySQLiteStore(t)
	svc := New(st)
	if err := st.DB.Create(&model.PriceRule{
		Model:       "meta-model",
		DisplayName: "Meta Model",
		Enabled:     true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	err := svc.UpdateMarketplace("meta-model", MarketplaceMeta{
		Description:          "Best for chat",
		CapabilityTags:       "chat,reasoning",
		ContextWindow:        128000,
		UseCases:             "support",
		MarketplaceSortOrder: 5,
		ShowInMarketplace:    true,
	})
	if err != nil {
		t.Fatal(err)
	}

	var row model.PriceRule
	if err := st.DB.First(&row, "model = ?", "meta-model").Error; err != nil {
		t.Fatal(err)
	}
	if row.Description != "Best for chat" || row.CapabilityTags != "chat,reasoning" || row.ContextWindow != 128000 || row.UseCases != "support" || row.MarketplaceSortOrder != 5 || !row.ShowInMarketplace {
		t.Fatalf("unexpected row: %+v", row)
	}
}

func TestUpdateMarketplaceFieldsMergesProvidedFields(t *testing.T) {
	st := openTask5RegistrySQLiteStore(t)
	svc := New(st)
	if err := st.DB.Create(&model.PriceRule{
		Model:                "patch-model",
		DisplayName:          "Patch Model",
		Enabled:              true,
		Description:          "old desc",
		CapabilityTags:       "chat",
		ContextWindow:        32000,
		UseCases:             "support",
		MarketplaceSortOrder: 4,
		ShowInMarketplace:    true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	desc := "new desc"
	if err := svc.UpdateMarketplaceFields("patch-model", MarketplaceMetaPatch{Description: &desc}); err != nil {
		t.Fatal(err)
	}

	var row model.PriceRule
	if err := st.DB.First(&row, "model = ?", "patch-model").Error; err != nil {
		t.Fatal(err)
	}
	if row.Description != "new desc" || row.CapabilityTags != "chat" || row.ContextWindow != 32000 || row.UseCases != "support" || row.MarketplaceSortOrder != 4 || !row.ShowInMarketplace {
		t.Fatalf("partial update should preserve unspecified fields: %+v", row)
	}

	visible := false
	if err := svc.UpdateMarketplaceFields("patch-model", MarketplaceMetaPatch{ShowInMarketplace: &visible}); err != nil {
		t.Fatal(err)
	}
	if err := st.DB.First(&row, "model = ?", "patch-model").Error; err != nil {
		t.Fatal(err)
	}
	if row.Description != "new desc" || row.CapabilityTags != "chat" || row.ContextWindow != 32000 || row.ShowInMarketplace {
		t.Fatalf("explicit false should update without clearing other fields: %+v", row)
	}
}
