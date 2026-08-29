/**
 * codex-pet-visual 拆分后的视觉 QA 层:单票 / 合议判图、look 机制描述、身份说明书。
 * 四个对外函数都是同一个形状 —— 拼 content blocks → 走 client 的带重试发消息 →
 * 解析 JSON / 文本 → 附上模型出处。
 *
 * `normalizeQaVerdict` 是唯一的收窄口:模型给的字段一律按缺省视为不通过
 * (`row.pass === true` 而不是真值判断),分数夹到 0~100,字符串数组截断。少了这层,
 * 上游一个 `pass: "true"` 字符串就能把不合格的板子放行。
 *
 * `runCodexPetVisualQaConsensus` 的合议只在这里投票,过没过由
 * `codexPetVisualQaConsensusPasses`(types 层)判 —— 别在这里再写一份门槛。
 *
 * `generateCodexPetIdentityGuide` 的 prompt 里"图 1 是唯一视觉真相"与"可动特征只是
 * 许可清单"两句必须留:前者防原始上传图把已通过的 canonical 顶掉,后者防 QA 把
 * "允许动的部件这一帧没动"判成缺陷。
 *
 * 依赖方向:types / client → 本文件。不 import image / seedream / direction。
 */

import { Buffer } from "node:buffer";
import Anthropic from "@anthropic-ai/sdk";
import type { ImageBinaryInput } from "../_shared/image-service.js";
import {
  codexPetVisualClient,
  createCodexPetVisualMessage,
  modelProvenance,
  parseJsonObject,
  textFromMessage,
} from "./codex-pet-visual-client.js";
import type {
  CodexPetVisualModelProvenance,
  PetVisualQaConsensus,
  PetVisualQaVerdict,
} from "./codex-pet-visual-types.js";

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
}

function normalizeQaVerdict(value: unknown): PetVisualQaVerdict {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const repairRows = Array.isArray(row.repairRows)
    ? row.repairRows.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 16)
    : [];
  return {
    pass: row.pass === true,
    score: Math.max(0, Math.min(100, typeof row.score === "number" ? row.score : 0)),
    mirrorSafe: row.mirrorSafe === true,
    identity: row.identity === true,
    structure: row.structure === true,
    semantics: row.semantics === true,
    continuity: row.continuity === true,
    warnings: safeStringArray(row.warnings),
    failures: safeStringArray(row.failures),
    repairPrompt: typeof row.repairPrompt === "string" ? row.repairPrompt.slice(0, 1200) : "",
    repairRows,
  };
}

export async function runCodexPetVisualQa(input: {
  readonly images: readonly { readonly buffer: Buffer; readonly mime?: string }[];
  readonly prompt: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
}): Promise<PetVisualQaVerdict> {
  const env = input.env ?? process.env;
  const visual = codexPetVisualClient(env, input.client);
  const blocks: Array<Record<string, unknown>> = input.images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mime ?? "image/png", data: image.buffer.toString("base64") },
  }));
  blocks.push({ type: "text", text: input.prompt });
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 1200,
    temperature: 0,
    messages: [{ role: "user", content: blocks as unknown as Anthropic.MessageParam["content"] }],
  }, { env, signal: input.signal, timeout: 180_000 });
  return {
    ...normalizeQaVerdict(parseJsonObject(textFromMessage(message))),
    modelProvenance: modelProvenance(message, visual.requestedModel, visual.route),
  };
}

export async function runCodexPetVisualQaConsensus(input: Parameters<typeof runCodexPetVisualQa>[0] & { readonly repetitions?: number }): Promise<PetVisualQaConsensus> {
  const repetitions = Math.max(1, input.repetitions ?? 3);
  const verdicts = await Promise.all(Array.from({ length: repetitions }, () => runCodexPetVisualQa(input)));
  const required = Math.floor(repetitions / 2) + 1;
  const pass = verdicts.filter((verdict) => verdict.pass).length >= required;
  const mirrorSafe = verdicts.filter((verdict) => verdict.mirrorSafe).length >= required;
  const provenance = verdicts.map((verdict) => verdict.modelProvenance).filter((value): value is CodexPetVisualModelProvenance => Boolean(value));
  return {
    pass,
    verdicts,
    score: Math.round(verdicts.reduce((sum, verdict) => sum + verdict.score, 0) / verdicts.length),
    mirrorSafe,
    warnings: [...new Set(verdicts.flatMap((verdict) => verdict.warnings))],
    failures: [...new Set(verdicts.flatMap((verdict) => verdict.failures))],
    ...(provenance.length > 0
      ? {
          modelProvenance: {
            requestedModel: provenance[0]!.requestedModel,
            actualModels: [...new Set(provenance.map((value) => value.actualModel))],
            route: provenance[0]!.route,
          },
        }
      : {}),
  };
}

export async function generateCodexPetLookMechanics(input: {
  readonly prompt: string;
  readonly reference: Buffer;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
  readonly onModelProvenance?: (provenance: CodexPetVisualModelProvenance) => void;
}): Promise<string> {
  const env = input.env ?? process.env;
  const visual = codexPetVisualClient(env, input.client);
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 500,
    temperature: 0.2,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.reference.toString("base64") } },
      { type: "text", text: input.prompt },
    ] }],
  }, { env, signal: input.signal, timeout: 120_000 });
  const provenance = modelProvenance(message, visual.requestedModel, visual.route);
  input.onModelProvenance?.(provenance);
  const text = textFromMessage(message).replace(/\s+/g, " ").trim();
  if (!text) throw new Error("look-mechanics model returned an empty plan");
  return text.slice(0, 1200);
}

export async function generateCodexPetIdentityGuide(input: {
  readonly reference: Buffer;
  readonly mime?: string;
  /**
   * Original user uploads, in upload order. They may clarify what an
   * ambiguous canonical shape represents, but never override the approved
   * canonical appearance.
   */
  readonly originalReferences?: readonly ImageBinaryInput[];
  readonly characterBrief?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
  readonly onModelProvenance?: (provenance: CodexPetVisualModelProvenance) => void;
}): Promise<string> {
  const env = input.env ?? process.env;
  const visual = codexPetVisualClient(env, input.client);
  const supportedMime = (mime?: string) => (
    mime === "image/jpeg"
      || mime === "image/webp"
      || mime === "image/gif"
      || mime === "image/png"
      ? mime
      : "image/png"
  );
  const originalReferences = (input.originalReferences ?? []).slice(0, 3);
  const characterBrief = input.characterBrief?.replace(/\s+/g, " ").trim().slice(0, 1200) || "未提供";
  const imageBlocks = [
    { type: "image", source: { type: "base64", media_type: supportedMime(input.mime), data: input.reference.toString("base64") } },
    ...originalReferences.map((reference) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: supportedMime(reference.mime),
        data: reference.b64,
      },
    })),
  ];
  const referenceContext = originalReferences.length > 0
    ? `Images 2-${originalReferences.length + 1} are the original user references in upload order. Use them only to disambiguate anatomical semantics in the canonical image (for example whether a visible shape is an eye, paw, foot, mouth, or fixed marking). They must not override image 1's visible shape, count, position, palette, proportions, topology, material, markings, clothing, props, or silhouette.`
    : "No original user reference images are available. Report genuinely ambiguous canonical features under 歧义 instead of guessing.";
  const content = [
    ...imageBlocks,
    { type: "text", text: `Analyze these images and write one concise Chinese anatomy/identity guide for later Codex desktop-pet image generation and visual QA. Image 1 is the approved canonical image and is the sole visual source of truth. ${referenceContext}

Character brief (semantic context only; never use it to redesign the canonical appearance): ${characterBrief}

Use these exact labeled fields in one short paragraph: 头、耳、眼、嘴、四肢、尾巴、固定花纹、可动特征、歧义. Explicitly distinguish eyes, paws/feet and mouth from decorative markings; state 数量、位置、颜色、连接关系 or 不可见/无 when applicable. Fixed markings must describe count and topology. 可动特征 is only a permission list: a feature may move when the requested action naturally needs it, but it is not required to move in every animation or every frame. A state is not defective merely because an allowed movable feature remains still. Use the original references and brief only to resolve the semantic identity of ambiguous visible canonical features. Put genuinely uncertain interpretations only under 歧义. Do not invent hidden anatomy, new props, markdown, JSON, or production instructions.` },
  ] as unknown as Anthropic.MessageParam["content"];
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 650,
    temperature: 0,
    messages: [{ role: "user", content }],
  }, { env, signal: input.signal, timeout: 120_000 });
  const provenance = modelProvenance(message, visual.requestedModel, visual.route);
  input.onModelProvenance?.(provenance);
  const text = textFromMessage(message).replace(/\s+/g, " ").trim();
  if (!text) throw new Error("identity-guide model returned an empty guide");
  return text.slice(0, 1600);
}
