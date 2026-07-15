export const MAX_AUTOMATIC_NOVEL_REVISIONS = 2;

export function buildNovelRevisionGuidance(args: {
  readonly billableChars: number;
  readonly targetChars: number;
  readonly actionItems?: readonly string[];
  readonly gateReasons?: readonly string[];
}): string[] {
  const guidance = [
    ...(args.billableChars < args.targetChars * 0.8
      ? [`当前正文仅 ${args.billableChars} 字，重写后不得少于 ${Math.round(args.targetChars * 0.9)} 字`]
      : []),
    ...(args.gateReasons ?? []),
    ...(args.actionItems ?? []),
  ];
  return [...new Set(guidance.map((item) => item.trim()).filter(Boolean))];
}
