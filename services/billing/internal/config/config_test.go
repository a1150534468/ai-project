package config

import (
	"testing"

	"yc-billing/internal/billingmode"
)

func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("BILLING_DATABASE_URL", "postgres://example")
	t.Setenv("BILLING_INTERNAL_TOKEN", "test-token")
}

func TestLoadPricingModeDefaultsToStandard(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("BILLING_PRICING_MODE", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PricingMode != billingmode.Standard {
		t.Fatalf("mode=%q, want standard", cfg.PricingMode)
	}
}

func TestLoadPricingModeLearning(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("BILLING_PRICING_MODE", "learning")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PricingMode != billingmode.Learning {
		t.Fatalf("mode=%q, want learning", cfg.PricingMode)
	}
}

func TestLoadRejectsInvalidPricingMode(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("BILLING_PRICING_MODE", "cheap")
	if _, err := Load(); err == nil {
		t.Fatal("invalid pricing mode must fail startup config")
	}
}
