package registry

import "testing"

func TestPixelChatModelCatalog(t *testing.T) {
	want := map[string][2]float64{
		"codex-auto-review": {5, 30},
		"gpt-5.4":           {2.5, 15},
		"gpt-5.4-mini":      {0.75, 4.5},
		"gpt-5.5":           {5, 30},
		"gpt-5.6-luna":      {1, 6},
		"gpt-5.6-sol":       {5, 30},
		"gpt-5.6-terra":     {2.5, 15},
	}
	if len(pixelChatModelSpecs) != len(want) {
		t.Fatalf("AI Pixel catalog must contain exactly %d selected models, got %d", len(want), len(pixelChatModelSpecs))
	}
	seen := make(map[string]bool, len(pixelChatModelSpecs))
	for _, spec := range pixelChatModelSpecs {
		usd, ok := want[spec.Model]
		if !ok {
			t.Fatalf("unexpected AI Pixel model: %s", spec.Model)
		}
		if seen[spec.Model] {
			t.Fatalf("duplicate AI Pixel model: %s", spec.Model)
		}
		seen[spec.Model] = true
		if spec.DisplayName == "" || spec.Description == "" || spec.UseCases == "" {
			t.Fatalf("catalog metadata incomplete: %+v", spec)
		}
		if spec.Pricing.InputPriceRMBPerMillion != usd[0]*pixelUSDtoRMB ||
			spec.Pricing.OutputPriceRMBPerMillion != usd[1]*pixelUSDtoRMB {
			t.Fatalf("unexpected converted pricing for %s: %+v", spec.Model, spec.Pricing)
		}
	}
}
