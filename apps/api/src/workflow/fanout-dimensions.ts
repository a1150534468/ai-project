import type { FanoutDimensionId, FanoutMode } from "./fanout-types.js";

export const FANOUT_MODEL = "MiniMax-M3";
export const FANOUT_CONCURRENCY = 4;       // 批次并发上限
export const FANOUT_MAX_REFILL_ROUNDS = 2; // 去重不足时补批轮数上限
export const FANOUT_DEDUP_THRESHOLD = 0.7; // Jaccard 判重阈值
export const FANOUT_EXTRACT_MAX_TOKENS = 600;
export const FANOUT_TIMEOUT_MS = 60_000;
export const FANOUT_COUNTS = [10, 30, 50, 100] as const; // 快捷预设档
export const FANOUT_MIN_COUNT = 1;   // 自定义条数下限
export const FANOUT_MAX_COUNT = 100; // 自定义条数上限（每批一次计费调用，控成本/耗时）

// 每种模式的分批参数
export interface ModeBatchConfig {
  readonly batchSize: number;      // 每批生成条数
  readonly maxOutputTokens: number; // 每批预扣/上限
}
export const MODE_BATCH: Readonly<Record<FanoutMode, ModeBatchConfig>> = {
  enum: { batchSize: 10, maxOutputTokens: 1600 },
  matrix: { batchSize: 10, maxOutputTokens: 1800 },
  script: { batchSize: 5, maxOutputTokens: 2600 },
};

// enum 模式维度定义：枚举值 + 该维度的裂变指令片段
export interface DimensionConfig {
  readonly id: FanoutDimensionId;
  readonly name: string;
  readonly values: readonly string[];   // 枚举值（如各平台名）
  readonly instruction: string;         // 注入 prompt 的裂变说明
}

export const DIMENSIONS: Readonly<Record<FanoutDimensionId, DimensionConfig>> = {
  platform: {
    id: "platform", name: "平台",
    values: ["小红书", "抖音", "视频号", "微信公众号", "知乎", "B站", "微博"],
    instruction: "为每个平台各写 1 条，贴合该平台的语气、篇幅与用户习惯。",
  },
  sellingPoint: {
    id: "sellingPoint", name: "卖点",
    values: ["效率", "成本", "速度", "质量", "智能", "专业", "安全"],
    instruction: "每条只主打一个卖点，把该卖点讲透、讲出画面感。",
  },
  audience: {
    id: "audience", name: "人群",
    values: ["学生", "教师", "HR", "销售", "老板", "行政", "产品经理", "运营"],
    instruction: "每条面向一类人群，命中其真实使用场景与痛点。",
  },
  style: {
    id: "style", name: "风格",
    values: ["正式", "口语", "故事", "悬念", "幽默", "专业", "极简", "夸张"],
    instruction: "每条用一种风格重写，风格差异要鲜明可感。",
  },
  emotion: {
    id: "emotion", name: "情绪",
    values: ["焦虑", "期待", "惊喜", "信任", "权威", "温暖", "好奇", "震惊"],
    instruction: "每条主打一种情绪，用情绪驱动点击与转化。",
  },
  seo: {
    id: "seo", name: "SEO 关键词",
    values: [], // 运行期从 brief 派生关键词，见 prompts
    instruction: "每条围绕一个搜索关键词改写，自然嵌入关键词以提升搜索覆盖。",
  },
};

export function isFanoutDimensionId(v: string): v is FanoutDimensionId {
  return v in DIMENSIONS;
}
