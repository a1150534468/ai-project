export interface NovelQualityGateInput {
  readonly consistencyScore: number;
  readonly styleScore: number;
  readonly tensionScore: number;
  readonly highSeverityIssues: number;
  readonly criticalIssues: number;
}

export interface NovelQualityGateResult {
  readonly passed: boolean;
  readonly score: number;
  readonly reasons: string[];
}

export function evaluateNovelQualityGate(input: NovelQualityGateInput): NovelQualityGateResult {
  const reasons: string[] = [];
  if (input.criticalIssues > 0) reasons.push("存在阻断级一致性或内容问题");
  if (input.consistencyScore < 0.65) reasons.push("一致性评分低于 65%");
  if (input.styleScore < 0.6) reasons.push("文风评分低于 60%");
  if (input.tensionScore < 0.35) reasons.push("章节张力过低");
  if (input.highSeverityIssues > 2) reasons.push("高严重度问题超过 2 项");
  const score = Math.round((input.consistencyScore * 0.45 + input.styleScore * 0.3 + input.tensionScore * 0.25) * 100);
  return { passed: reasons.length === 0, score, reasons };
}
