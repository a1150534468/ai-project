import { buildNovelQualityDiagnostics } from "./novel-text-analysis.js";
import type { NovelReviewPayload } from "./novel-workbench-types.js";

const MIN_MANUAL_MODIFICATION_RATE = 15;

function compact(content: string): string {
  return (content || "").replace(/\s+/g, "");
}

export function estimateNovelModificationRate(rawContent: string | null | undefined, finalContent: string | null | undefined): number {
  const original = compact(rawContent ?? "");
  const revised = compact(finalContent ?? "");
  if (!original) return revised ? 100 : 0;
  const compareLength = Math.min(original.length, revised.length);
  let sameCount = 0;
  for (let index = 0; index < compareLength; index += 1) {
    if (original[index] === revised[index]) sameCount += 1;
  }
  return Math.max(0, Math.round((1 - sameCount / Math.max(original.length, revised.length, 1)) * 100));
}

export function buildNovelReviewPayload(args: {
  readonly rawContent: string;
  readonly finalContent: string;
  readonly summary: string;
  readonly openThreads: readonly string[];
  readonly consistencyRisks: readonly string[];
}): NovelReviewPayload {
  const quality = buildNovelQualityDiagnostics(args.finalContent || args.rawContent);
  const modificationRate = estimateNovelModificationRate(args.rawContent, args.finalContent);
  const strengths: string[] = [];
  if (args.summary.trim()) strengths.push("本章主事件已经可被快速复述");
  if (args.openThreads.length) strengths.push("章节结尾保留了后续推进空间");
  if (quality.metrics.wordCount >= 1200) strengths.push("篇幅基本支撑起单章节奏");
  if (quality.score >= 75) strengths.push("节奏和信息组织基本稳定");
  if (quality.endingHook) strengths.push("章节收尾具备追读钩子");

  const actionItems: string[] = [];
  if (modificationRate < MIN_MANUAL_MODIFICATION_RATE) actionItems.push("人工改稿幅度偏低，发布前需要继续强化措辞、节奏和细节。");
  if (quality.metrics.wordCount < 800) actionItems.push("章节字数偏少，建议补足场景铺垫或关键反应。");
  if (args.openThreads.length === 0) actionItems.push("当前章节缺少明显钩子，建议补一个未解问题或下一步压力。");
  for (const issue of quality.issues.slice(0, 3)) actionItems.push(issue.suggestion || issue.message);
  for (const risk of args.consistencyRisks.slice(0, 3)) actionItems.push(`一致性复核：${risk}`);
  if (actionItems.length === 0) actionItems.push("结构和信息密度基本达标，建议重点做语句润色和错字复查。");

  const hasHighQualityIssue = quality.issues.some((issue) => issue.severity === "high");
  const sections = [
    args.summary ? `本章概述：${args.summary}` : "",
    strengths.length ? `优点：${strengths.slice(0, 3).join("；")}` : "",
    `诊断：质量分 ${quality.score} /100；张力 ${quality.tensionScore}；节奏 ${quality.rhythmStatus}；风格风险 ${quality.styleRisk}`,
    `建议：${actionItems.slice(0, 4).join("；")}`,
  ].filter(Boolean);

  return {
    aiReview: sections.join("\n"),
    aiActionItems: actionItems.slice(0, 5),
    modificationRate,
    suggestedStatus: modificationRate < MIN_MANUAL_MODIFICATION_RATE || args.consistencyRisks.length > 0 || hasHighQualityIssue ? "revise" : "approved",
  };
}
