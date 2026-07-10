package pricing

import "math"

const tokensPerMillion = 1_000_000

type Rule struct {
	ModelRatio      float64
	CompletionRatio float64

	InputPricePerMillion       float64
	OutputPricePerMillion      float64
	CacheInputPricePerMillion  float64
	CacheOutputPricePerMillion float64
}

type Usage struct {
	InputTokens       int64
	OutputTokens      int64
	CacheInputTokens  int64
	CacheOutputTokens int64
}

func (r Rule) effectiveRates() (input, output, cacheInput, cacheOutput float64) {
	input = r.InputPricePerMillion
	output = r.OutputPricePerMillion
	cacheInput = r.CacheInputPricePerMillion
	cacheOutput = r.CacheOutputPricePerMillion
	if input == 0 && output == 0 && cacheInput == 0 && cacheOutput == 0 && r.ModelRatio > 0 {
		input = r.ModelRatio * tokensPerMillion
		output = r.ModelRatio * r.CompletionRatio * tokensPerMillion
	}
	return
}

// 实际扣点：ceil((各类 token * 对应「算力点/100W token」单价之和 / 100W) * groupRatio)
func ChatQuota(r Rule, u Usage, groupRatio float64) int64 {
	inputRate, outputRate, cacheInputRate, cacheOutputRate := r.effectiveRates()
	points := (float64(u.InputTokens)*inputRate +
		float64(u.OutputTokens)*outputRate +
		float64(u.CacheInputTokens)*cacheInputRate +
		float64(u.CacheOutputTokens)*cacheOutputRate) / tokensPerMillion
	return int64(math.Ceil(points * groupRatio))
}

// 预扣估值：按 input + maxOutputTokens 估上限（保守，结算时多退）
func ReserveQuota(r Rule, inputTokens, maxOutputTokens int64, groupRatio float64) int64 {
	return ChatQuota(r, Usage{InputTokens: inputTokens, OutputTokens: maxOutputTokens}, groupRatio)
}
