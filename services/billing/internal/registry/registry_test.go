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
	st.DB.Model(&model.PriceRule{}).Where("model = ?", "GLM-5.2").Update("model_ratio", 9.9)
	if err := s.SeedDefault(); err != nil { // 二次 seed 不得覆盖
		t.Fatalf("seed2: %v", err)
	}
	var pr model.PriceRule
	st.DB.First(&pr, "model = ?", "GLM-5.2")
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
	var pr model.PriceRule
	if err := st.DB.First(&pr, "model = ?", "GLM-5.2").Error; err != nil {
		t.Fatalf("find: %v", err)
	}
	if pr.InputPricePerMillion != 2000 || pr.OutputPricePerMillion != 2000 {
		t.Fatalf("seed must expose per-million prices, got %+v", pr)
	}

	var bailian model.PriceRule
	if err := st.DB.First(&bailian, "model = ?", "qwen3.7-plus").Error; err != nil {
		t.Fatalf("find bailian model: %v", err)
	}
	if bailian.InputPriceRMBPerMillion != 2 || bailian.OutputPriceRMBPerMillion != 8 || bailian.CacheInputPriceRMBPerMillion != 0.4 {
		t.Fatalf("bailian seed must preserve official RMB list prices, got %+v", bailian)
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
	if !seen["GLM-5.2"] {
		t.Fatal("default chat model must be enabled")
	}
	if !seen["qwen3.7-plus"] {
		t.Fatal("bailian default chat model must be enabled")
	}
	if seen["text-embedding-v4"] {
		t.Fatal("embedding model must not appear in chat model list")
	}

	var embedding model.PriceRule
	if err := st.DB.First(&embedding, "model = ?", "text-embedding-v4").Error; err != nil {
		t.Fatalf("embedding price rule missing: %v", err)
	}
	if !embedding.Enabled || embedding.CompletionRatio != 0 {
		t.Fatalf("embedding price rule must stay enabled for kb pricing with zero completion ratio, got %+v", embedding)
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
