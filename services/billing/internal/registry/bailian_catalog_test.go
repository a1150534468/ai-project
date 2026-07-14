package registry

import (
	"strings"
	"testing"
)

func TestBailianFreeModelCatalog(t *testing.T) {
	if got := len(bailianFreeModelSpecs); got != 19 {
		t.Fatalf("free model catalog must contain 19 models, got %d", got)
	}

	seen := make(map[string]bool, len(bailianFreeModelSpecs))
	lastSortOrder := 0
	openAIOnly := make(map[string]bool)
	for _, spec := range bailianFreeModelSpecs {
		if spec.Model == "" || spec.DisplayName == "" || spec.Description == "" || spec.UseCases == "" {
			t.Fatalf("catalog metadata incomplete: %+v", spec)
		}
		if seen[spec.Model] {
			t.Fatalf("duplicate model code: %s", spec.Model)
		}
		seen[spec.Model] = true
		if spec.OpenAIOnly {
			openAIOnly[spec.Model] = true
		}
		if !strings.Contains(","+spec.CapabilityTags+",", ",free-quota,") {
			t.Fatalf("model %s is missing free-quota tag", spec.Model)
		}
		if spec.Pricing.InputPriceRMBPerMillion <= 0 || spec.Pricing.OutputPriceRMBPerMillion <= 0 {
			t.Fatalf("model %s is missing official RMB pricing", spec.Model)
		}
		if spec.SortOrder <= lastSortOrder {
			t.Fatalf("catalog sort order must be strictly increasing at %s", spec.Model)
		}
		lastSortOrder = spec.SortOrder
	}

	for _, required := range []string{
		"qwen3.7-plus", "qwen3.7-max", "deepseek-v4-pro", "deepseek-v4-flash",
		"glm-5.2", "kimi-k2.6", "kimi-k2.7-code", "qwen3.5-ocr",
	} {
		if !seen[required] {
			t.Fatalf("required free model missing: %s", required)
		}
	}
	if seen["GLM-5.2"] {
		t.Fatal("legacy uppercase alias must not be part of the Bailian catalog")
	}
	if len(openAIOnly) != 2 || !openAIOnly["qwen3.7-max-preview"] || !openAIOnly["qwen3.7-max-2026-05-17"] {
		t.Fatalf("unexpected OpenAI-only model set: %+v", openAIOnly)
	}
}
