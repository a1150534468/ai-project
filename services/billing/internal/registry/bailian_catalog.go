package registry

// chatModelSpec describes a model exposed in the marketplace and chat picker.
// bailianFreeModelSpecs is the source of truth for the Bailian models that
// currently carry free quota in the Beijing workspace. Prices are the regular
// China-mainland list prices per one million tokens; temporary promotions are
// deliberately excluded so billing does not become stale when they expire.
type chatModelSpec struct {
	Model           string
	DisplayName     string
	Description     string
	CapabilityTags  string
	ContextWindow   int64
	MaxOutputTokens int64
	UseCases        string
	SortOrder       int
	Pricing         RMBPricing
	OpenAIOnly      bool
}

func bailianPricing(input, output, cacheInput float64) RMBPricing {
	return RMBPricing{
		InputPriceRMBPerMillion:       input,
		OutputPriceRMBPerMillion:      output,
		CacheInputPriceRMBPerMillion:  cacheInput,
		CacheOutputPriceRMBPerMillion: output,
	}
}

var bailianFreeModelSpecs = []chatModelSpec{
	{
		Model: "qwen3.7-plus", DisplayName: "Qwen3.7 Plus",
		Description:    "能力与成本均衡的百炼主力模型，支持长上下文、深度思考、视觉理解和工具调用。",
		CapabilityTags: "chat,coding,reasoning,vision,tool-use,free-quota", ContextWindow: 1_000_000,
		UseCases: "通用对话 / Agent / AI 编程 / 长文档", SortOrder: 10, Pricing: bailianPricing(2, 8, 0.4),
	},
	{
		Model: "qwen3.7-max", DisplayName: "Qwen3.7 Max",
		Description:    "千问旗舰推理模型，适合复杂规划、代码工程和高难度分析。",
		CapabilityTags: "chat,coding,reasoning,tool-use,free-quota", ContextWindow: 1_000_000,
		UseCases: "复杂推理 / 架构规划 / 高难度代码", SortOrder: 20, Pricing: bailianPricing(12, 36, 2.4),
	},
	{
		Model: "deepseek-v4-pro", DisplayName: "DeepSeek V4 Pro",
		Description:    "DeepSeek V4 高能力版本，兼顾复杂推理、代码和通用文本任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,free-quota",
		UseCases:       "复杂推理 / 代码生成 / 内容创作", SortOrder: 30, Pricing: bailianPricing(12, 24, 2.4),
	},
	{
		Model: "glm-5.2", DisplayName: "GLM-5.2",
		Description:    "智谱 GLM 旗舰模型，支持思考与非思考模式，适合通用对话和 Agent 任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,free-quota",
		UseCases:       "通用对话 / Agent / 复杂推理", SortOrder: 40, Pricing: bailianPricing(8, 28, 0),
	},
	{
		Model: "qwen3.6-flash", DisplayName: "Qwen3.6 Flash",
		Description:    "低成本高速度的千问模型，保留长上下文和工具调用能力。",
		CapabilityTags: "chat,coding,reasoning,tool-use,free-quota", ContextWindow: 1_000_000,
		UseCases: "高频对话 / 摘要 / 轻量 Agent", SortOrder: 50, Pricing: bailianPricing(1.2, 7.2, 0.24),
	},
	{
		Model: "deepseek-v4-flash", DisplayName: "DeepSeek V4 Flash",
		Description:    "DeepSeek V4 轻量高速版本，适合高频、低延迟的文本任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,free-quota",
		UseCases:       "高频对话 / 文本处理 / 轻量代码", SortOrder: 60, Pricing: bailianPricing(1, 2, 0.2),
	},
	{
		Model: "kimi-k2.6", DisplayName: "Kimi K2.6",
		Description:    "Kimi 通用模型，支持思考与非思考模式，擅长长文本和复杂任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,free-quota",
		UseCases:       "长文本 / 通用对话 / 复杂任务", SortOrder: 70, Pricing: bailianPricing(6.5, 27, 0),
	},
	{
		Model: "kimi-k2.7-code", DisplayName: "Kimi K2.7 Code",
		Description:    "面向软件工程与 Agent 场景的 Kimi 代码模型，默认采用深度思考。",
		CapabilityTags: "chat,coding,reasoning,tool-use,vision,free-quota",
		UseCases:       "AI 编程 / 代码审查 / 工程 Agent", SortOrder: 80, Pricing: bailianPricing(6.5, 27, 0),
	},
	{
		Model: "qwen3.6-35b-a3b", DisplayName: "Qwen3.6 35B-A3B",
		Description:    "高性价比 MoE 千问模型，适合通用文本、代码和推理任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,free-quota",
		UseCases:       "通用对话 / 代码 / 批量文本处理", SortOrder: 90, Pricing: bailianPricing(1.8, 10.8, 0),
	},
	{
		Model: "qwen3.6-27b", DisplayName: "Qwen3.6 27B",
		Description:    "千问稠密参数模型，适合稳定的通用生成、推理与代码任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,free-quota",
		UseCases:       "通用对话 / 推理 / 代码生成", SortOrder: 100, Pricing: bailianPricing(3, 18, 0),
	},
	{
		Model: "qwen3.7-max-preview", DisplayName: "Qwen3.7 Max Preview",
		Description:    "Qwen3.7 Max 的预览别名，适合验证最新旗舰推理能力。",
		CapabilityTags: "coding,reasoning,preview,free-quota", ContextWindow: 1_000_000,
		UseCases: "旗舰能力预览 / 复杂推理", SortOrder: 110, Pricing: bailianPricing(12, 36, 2.4), OpenAIOnly: true,
	},
	{
		Model: "qwen3.6-max-preview", DisplayName: "Qwen3.6 Max Preview",
		Description:    "Qwen3.6 Max 预览模型，支持思考与非思考模式。",
		CapabilityTags: "chat,coding,reasoning,tool-use,preview,free-quota",
		UseCases:       "复杂推理 / 代码 / 模型评测", SortOrder: 120, Pricing: bailianPricing(9, 54, 1.8),
	},
	{
		Model: "qwen3.7-plus-2026-05-26", DisplayName: "Qwen3.7 Plus (2026-05-26)",
		Description:    "Qwen3.7 Plus 的固定版本，便于需要结果稳定和版本锁定的生产任务。",
		CapabilityTags: "chat,coding,reasoning,vision,tool-use,versioned,free-quota", ContextWindow: 1_000_000,
		UseCases: "生产版本锁定 / Agent / 长文档", SortOrder: 130, Pricing: bailianPricing(2, 8, 0.4),
	},
	{
		Model: "qwen3.7-max-2026-06-08", DisplayName: "Qwen3.7 Max (2026-06-08)",
		Description:    "Qwen3.7 Max 的 2026-06-08 固定版本，用于稳定复现旗舰模型效果。",
		CapabilityTags: "chat,coding,reasoning,tool-use,versioned,free-quota", ContextWindow: 1_000_000,
		UseCases: "生产版本锁定 / 复杂推理", SortOrder: 140, Pricing: bailianPricing(12, 36, 2.4),
	},
	{
		Model: "qwen3.7-max-2026-05-20", DisplayName: "Qwen3.7 Max (2026-05-20)",
		Description:    "Qwen3.7 Max 的 2026-05-20 固定版本，也是当前稳定别名的能力基线。",
		CapabilityTags: "chat,coding,reasoning,tool-use,versioned,free-quota", ContextWindow: 1_000_000,
		UseCases: "生产版本锁定 / 复杂推理", SortOrder: 150, Pricing: bailianPricing(12, 36, 2.4),
	},
	{
		Model: "qwen3.7-max-2026-05-17", DisplayName: "Qwen3.7 Max (2026-05-17)",
		Description:    "Qwen3.7 Max 早期固定版本，仅思考模式，适合回归比较。",
		CapabilityTags: "coding,reasoning,versioned,free-quota", ContextWindow: 1_000_000,
		UseCases: "版本回归 / 深度推理", SortOrder: 160, Pricing: bailianPricing(12, 36, 2.4), OpenAIOnly: true,
	},
	{
		Model: "qwen3.6-flash-2026-04-16", DisplayName: "Qwen3.6 Flash (2026-04-16)",
		Description:    "Qwen3.6 Flash 的固定版本，适合低成本且要求输出可复现的任务。",
		CapabilityTags: "chat,coding,reasoning,tool-use,versioned,free-quota", ContextWindow: 1_000_000,
		UseCases: "低成本生产任务 / 版本锁定", SortOrder: 170, Pricing: bailianPricing(1.2, 7.2, 0.24),
	},
	{
		Model: "qwen3.5-plus-2026-04-20", DisplayName: "Qwen3.5 Plus (2026-04-20)",
		Description:    "Qwen3.5 Plus 的固定版本，适合常规对话、文档处理和批量生成。",
		CapabilityTags: "chat,coding,tool-use,versioned,free-quota",
		UseCases:       "通用对话 / 文档处理 / 批量生成", SortOrder: 180, Pricing: bailianPricing(0.8, 4.8, 0),
	},
	{
		Model: "qwen3.5-ocr", DisplayName: "Qwen3.5 OCR",
		Description:    "面向图片文字识别、版面理解和文档抽取的千问 OCR 专项模型。",
		CapabilityTags: "chat,vision,ocr,document,free-quota",
		UseCases:       "图片文字识别 / 票据与文档抽取", SortOrder: 190, Pricing: bailianPricing(0.5, 2, 0),
	},
}
