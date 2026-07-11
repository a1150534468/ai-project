package config

import (
	"errors"
	"os"

	"yc-billing/internal/billingmode"
)

type Config struct {
	DatabaseURL   string
	InternalToken string
	Port          string
	QuotaPerUnit  float64 // 每「1 积分」对应的 quota 单位；移植 NewAPI QuotaPerUnit
	EpayPID       string  // 易支付商户 ID
	EpayKey       string  // 易支付密钥
	EpayGateway   string  // 易支付网关 URL
	CallbackBase  string  // 回调基础 URL（PUBLIC_CALLBACK_BASE）
	PricingMode   billingmode.Mode
}

func Load() (Config, error) {
	pricingMode, err := billingmode.Parse(os.Getenv("BILLING_PRICING_MODE"))
	if err != nil {
		return Config{}, err
	}
	c := Config{
		DatabaseURL:   os.Getenv("BILLING_DATABASE_URL"),
		InternalToken: os.Getenv("BILLING_INTERNAL_TOKEN"),
		Port:          envOr("BILLING_PORT", "8093"),
		QuotaPerUnit:  500000, // 1 积分 = 500000 quota 单位（与 NewAPI 默认一致，可调）
		EpayPID:       os.Getenv("EPAY_PID"),
		EpayKey:       os.Getenv("EPAY_KEY"),
		EpayGateway:   os.Getenv("EPAY_GATEWAY"),
		CallbackBase:  os.Getenv("PUBLIC_CALLBACK_BASE"),
		PricingMode:   pricingMode,
	}
	if c.DatabaseURL == "" {
		return c, errors.New("BILLING_DATABASE_URL is required")
	}
	if c.InternalToken == "" {
		return c, errors.New("BILLING_INTERNAL_TOKEN is required")
	}
	return c, nil
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
