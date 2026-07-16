package registry

// AI Pixel publishes these prices in USD per one million tokens. Billing stores
// RMB list prices, so seed them with a fixed conversion rate; operators can
// still override any seeded price from the admin console without later starts
// overwriting it.
const pixelUSDtoRMB = 7.2

func pixelPricingUSD(input, output float64) RMBPricing {
	return RMBPricing{
		InputPriceRMBPerMillion:  input * pixelUSDtoRMB,
		OutputPriceRMBPerMillion: output * pixelUSDtoRMB,
	}
}

// Only the current models explicitly selected for the AI Pixel chat channel.
// Older GPT aliases, audio/realtime models and image models are intentionally
// omitted even if the upstream /v1/models endpoint happens to list them.
var pixelChatModelSpecs = []chatModelSpec{
	{
		Model: "codex-auto-review", DisplayName: "Codex Auto Review",
		Description:    "面向代码审查和改动分析的 Codex 模型，通过 AI Pixel 的 Anthropic Messages 兼容接口调用。",
		CapabilityTags: "chat,coding,reasoning,tool-use,ai-pixel",
		UseCases:       "代码审查 / 变更分析 / 工程建议", SortOrder: 200, Pricing: pixelPricingUSD(5, 30),
	},
	{
		Model: "gpt-5.4", DisplayName: "GPT-5.4",
		Description:    "AI Pixel 提供的 GPT-5.4 通用对话模型，适合复杂分析、内容生成和编程任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,ai-pixel",
		UseCases:       "复杂分析 / 通用对话 / AI 编程", SortOrder: 210, Pricing: pixelPricingUSD(2.5, 15),
	},
	{
		Model: "gpt-5.4-mini", DisplayName: "GPT-5.4 Mini",
		Description:    "低成本、低延迟的 GPT-5.4 Mini，适合高频对话和批量文本任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,ai-pixel",
		UseCases:       "高频对话 / 摘要 / 批量处理", SortOrder: 220, Pricing: pixelPricingUSD(0.75, 4.5),
	},
	{
		Model: "gpt-5.5", DisplayName: "GPT-5.5",
		Description:    "AI Pixel 提供的 GPT-5.5 高能力对话模型，适合高难度推理和工程任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,ai-pixel",
		UseCases:       "高难度推理 / 架构设计 / 复杂写作", SortOrder: 230, Pricing: pixelPricingUSD(5, 30),
	},
	{
		Model: "gpt-5.6-luna", DisplayName: "GPT-5.6 Luna",
		Description:    "GPT-5.6 Luna 经济型对话模型，适合日常助手和高并发文本处理。",
		CapabilityTags: "chat,coding,reasoning,tool-use,ai-pixel",
		UseCases:       "日常助手 / 高频问答 / 文本处理", SortOrder: 240, Pricing: pixelPricingUSD(1, 6),
	},
	{
		Model: "gpt-5.6-sol", DisplayName: "GPT-5.6 Sol",
		Description:    "GPT-5.6 Sol 高能力对话模型，适合复杂推理、代码和长内容生成。",
		CapabilityTags: "chat,coding,reasoning,tool-use,ai-pixel",
		UseCases:       "复杂推理 / AI 编程 / 长内容", SortOrder: 250, Pricing: pixelPricingUSD(5, 30),
	},
	{
		Model: "gpt-5.6-terra", DisplayName: "GPT-5.6 Terra",
		Description:    "GPT-5.6 Terra 均衡型对话模型，兼顾能力、速度和成本。",
		CapabilityTags: "chat,coding,reasoning,tool-use,ai-pixel",
		UseCases:       "通用对话 / 业务分析 / 代码生成", SortOrder: 260, Pricing: pixelPricingUSD(2.5, 15),
	},
}
