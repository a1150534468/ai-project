package registry

import (
	"testing"

	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/pgtest"
	"ai-assistant-billing/internal/store"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func newStore(t *testing.T) *store.Store {
	dsn := pgtest.DSN()
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Skipf("billing-postgres 不可用: %v", err)
	}
	if err := db.AutoMigrate(&model.PriceRule{}); err != nil {
		t.Fatalf("migrate price_rules: %v", err)
	}
	pgtest.Serialize(t, db)
	db.Exec("TRUNCATE price_rules CASCADE")
	return &store.Store{DB: db}
}

func TestSeedDefaultIdempotent(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := s.SeedDefault(); err != nil {
		t.Fatalf("seed1: %v", err)
	}
	// 运营改了倍率
	st.DB.Model(&model.PriceRule{}).Where("model = ?", "qwen3.7-plus").Update("model_ratio", 9.9)
	if err := s.SeedDefault(); err != nil { // 二次 seed 不得覆盖
		t.Fatalf("seed2: %v", err)
	}
	var pr model.PriceRule
	st.DB.First(&pr, "model = ?", "qwen3.7-plus")
	if pr.ModelRatio != 9.9 {
		t.Fatalf("seed must not overwrite operator value, got %v", pr.ModelRatio)
	}
}

func TestSeedDefaultPopulatesPerMillionPrices(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := s.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var bailian model.PriceRule
	if err := st.DB.First(&bailian, "model = ?", "qwen3.7-plus").Error; err != nil {
		t.Fatalf("find bailian model: %v", err)
	}
	if bailian.InputPriceRMBPerMillion != 2 || bailian.OutputPriceRMBPerMillion != 8 || bailian.CacheInputPriceRMBPerMillion != 0.4 {
		t.Fatalf("bailian seed must preserve official RMB list prices, got %+v", bailian)
	}
	if !bailian.ShowInMarketplace || bailian.MarketplaceSortOrder != 10 || bailian.Description == "" {
		t.Fatalf("bailian seed must expose marketplace metadata, got %+v", bailian)
	}
}

func TestSeedDefaultExposesOnlyChatModels(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := s.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}

	enabled, err := s.ListEnabled()
	if err != nil {
		t.Fatalf("listEnabled: %v", err)
	}

	seen := map[string]bool{}
	for _, e := range enabled {
		seen[e.Model] = true
	}
	if !seen["qwen3.7-plus"] {
		t.Fatal("bailian default chat model must be enabled")
	}
	if len(seen) != 24 {
		t.Fatalf("chat model list must contain 17 Bailian and 7 AI Pixel models, got %d: %+v", len(seen), seen)
	}
	if seen["GLM-5.2"] {
		t.Fatal("legacy uppercase alias must not appear in the chat model list")
	}
	if seen["qwen3.7-max-preview"] || seen["qwen3.7-max-2026-05-17"] {
		t.Fatal("OpenAI-only preview models must not appear in the Anthropic chat model list")
	}
	if seen["text-embedding-v4"] {
		t.Fatal("embedding model must not appear in chat model list")
	}
	for _, modelName := range []string{
		"codex-auto-review", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5",
		"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
	} {
		if !seen[modelName] {
			t.Fatalf("selected AI Pixel model missing from chat list: %s", modelName)
		}
	}

	var embedding model.PriceRule
	if err := st.DB.First(&embedding, "model = ?", "text-embedding-v4").Error; err != nil {
		t.Fatalf("embedding price rule missing: %v", err)
	}
	if !embedding.Enabled || embedding.CompletionRatio != 0 {
		t.Fatalf("embedding price rule must stay enabled for kb pricing with zero completion ratio, got %+v", embedding)
	}
}

func TestSeedDefaultBackfillsOldBailianMarketplaceMetadataOnce(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := s.UpsertRMB("qwen3.7-plus", "Operator Name", RMBPricing{
		InputPriceRMBPerMillion: 3, OutputPriceRMBPerMillion: 9,
	}, true); err != nil {
		t.Fatalf("old seed: %v", err)
	}
	if err := s.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}

	var row model.PriceRule
	if err := st.DB.First(&row, "model = ?", "qwen3.7-plus").Error; err != nil {
		t.Fatalf("find: %v", err)
	}
	if !row.ShowInMarketplace || row.Description == "" || row.MarketplaceSortOrder != 10 {
		t.Fatalf("old seed metadata was not backfilled: %+v", row)
	}
	if row.DisplayName != "Operator Name" || row.InputPriceRMBPerMillion != 3 || row.OutputPriceRMBPerMillion != 9 {
		t.Fatalf("metadata backfill must preserve operator display and pricing: %+v", row)
	}

	if err := s.UpdateMarketplace("qwen3.7-plus", MarketplaceMeta{
		Description: "Operator description", CapabilityTags: "chat", UseCases: "Operator use case",
		MarketplaceSortOrder: 99, ShowInMarketplace: false,
	}); err != nil {
		t.Fatalf("operator metadata: %v", err)
	}
	if err := s.SeedDefault(); err != nil {
		t.Fatalf("seed2: %v", err)
	}
	if err := st.DB.First(&row, "model = ?", "qwen3.7-plus").Error; err != nil {
		t.Fatalf("find2: %v", err)
	}
	if row.ShowInMarketplace || row.Description != "Operator description" || row.MarketplaceSortOrder != 99 {
		t.Fatalf("second seed must preserve operator marketplace metadata: %+v", row)
	}
}

func TestUpsertAndUpdates(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := s.Upsert("m1", "Model One", TokenPricing{
		InputPricePerMillion: 10, OutputPricePerMillion: 20,
		CacheInputPricePerMillion: 3, CacheOutputPricePerMillion: 4,
	}, true); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := s.UpdatePricing("m1", TokenPricing{
		InputPricePerMillion: 11, OutputPricePerMillion: 22,
		CacheInputPricePerMillion: 5, CacheOutputPricePerMillion: 6,
	}); err != nil {
		t.Fatalf("pricing: %v", err)
	}
	if err := s.UpdateDisplay("m1", "Model 1", false); err != nil {
		t.Fatalf("display: %v", err)
	}
	var pr model.PriceRule
	st.DB.First(&pr, "model = ?", "m1")
	if pr.InputPricePerMillion != 11 || pr.OutputPricePerMillion != 22 ||
		pr.CacheInputPricePerMillion != 5 || pr.CacheOutputPricePerMillion != 6 ||
		pr.DisplayName != "Model 1" || pr.Enabled {
		t.Fatalf("unexpected: %+v", pr)
	}
	enabled, err := s.ListEnabled()
	if err != nil {
		t.Fatalf("listEnabled: %v", err)
	}
	for _, e := range enabled {
		if e.Model == "m1" {
			t.Fatal("disabled model must not appear in ListEnabled")
		}
	}
}

func TestUpsertPreservesZeroValues(t *testing.T) {
	st := newStore(t)
	s := New(st)

	if err := s.Upsert("zero-model", "Zero Model", TokenPricing{}, false); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	var pr model.PriceRule
	if err := st.DB.First(&pr, "model = ?", "zero-model").Error; err != nil {
		t.Fatalf("find: %v", err)
	}
	if pr.ModelRatio != 0 || pr.CompletionRatio != 0 ||
		pr.InputPricePerMillion != 0 || pr.OutputPricePerMillion != 0 ||
		pr.CacheInputPricePerMillion != 0 || pr.CacheOutputPricePerMillion != 0 ||
		pr.Enabled {
		t.Fatalf("upsert must preserve zero values, got %+v", pr)
	}
}

func TestUpsertRMBPricingDerivesPointsFromCurrentRechargeRatio(t *testing.T) {
	st := newStore(t)
	if err := st.DB.AutoMigrate(&model.PlatformConfig{}); err != nil {
		t.Fatalf("migrate platform config: %v", err)
	}
	st.DB.Exec("TRUNCATE platform_configs CASCADE")
	st.DB.Create(&model.PlatformConfig{Key: "recharge_points_per_yuan", Value: "100"})

	s := New(st)
	if err := s.UpsertRMB("rmb-model", "RMB Model", RMBPricing{
		InputPriceRMBPerMillion:       20,
		OutputPriceRMBPerMillion:      80,
		CacheInputPriceRMBPerMillion:  5,
		CacheOutputPriceRMBPerMillion: 10,
	}, true); err != nil {
		t.Fatalf("upsert rmb: %v", err)
	}

	rows, err := s.ListAll()
	if err != nil {
		t.Fatalf("list at ratio 100: %v", err)
	}
	got := findRule(t, rows, "rmb-model")
	if got.InputPricePerMillion != 2000 || got.OutputPricePerMillion != 8000 ||
		got.CacheInputPricePerMillion != 500 || got.CacheOutputPricePerMillion != 1000 {
		t.Fatalf("ratio 100 derived points wrong: %+v", got)
	}

	st.DB.Model(&model.PlatformConfig{}).
		Where("key = ?", "recharge_points_per_yuan").
		Update("value", "200")

	rows, err = s.ListAll()
	if err != nil {
		t.Fatalf("list at ratio 200: %v", err)
	}
	got = findRule(t, rows, "rmb-model")
	if got.InputPriceRMBPerMillion != 20 || got.OutputPriceRMBPerMillion != 80 ||
		got.InputPricePerMillion != 4000 || got.OutputPricePerMillion != 16000 {
		t.Fatalf("RMB must stay fixed and points must follow ratio, got %+v", got)
	}
}

func findRule(t *testing.T, rows []model.PriceRule, modelName string) model.PriceRule {
	t.Helper()
	for _, row := range rows {
		if row.Model == modelName {
			return row
		}
	}
	t.Fatalf("model %s not found in %+v", modelName, rows)
	return model.PriceRule{}
}
