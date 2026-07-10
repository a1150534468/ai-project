export interface PriceRow { readonly rate: number; readonly perUnits: number; readonly enabled: boolean }

export const STAGES = [
  { id: "source", title: "素材", sub: "上传参考视频或直接写文案" },
  { id: "analysis", title: "拆解", sub: "分镜/结构/口播文稿" },
  { id: "rewrite", title: "洗稿", sub: "改写文案，可挂知识库" },
  { id: "voice", title: "配音", sub: "选音色生成口播音频" },
  { id: "avatar", title: "形象", sub: "选择或新建数字人" },
  { id: "bgm", title: "配乐", sub: "可选背景音乐" },
  { id: "result", title: "成片", sub: "对口型合成并预览" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

export function stageIndex(id: StageId): number {
  return STAGES.findIndex((s) => s.id === id);
}

export function nextStage(id: StageId): StageId {
  return STAGES[Math.min(stageIndex(id) + 1, STAGES.length - 1)].id;
}

export function prevStage(id: StageId): StageId {
  return STAGES[Math.max(stageIndex(id) - 1, 0)].id;
}

// 与后端 billing 的 PER_UNIT / PER_CALL 口径一致；未启用返回 null（调用方置灰并提示未配价）
export function estimatePerUnit(p: PriceRow, units: number): number | null {
  if (!p.enabled) return null;
  if (units <= 0) return 0;
  const per = p.perUnits > 0 ? p.perUnits : 1;
  return Math.ceil((p.rate * units) / per);
}

export function estimatePerCall(p: PriceRow): number | null {
  if (!p.enabled) return null;
  return Math.ceil(p.rate);
}

export interface WizardState {
  readonly spokenScript: string;
  readonly script: string;
  readonly audioObjectKey: string | null;
  readonly avatarId: string | null;
}

// 最终用于配音的文案：优先洗稿结果，否则原口播文稿
export function effectiveScript(s: Pick<WizardState, "spokenScript" | "script">): string {
  return (s.script || s.spokenScript).trim();
}

export function canLeaveStage(stage: StageId, s: WizardState): boolean {
  if (stage === "source" || stage === "analysis" || stage === "rewrite") return effectiveScript(s).length > 0;
  if (stage === "voice") return Boolean(s.audioObjectKey);
  if (stage === "avatar") return Boolean(s.avatarId);
  return true; // bgm 可选；result 无需离开
}
