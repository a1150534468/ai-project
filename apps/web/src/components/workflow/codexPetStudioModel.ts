import type {
  CodexPetArtifact,
  CodexPetCreatePayload,
  CodexPetEvent,
  CodexPetJob,
  CodexPetProject,
  CodexPetProjectStatus,
  CodexPetReferenceAsset,
  CodexPetRun,
  CodexPetRunStatus,
  CodexPetImageModel,
  CodexPetStylePreset,
} from "../../codexPetApi";
import {
  CODEX_PET_IMAGE_MODEL,
  CODEX_PET_IMAGE_MODELS,
  CODEX_PET_MODEL_CONTRACT_VERSION,
  CODEX_PET_VISUAL_QA_MODEL,
} from "../../codexPetApi";

export const CODEX_PET_POLL_MS = 2_500;
export const CODEX_PET_STREAM_RECONNECT_MS = 1_200;
export const CODEX_PET_MAX_REFERENCES = 3;
export const CODEX_PET_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
export const CODEX_PET_REFERENCE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
]);

export const CODEX_PET_STYLE_OPTIONS: readonly {
  readonly value: CodexPetStylePreset;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: "auto", label: "自动", description: "由模型匹配角色特征" },
  { value: "pixel", label: "像素", description: "清晰像素边缘与游戏感" },
  { value: "plush", label: "毛绒", description: "柔软玩偶材质" },
  { value: "clay", label: "黏土", description: "手作定格动画质感" },
  { value: "sticker", label: "贴纸", description: "简洁轮廓与高辨识度" },
  { value: "flat-illustration", label: "扁平插画", description: "轻量现代插画" },
  { value: "3d-toy", label: "3D 玩具", description: "立体收藏玩具质感" },
  { value: "painterly", label: "绘画风", description: "保留笔触与手绘感" },
];

export interface CodexPetDraft {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly stylePreset: CodexPetStylePreset;
  readonly styleNotes: string;
  readonly referenceAssets: readonly CodexPetReferenceAsset[];
  readonly autoContinue: boolean;
  readonly imageModel: CodexPetImageModel;
  readonly visualQaModel: string;
  readonly qualityInspectionEnabled: boolean;
}

export const EMPTY_CODEX_PET_DRAFT: CodexPetDraft = {
  name: "",
  description: "",
  prompt: "",
  stylePreset: "auto",
  styleNotes: "",
  referenceAssets: [],
  autoContinue: false,
  imageModel: CODEX_PET_IMAGE_MODEL,
  visualQaModel: CODEX_PET_VISUAL_QA_MODEL,
  qualityInspectionEnabled: false,
};

export interface CodexPetProgressStep {
  readonly id: "prepare" | "base" | "motion" | "delivery";
  readonly label: string;
  readonly range: string;
  readonly start: number;
  readonly end: number;
}

export const CODEX_PET_PROGRESS_STEPS: readonly CodexPetProgressStep[] = [
  { id: "prepare", label: "准备桌宠", range: "0–5%", start: 0, end: 5 },
  { id: "base", label: "生成主形象", range: "5–15%", start: 5, end: 15 },
  { id: "motion", label: "制作动作", range: "15–80%", start: 15, end: 80 },
  { id: "delivery", label: "验证、打包与归档", range: "80–100%", start: 80, end: 100 },
];

export const CODEX_PET_STANDARD_STATES = [
  { id: "idle", label: "待机" },
  { id: "running-right", label: "向右移动" },
  { id: "running-left", label: "向左移动" },
  { id: "waving", label: "挥手" },
  { id: "jumping", label: "跳跃" },
  { id: "failed", label: "失败" },
  { id: "waiting", label: "等待确认" },
  { id: "running", label: "执行任务" },
  { id: "review", label: "审阅" },
] as const;

export const CODEX_PET_LOOK_DIRECTIONS = [
  "000", "022.5", "045", "067.5", "090", "112.5", "135", "157.5",
  "180", "202.5", "225", "247.5", "270", "292.5", "315", "337.5",
] as const;

const STATUS_LABELS: Record<CodexPetProjectStatus, string> = {
  draft: "草稿",
  queued: "排队中",
  base_generating: "生成主形象",
  awaiting_base_review: "等待确认主形象",
  awaiting_direction_review: "等待批准下一次生图",
  awaiting_regeneration_approval: "等待额外调用批准",
  standard_generating: "制作标准动作",
  direction_generating: "制作观察方向",
  validating: "质量检查",
  repairing: "自动修复",
  packaging: "生成兼容包",
  archiving: "归档到知识库",
  ready: "制作完成",
  failed: "制作失败",
  cancelled: "已取消",
  legacy_read_only: "历史只读归档",
  deleting: "正在删除",
};

export function codexPetStatusLabel(status: string): string {
  return STATUS_LABELS[status as CodexPetProjectStatus] ?? status;
}

export function isCodexPetRunLive(status: CodexPetRunStatus | undefined): boolean {
  return status !== undefined && !["ready", "failed", "cancelled", "legacy_read_only", "awaiting_base_review", "awaiting_direction_review", "awaiting_regeneration_approval"].includes(status);
}

function codexPetJobTimestamp(job: CodexPetJob): number {
  const updatedAt = Date.parse(job.updatedAt);
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(job.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function mostRecentCodexPetJob(
  jobs: readonly CodexPetJob[],
  status: "running" | "queued",
): CodexPetJob | null {
  let selected: CodexPetJob | null = null;
  for (const job of jobs) {
    if (job.status !== status) continue;
    if (!selected || codexPetJobTimestamp(job) >= codexPetJobTimestamp(selected)) selected = job;
  }
  return selected;
}

/**
 * Durable Job state is authoritative for the current visual subtask. Events
 * are an append-only activity log, so a late completion event from one
 * parallel branch must not replace another branch that is still running.
 */
export function codexPetCurrentSubtask(
  jobs: readonly CodexPetJob[],
  eventJobKey?: string | null,
  progressStage?: string | null,
): string {
  return mostRecentCodexPetJob(jobs, "running")?.key
    ?? mostRecentCodexPetJob(jobs, "queued")?.key
    ?? eventJobKey
    ?? progressStage
    ?? "—";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function codexPetValidationPassed(report: unknown): boolean {
  const value = objectValue(report);
  if (!value) return false;
  const topLevelPassed = value.ok === true || value.valid === true || value.passed === true;
  const status = String(value.validationStatus ?? value.status ?? value.result ?? "").toLowerCase();
  const passed = topLevelPassed || status === "passed" || status === "valid" || status === "ok" || status === "success";
  if (!passed) return false;
  const gateKeys = [
    "atlas", "deterministic", "packagedSpritesheet", "chromaDespill", "visual", "multimodal", "final",
    "finalVisualQa", "blindDirectionValidation", "directionRegistration", "directionContinuity",
    "row9PreGenerationGate", "row10PreGenerationGate",
  ];
  if (gateKeys.some((key) => {
    const gate = objectValue(value[key]);
    return gate?.ok === false || gate?.pass === false || gate?.passed === false || gate?.status === "failed";
  })) return false;
  return !(Array.isArray(value.directionSemantics)
    && value.directionSemantics.some((entry) => objectValue(entry)?.verdict === "fail"));
}

export type CodexPetModelContractState = "pending" | "valid" | "invalid";

/**
 * Evaluate model provenance without ever consulting the app-wide chat model.
 * Missing actual-model metadata is expected while a run is in progress, but
 * mismatched requested models, relay aliases, or routes fail immediately.
 */
export function codexPetModelContractState(
  run: CodexPetRun | null | undefined,
): CodexPetModelContractState {
  if (!run) return "pending";
  const imageActualModels = Array.isArray(run.actualModels) ? run.actualModels : [];
  const visualActualModels = Array.isArray(run.visualQaActualModels) ? run.visualQaActualModels : [];
  const visualRoutes = Array.isArray(run.visualQaRoutes) ? run.visualQaRoutes : [];
  // The migration default is false, but old v1 rows were produced under the
  // mandatory-QA contract. Preserve their provenance semantics while new v3
  // runs use the explicit switch frozen in their input snapshot.
  const qualityInspectionEnabled = run.modelContractVersion === CODEX_PET_MODEL_CONTRACT_VERSION
    ? run.qualityInspectionEnabled === true
    : true;
  const imageModelAllowed = (CODEX_PET_IMAGE_MODELS as readonly string[]).includes(run.requestedModel);
  const imageActualMatches = imageActualModels.every((model) => (
    model === run.requestedModel
      || (run.requestedModel === CODEX_PET_IMAGE_MODEL && model === "gpt-image-2-codex")
  ));
  const visualModelAllowed = !qualityInspectionEnabled || (Boolean(run.visualQaModel)
    && !run.visualQaModel.toLowerCase().startsWith("qwen3.7")
    && !run.visualQaModel.toLowerCase().includes("embedding"));
  const expectedVisualRoute = run.visualQaModel.startsWith("gpt-") || run.visualQaModel === "codex-auto-review"
    ? "chatgpt_model_route"
    : "bailian_model_route";
  const modelContractKnown = run.modelContractVersion === CODEX_PET_MODEL_CONTRACT_VERSION
    || (run.modelContractVersion === "gpt-only-v1"
      && run.requestedModel === CODEX_PET_IMAGE_MODEL
      && run.visualQaModel === CODEX_PET_VISUAL_QA_MODEL);
  if (!modelContractKnown
    || !imageModelAllowed
    || !imageActualMatches
    || !visualModelAllowed
    || (qualityInspectionEnabled && (!visualActualModels.every((model) => model === run.visualQaModel)
      || !visualRoutes.every((route) => route === expectedVisualRoute)))
    || (!qualityInspectionEnabled && (visualActualModels.length > 0 || visualRoutes.length > 0))) return "invalid";
  if (imageActualModels.length === 0 || (qualityInspectionEnabled && (visualActualModels.length === 0 || visualRoutes.length === 0))) {
    return "pending";
  }
  return "valid";
}

export function isCodexPetDeliveryReady(run: CodexPetRun | null | undefined): boolean {
  return Boolean(
    run
    && (run.status === "archiving" || run.status === "ready" || run.status === "failed")
    && run.spritesheetArtifactId
    && run.packageArtifactId
    // Artifact integrity is enforced by the delivery API. The report and
    // model-provenance views remain diagnostic information, not user-facing
    // delivery gates.
  );
}

export function codexPetDisplayProgress(run: CodexPetRun | null | undefined, eventProgress = 0): number {
  if (!run) return 0;
  const progress = Math.max(run.progressPercent, eventProgress);
  if (isCodexPetDeliveryReady(run)) return 100;
  return Math.max(0, Math.min(98, Math.round(progress)));
}

export function canEditCodexPetProject(status: CodexPetProjectStatus): boolean {
  return status === "draft" || status === "awaiting_base_review";
}

/**
 * Validate the fields that are safe to persist in a draft.  Visual input is
 * intentionally optional while a project is still a draft: users may want to
 * save the name/style first and add a prompt or references later.  The start
 * action passes `requireVisualInput: true` so a billable run can never be
 * queued without something for the image model to use.
 */
export function validateCodexPetDraft(
  draft: CodexPetDraft,
  options: { readonly requireVisualInput?: boolean } = {},
): string | null {
  const nameLength = Array.from(draft.name.trim()).length;
  if (nameLength === 0) return "请输入桌宠名称";
  if (nameLength > 30) return "桌宠名称不能超过 30 个字";
  if (draft.qualityInspectionEnabled && !draft.visualQaModel.trim()) return "请选择视觉理解/质检模型";
  if (!(CODEX_PET_IMAGE_MODELS as readonly string[]).includes(draft.imageModel)) return "请选择可用的生图模型";
  if (Array.from(draft.prompt).length > 4_000) return "角色提示词不能超过 4000 个字";
  if (draft.referenceAssets.length > CODEX_PET_MAX_REFERENCES) return "参考图最多 3 张";
  if (options.requireVisualInput !== false && !draft.prompt.trim() && draft.referenceAssets.length === 0) {
    return "请填写角色提示词或上传至少一张参考图";
  }
  return null;
}

export function codexPetDraftFromProject(project: CodexPetProject): CodexPetDraft {
  return {
    name: project.name,
    description: project.description,
    prompt: project.prompt,
    stylePreset: project.stylePreset,
    styleNotes: project.styleNotes,
    referenceAssets: project.referenceAssets ?? project.referenceAssetIds.map((id) => ({
      id,
      mime: "image/*",
      originalUrl: "",
      thumbnailUrl: "",
      createdAt: project.createdAt,
    })),
    autoContinue: project.autoContinue,
    imageModel: project.imageModel === CODEX_PET_IMAGE_MODEL
      ? project.imageModel
      : CODEX_PET_IMAGE_MODEL,
    visualQaModel: project.visualQaModel ?? CODEX_PET_VISUAL_QA_MODEL,
    qualityInspectionEnabled: project.qualityInspectionEnabled === true,
  };
}

export function codexPetPayloadFromDraft(draft: CodexPetDraft, idempotencyKey?: string): CodexPetCreatePayload {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    prompt: draft.prompt.trim(),
    stylePreset: draft.stylePreset,
    styleNotes: draft.styleNotes.trim(),
    referenceAssetIds: draft.referenceAssets.map((asset) => asset.id),
    autoContinue: draft.autoContinue,
    imageModel: draft.imageModel,
    visualQaModel: draft.visualQaModel,
    qualityInspectionEnabled: draft.qualityInspectionEnabled,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

export function mergeCodexPetEvents(
  current: readonly CodexPetEvent[],
  incoming: readonly CodexPetEvent[],
  limit = 160,
): readonly CodexPetEvent[] {
  const bySequence = new Map<number, CodexPetEvent>();
  for (const event of current) bySequence.set(event.sequence, event);
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-limit);
}

export function codexPetArtifactUrl(artifact: CodexPetArtifact): string {
  return artifact.previewUrl || artifact.thumbnailUrl || artifact.url || "";
}

export function isCodexPetBaseCandidate(artifact: CodexPetArtifact): boolean {
  return artifact.kind === "base_candidate" || artifact.kind.startsWith("base_candidate_") || artifact.kind === "base";
}

export function isCodexPetAnimationPreview(artifact: CodexPetArtifact): boolean {
  // `preview` is the final contact sheet persisted during packaging.  It is
  // useful as a separate delivery artifact, but must not be mistaken for one
  // of the nine animated standard-state previews.
  return artifact.kind === "animation_preview";
}

export function isCodexPetFinalContactSheet(artifact: CodexPetArtifact): boolean {
  return artifact.kind === "preview";
}

export function isCodexPetDirectionArtifact(artifact: CodexPetArtifact): boolean {
  return artifact.kind.includes("direction") || artifact.kind.includes("look");
}

export function makeCodexPetIdempotencyKey(prefix: "project" | "run" | "extra" | "continue"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `codex-pet-${prefix}-${crypto.randomUUID()}`;
  return `codex-pet-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function codexPetFileError(file: File): string | null {
  if (!CODEX_PET_REFERENCE_MIME_TYPES.has(file.type.toLowerCase())) {
    return "参考图仅支持 JPG、PNG、WEBP、BMP、TIFF 或 GIF";
  }
  if (file.size <= 0 || file.size > CODEX_PET_REFERENCE_MAX_BYTES) return "参考图大小需在 10MB 以内";
  return null;
}
