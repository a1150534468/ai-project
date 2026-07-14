package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/resource"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/vip"
)

func openTask5APISQLiteStore(t *testing.T) *store.Store {
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
		&model.UsageRecord{},
		&model.PriceRule{},
		&model.ResourcePrice{},
		&model.PlatformConfig{},
		&model.VipLevel{},
		&model.UserVipState{},
		&model.VipGrowthLedger{},
	); err != nil {
		t.Fatal(err)
	}

	st := &store.Store{DB: db}
	if err := resource.New(st).SetRechargeRatio(100); err != nil {
		t.Fatal(err)
	}
	if err := vip.New(db).EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	return st
}

func openTask5Handler(t *testing.T) (*gin.Engine, string, *store.Store) {
	t.Helper()

	gin.SetMode(gin.TestMode)
	st := openTask5APISQLiteStore(t)
	token := "task5-token"
	r := gin.New()
	New(st, token, nil).Register(r)
	return r, token, st
}

func seedVIPGrowth(t *testing.T, db *gorm.DB, userID, opID string, growth int64) {
	t.Helper()

	if _, _, err := vip.New(db).AddGrowthInTx(db, vip.AddGrowthInput{
		OperationID:             opID,
		UserID:                  userID,
		SourceType:              "test",
		GrowthPoints:            growth,
		RelatedUsageOperationID: opID,
		OccurredAt:              time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestModelMarketplaceOnlyReturnsEnabledVisibleModels(t *testing.T) {
	r, token, st := openTask5Handler(t)
	seedVIPGrowth(t, st.DB, "u1", "seed:marketplace", 10000)

	rows := []map[string]any{
		{
			"model":                          "visible",
			"display_name":                   "Visible",
			"model_ratio":                    0,
			"completion_ratio":               0,
			"enabled":                        true,
			"show_in_marketplace":            true,
			"marketplace_sort_order":         10,
			"description":                    "desc",
			"capability_tags":                "tag-a,tag-b",
			"context_window":                 32000,
			"use_cases":                      "chat",
			"input_price_per_million":        100,
			"output_price_per_million":       200,
			"cache_input_price_per_million":  50,
			"cache_output_price_per_million": 80,
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

	req := httptest.NewRequest(http.MethodGet, "/model-marketplace/u1", nil)
	req.Header.Set("X-Internal-Token", token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var body struct {
		Data []struct {
			Model             string `json:"model"`
			ShowInMarketplace bool   `json:"showInMarketplace"`
			Tags              string `json:"tags"`
			ContextLength     int64  `json:"contextLength"`
			SortOrder         int    `json:"sortOrder"`
			VipInputPrice     struct {
				Original   float64 `json:"original"`
				Discounted int64   `json:"discounted"`
			} `json:"vipInputPrice"`
		} `json:"data"`
		Vip struct {
			LevelName   string `json:"levelName"`
			DiscountBps int    `json:"discountBps"`
		} `json:"vip"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Data) != 1 || body.Data[0].Model != "visible" || !body.Data[0].ShowInMarketplace {
		t.Fatalf("unexpected marketplace data: %+v", body.Data)
	}
	if body.Data[0].Tags != "tag-a,tag-b" || body.Data[0].ContextLength != 32000 || body.Data[0].SortOrder != 10 {
		t.Fatalf("unexpected marketplace meta: %+v", body.Data[0])
	}
	if body.Data[0].VipInputPrice.Discounted != 90 {
		t.Fatalf("discounted input price=%d, want 90", body.Data[0].VipInputPrice.Discounted)
	}
	if body.Vip.LevelName != "银卡会员" || body.Vip.DiscountBps != 9000 {
		t.Fatalf("unexpected vip payload: %+v", body.Vip)
	}
}

func TestUsageEndpointIncludesVipFields(t *testing.T) {
	r, token, st := openTask5Handler(t)
	now := time.Now()
	if err := st.DB.Create(&model.PriceRule{
		Model:       "glm-test",
		DisplayName: "GLM Test",
		Enabled:     true,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := st.DB.Create(&model.UsageRecord{
		OperationID:     "usage-task5",
		UserID:          "u1",
		Type:            "chat",
		Model:           "glm-test",
		Status:          "settled",
		ReservedPoints:  110,
		ActualPoints:    90,
		OriginalPoints:  100,
		VipLevelName:    "银卡会员",
		VipDiscountBps:  9000,
		VipSavedPoints:  10,
		VipGrowthPoints: 90,
		CreatedAt:       now,
		SettledAt:       &now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/usage/u1", nil)
	req.Header.Set("X-Internal-Token", token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var body struct {
		Data []struct {
			OperationID     string `json:"operationId"`
			OriginalPoints  int64  `json:"originalPoints"`
			VipLevelName    string `json:"vipLevelName"`
			VipDiscountBps  int    `json:"vipDiscountBps"`
			VipSavedPoints  int64  `json:"vipSavedPoints"`
			VipGrowthPoints int64  `json:"vipGrowthPoints"`
			ActualPoints    int64  `json:"actualPoints"`
			ReservedPoints  int64  `json:"reservedPoints"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Data) != 1 {
		t.Fatalf("usage rows=%d, want 1", len(body.Data))
	}
	row := body.Data[0]
	if row.OriginalPoints != 100 || row.VipLevelName != "银卡会员" || row.VipDiscountBps != 9000 || row.VipSavedPoints != 10 || row.VipGrowthPoints != 90 || row.ActualPoints != 90 {
		t.Fatalf("unexpected usage row: %+v", row)
	}
}
