package pricing

import "testing"

func TestChatQuota(t *testing.T) {
	rule := Rule{ModelRatio: 2, CompletionRatio: 3}
	// quota = ceil(modelRatio*(input + output*completionRatio)*groupRatio)
	// = ceil(2*(100 + 10*3)*1) = ceil(2*130) = 260
	got := ChatQuota(rule, Usage{InputTokens: 100, OutputTokens: 10}, 1.0)
	if got != 260 {
		t.Fatalf("want 260 got %d", got)
	}
}

func TestChatQuotaGroupRatioAndCeil(t *testing.T) {
	rule := Rule{ModelRatio: 1, CompletionRatio: 1}
	// ceil(1*(3+0)*0.5) = ceil(1.5) = 2
	got := ChatQuota(rule, Usage{InputTokens: 3, OutputTokens: 0}, 0.5)
	if got != 2 {
		t.Fatalf("want 2 got %d", got)
	}
}

func TestReserveEstimateUsesMaxOutput(t *testing.T) {
	rule := Rule{ModelRatio: 1, CompletionRatio: 1}
	// 预扣按 input + maxOutput 估算上限
	got := ReserveQuota(rule, 100, 1000, 1.0) // input=100, maxOutput=1000
	if got != 1100 {
		t.Fatalf("want 1100 got %d", got)
	}
}

func TestChatQuotaUsesPerMillionTokenRates(t *testing.T) {
	rule := Rule{
		InputPricePerMillion:       10,
		OutputPricePerMillion:      30,
		CacheInputPricePerMillion:  2,
		CacheOutputPricePerMillion: 4,
	}
	usage := Usage{
		InputTokens:       1_000_000,
		OutputTokens:      500_000,
		CacheInputTokens:  2_000_000,
		CacheOutputTokens: 250_000,
	}
	got := ChatQuota(rule, usage, 1.0)
	if got != 30 {
		t.Fatalf("want 30 got %d", got)
	}
}

func TestChatQuotaFallsBackToLegacyRatios(t *testing.T) {
	rule := Rule{ModelRatio: 0.00001, CompletionRatio: 3}
	got := ChatQuota(rule, Usage{InputTokens: 1_000_000, OutputTokens: 1_000_000}, 1.0)
	if got != 40 {
		t.Fatalf("want 40 got %d", got)
	}
}
