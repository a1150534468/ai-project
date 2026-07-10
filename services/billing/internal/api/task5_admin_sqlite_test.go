package api

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"yc-billing/internal/model"
	"yc-billing/internal/vip"
)

func TestAdminDeleteVipLevelReturnsConflictWhenOccupied(t *testing.T) {
	r, token, st := openTask5Handler(t)
	levels, err := vip.New(st.DB).ListLevels(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(levels) < 2 {
		t.Fatalf("levels=%d, want at least 2", len(levels))
	}
	now := time.Now()
	if err := st.DB.Create(&model.UserVipState{
		UserID:       "u1",
		VipLevelID:   levels[1].ID,
		GrowthPoints: 10000,
		UpgradedAt:   now,
		CreatedAt:    now,
		UpdatedAt:    now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/internal/admin/vip-levels/delete", bytes.NewBufferString(fmt.Sprintf(`{"id":%d}`, levels[1].ID)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminUpsertModelPersistsMarketplaceMeta(t *testing.T) {
	r, token, st := openTask5Handler(t)

	reqBody := `{
		"model":"meta-model",
		"displayName":"Meta Model",
		"enabled":true,
		"inputPricePerMillion":100,
		"outputPricePerMillion":200,
		"cacheInputPricePerMillion":10,
		"cacheOutputPricePerMillion":20,
		"description":"Best for chat",
		"tags":"chat,reasoning",
		"contextLength":64000,
		"useCases":"support",
		"sortOrder":3,
		"showInMarketplace":true
	}`
	req := httptest.NewRequest(http.MethodPost, "/internal/admin/models", bytes.NewBufferString(reqBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var row model.PriceRule
	if err := st.DB.First(&row, "model = ?", "meta-model").Error; err != nil {
		t.Fatal(err)
	}
	if row.Description != "Best for chat" || row.CapabilityTags != "chat,reasoning" || row.ContextWindow != 64000 || row.UseCases != "support" || row.MarketplaceSortOrder != 3 || !row.ShowInMarketplace {
		t.Fatalf("marketplace meta not persisted: %+v", row)
	}
}

func TestAdminUpdateModelDisplayPreservesMarketplaceMetaWhenOmitted(t *testing.T) {
	r, token, st := openTask5Handler(t)
	if err := st.DB.Create(&model.PriceRule{
		Model:                "display-model",
		DisplayName:          "Old",
		Enabled:              true,
		Description:          "keep desc",
		CapabilityTags:       "chat",
		ContextWindow:        128000,
		UseCases:             "support",
		MarketplaceSortOrder: 9,
		ShowInMarketplace:    true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/internal/admin/models/display", bytes.NewBufferString(`{
		"model":"display-model",
		"displayName":"New",
		"enabled":false
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var row model.PriceRule
	if err := st.DB.First(&row, "model = ?", "display-model").Error; err != nil {
		t.Fatal(err)
	}
	if row.DisplayName != "New" || row.Enabled {
		t.Fatalf("display fields not updated: %+v", row)
	}
	if row.Description != "keep desc" || row.CapabilityTags != "chat" || row.ContextWindow != 128000 || row.UseCases != "support" || row.MarketplaceSortOrder != 9 || !row.ShowInMarketplace {
		t.Fatalf("marketplace meta should be preserved: %+v", row)
	}
}

func TestAdminUpdateModelDisplayMergesPartialMarketplaceMeta(t *testing.T) {
	r, token, st := openTask5Handler(t)
	if err := st.DB.Create(&model.PriceRule{
		Model:                "partial-model",
		DisplayName:          "Partial",
		Enabled:              true,
		Description:          "old desc",
		CapabilityTags:       "chat,reasoning",
		ContextWindow:        64000,
		UseCases:             "support",
		MarketplaceSortOrder: 7,
		ShowInMarketplace:    true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/internal/admin/models/display", bytes.NewBufferString(`{
		"model":"partial-model",
		"displayName":"Partial",
		"enabled":true,
		"description":"new desc"
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var row model.PriceRule
	if err := st.DB.First(&row, "model = ?", "partial-model").Error; err != nil {
		t.Fatal(err)
	}
	if row.Description != "new desc" || row.CapabilityTags != "chat,reasoning" || row.ContextWindow != 64000 || row.UseCases != "support" || row.MarketplaceSortOrder != 7 || !row.ShowInMarketplace {
		t.Fatalf("partial marketplace update should merge: %+v", row)
	}

	req = httptest.NewRequest(http.MethodPatch, "/internal/admin/models/display", bytes.NewBufferString(`{
		"model":"partial-model",
		"displayName":"Partial",
		"enabled":true,
		"showInMarketplace":false
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", token)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if err := st.DB.First(&row, "model = ?", "partial-model").Error; err != nil {
		t.Fatal(err)
	}
	if row.Description != "new desc" || row.CapabilityTags != "chat,reasoning" || row.ContextWindow != 64000 || row.UseCases != "support" || row.MarketplaceSortOrder != 7 || row.ShowInMarketplace {
		t.Fatalf("explicit false should update without clearing other fields: %+v", row)
	}
}
