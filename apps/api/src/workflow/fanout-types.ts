export type FanoutMode = "enum" | "matrix" | "script";

// 枚举模式可选的维度
export type FanoutDimensionId =
  | "platform" | "sellingPoint" | "audience" | "style" | "emotion" | "seo";

// 裂变条数：用户可自定义（1~100），10/30/50/100 仅作快捷预设
export type FanoutCount = number;

// extract 产物：对原文的结构化理解（可被用户编辑后回传）
export interface FanoutBrief {
  readonly product: string;
  readonly audience: string;
  readonly sellingPoints: readonly string[];
  readonly style: string;
  readonly scene: string;
}

// generate 入参
export interface FanoutGenerateInput {
  readonly userId: string;
  readonly mode: FanoutMode;
  readonly brief: FanoutBrief;
  readonly count: FanoutCount;
  readonly dimension?: FanoutDimensionId; // enum 模式必填
  readonly dedup?: boolean;               // enum 模式可选；matrix 恒为 true；script 恒为 false
}

// 单条变体
export interface FanoutVariant {
  readonly id: string;
  readonly text: string;
  readonly label: string;      // 该条对应的维度值/脚本类型，如"小红书"/"60秒口播"
  readonly charCount: number;
  readonly similarity: number; // 与已接受集合的最高相似度，0~1；未去重则 0
  readonly highSimilarity: boolean;
}

export interface FanoutGenerateResult {
  readonly variants: readonly FanoutVariant[];
  readonly requested: number;      // 目标条数
  readonly delivered: number;      // 实际交付条数
  readonly avgSimilarity: number;  // 平均相似度（去重模式有意义）
  readonly partialFailure: boolean; // 是否有批次失败被跳过
  readonly stoppedByBalance: boolean; // 是否因余额不足提前停止
}
