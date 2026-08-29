/**
 * codex-pet-visual 拆分后的方向判定层:三评审盲测 A/B 分类(`runBlindDirectionQa`)与
 * 带标注的 16 向语义复核(`runLabeledDirectionSemantics`)。
 *
 * 盲测是防"模型按 A/B 顺序猜"的唯一手段:图上不带方向标签,评审只能按画面里的可见
 * 特征分类,再与答案键对齐。cardinal 对错进 failures(硬失败),中间方向进 warnings。
 * `majority` 要求严格多数且不允许并列 —— 2:2 或全散一律回落 `ambiguous`,不取第一票。
 *
 * `contradictsCardinalAppearance` 是对旧 cardinal 语义的硬否决:模型有时仍按"000 是
 * 正面 / 090 朝左"这套过时约定作答,那与现行 `CODEX_PET_CARDINAL_APPEARANCE_CONTRACT`
 * 冲突,必须把该方向直接判 fail 并改写 reason,不能当 warning 放过。
 *
 * 依赖方向:types / client → 本文件。不 import image / seedream / qa。
 */

import { Buffer } from "node:buffer";
import Anthropic from "@anthropic-ai/sdk";
import type { DirectionBlindAnswerKey } from "@ai-assistant/codex-pet-pipeline";
import { CODEX_PET_CARDINAL_APPEARANCE_CONTRACT } from "./codex-pet-prompts.js";
import {
  codexPetVisualClient,
  createCodexPetVisualMessage,
  modelProvenance,
  parseJsonObject,
  textFromMessage,
} from "./codex-pet-visual-client.js";
import type {
  BlindDirectionClass,
  BlindDirectionPairVerdict,
  BlindDirectionValidation,
  CodexPetVisualModelProvenance,
  DirectionSemanticVerdict,
} from "./codex-pet-visual-types.js";

function contradictsCardinalAppearance(direction: string, expected: string, observed: string): boolean {
  const statement = `${expected} ${observed}`.toLowerCase();
  const observedText = observed.toLowerCase();
  switch (direction) {
    case "000":
      return /\bfront(?:[- ]?(?:facing|view|portrait))\b|正面|正视/.test(statement)
        || /\bfront\b|正面|正视/.test(expected.toLowerCase())
        || /\bfront\b|正面|正视/.test(observedText);
    case "090":
      return /\b(?:screen[- ]?left|left[- ]?(?:facing|view|profile))\b|朝左|向左|左侧/.test(statement)
        || /\bleft\b|左侧|向左|朝左/.test(expected.toLowerCase())
        || /\bleft\b|左侧|向左|朝左/.test(observedText);
    case "180":
      return /\b(?:back|rear)(?:[- ]?(?:facing|view|portrait))\b|背面|后视/.test(statement)
        || /\b(?:back|rear)\b|背面|后视/.test(expected.toLowerCase())
        || /\b(?:back|rear)\b|背面|后视/.test(observedText);
    case "270":
      return /\b(?:screen[- ]?right|right[- ]?(?:facing|view|profile))\b|朝右|向右|右侧/.test(statement)
        || /\bright\b|右侧|向右|朝右/.test(expected.toLowerCase())
        || /\bright\b|右侧|向右|朝右/.test(observedText);
    default:
      return false;
  }
}

function blindClass(value: unknown): BlindDirectionClass {
  return ["screen-left", "screen-right", "up", "down", "ambiguous"].includes(String(value))
    ? value as BlindDirectionClass
    : "ambiguous";
}

async function oneBlindDirectionReview(input: {
  readonly sheet: Buffer;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
  readonly identityGuide?: string;
}): Promise<{ pairs: readonly BlindDirectionPairVerdict[]; modelProvenance: CodexPetVisualModelProvenance }> {
  const visual = codexPetVisualClient(input.env, input.client);
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 2200,
    temperature: 0,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.sheet.toString("base64") } },
      { type: "text", text: `Classify every unlabeled Codex-pet A/B pair. Use only the axis named in each row. For horizontal use screen-left, screen-right, or ambiguous. For vertical use up, down, or ambiguous. Never infer from A/B order.${input.identityGuide?.trim() ? ` Approved canonical anatomy guide: ${input.identityGuide.trim()} Use it only to identify the character's real eyes, mouth and movable anatomy instead of mistaking fixed markings for gaze features. A feature listed as movable is merely allowed to move when a state needs it; do not require it to move in every animation or frame.` : ""} Return only {\"pairs\":[{\"pair\":\"horizontal-1\",\"A\":\"screen-left\",\"B\":\"screen-right\",\"reason\":\"visible landmark\"}]} and include every shown pair.` },
    ] }],
  }, { env: input.env, signal: input.signal, timeout: 180_000 });
  const parsed = parseJsonObject(textFromMessage(message));
  const pairs = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).pairs)
    ? (parsed as { pairs: unknown[] }).pairs
    : [];
  return {
    pairs: pairs.map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        pair: typeof row.pair === "string" ? row.pair : "",
        A: blindClass(row.A),
        B: blindClass(row.B),
        reason: typeof row.reason === "string" ? row.reason.slice(0, 300) : "",
      };
    }).filter((item) => item.pair),
    modelProvenance: modelProvenance(message, visual.requestedModel, visual.route),
  };
}

function majority(values: readonly BlindDirectionClass[]): BlindDirectionClass {
  const counts = new Map<BlindDirectionClass, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted[0] || sorted[0][1] < 2 || sorted[0][1] === sorted[1]?.[1]) return "ambiguous";
  return sorted[0][0];
}

export async function runBlindDirectionQa(input: {
  readonly sheet: Buffer;
  readonly answerKey: DirectionBlindAnswerKey;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly clientFactory?: () => Anthropic;
  readonly identityGuide?: string;
}): Promise<BlindDirectionValidation> {
  const env = input.env ?? process.env;
  const reviewers = await Promise.all(Array.from({ length: 3 }, () => oneBlindDirectionReview({
    sheet: input.sheet,
    env,
    signal: input.signal,
    client: input.clientFactory?.(),
    identityGuide: input.identityGuide,
  })));
  const failures: string[] = [];
  const warnings: string[] = [];
  const consensus = input.answerKey.pairs.map((answer) => {
    const votes = reviewers.map((reviewer) => reviewer.pairs.find((pair) => pair.pair === answer.pair));
    const A = majority(votes.map((vote) => vote?.A ?? "ambiguous"));
    const B = majority(votes.map((vote) => vote?.B ?? "ambiguous"));
    const mismatches = [A !== answer.A.expected ? `A=${A}, expected=${answer.A.expected}` : "", B !== answer.B.expected ? `B=${B}, expected=${answer.B.expected}` : ""].filter(Boolean);
    if (mismatches.length > 0) {
      const message = `${answer.pair}: ${mismatches.join("; ")}`;
      if (answer.cardinal) failures.push(message);
      else warnings.push(message);
    }
    return { pair: answer.pair, A, B, reason: votes.map((vote) => vote?.reason).filter(Boolean).join(" | ").slice(0, 600) };
  });
  const provenance = reviewers.map((reviewer) => reviewer.modelProvenance);
  return {
    ok: failures.length === 0,
    reviewers: reviewers.map(({ pairs }) => ({ pairs })),
    consensus,
    failures,
    warnings,
    modelProvenance: {
      requestedModel: provenance[0]!.requestedModel,
      actualModels: [...new Set(provenance.map((value) => value.actualModel))],
      route: provenance[0]!.route,
    },
  };
}

export async function runLabeledDirectionSemantics(input: {
  readonly sheet: Buffer;
  readonly expectedDirections: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
  readonly identityGuide?: string;
}): Promise<readonly DirectionSemanticVerdict[]> {
  const env = input.env ?? process.env;
  const visual = codexPetVisualClient(env, input.client);
  const message = await createCodexPetVisualMessage(visual, {
    model: visual.requestedModel,
    max_tokens: 3000,
    temperature: 0,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: input.sheet.toString("base64") } },
      { type: "text", text: `Review the labeled neutral plus 16 Codex-pet look poses at displayed size as one clockwise loop. Expected order: ${input.expectedDirections.join(", ")}. ${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT}${input.identityGuide?.trim() ? ` Approved canonical anatomy guide: ${input.identityGuide.trim()} Use it to identify the real eyes, mouth and movable anatomy; do not interpret fixed markings as gaze features. A feature listed as movable is merely allowed to move when a state needs it; do not require it to move in every animation or frame.` : ""} Return only {"directions":[{"direction":"000","verdict":"pass|warning|fail","expected":"up","observed":"...","horizontalEvidence":"...","verticalEvidence":"...","reason":"..."}]}. Include every direction exactly once. Fail wrong/ambiguous cardinals, wrong quadrant, reversal, visible snap, identity/scale/registration change. Subtle intermediate cues may be warnings.` },
    ] }],
  }, { env, signal: input.signal, timeout: 180_000 });
  const provenance = modelProvenance(message, visual.requestedModel, visual.route);
  const parsed = parseJsonObject(textFromMessage(message));
  const rawDirections = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).directions)
    ? (parsed as { directions: unknown[] }).directions
    : [];
  const byDirection = new Map(rawDirections.map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const direction = typeof row.direction === "string" ? row.direction : "";
    const text = (key: string) => typeof row[key] === "string" ? String(row[key]).slice(0, 400) : "";
    const expected = text("expected");
    const observed = text("observed");
    const reportedVerdict = ["pass", "warning", "fail"].includes(String(row.verdict))
      ? row.verdict as DirectionSemanticVerdict["verdict"]
      : "fail";
    const contradiction = contradictsCardinalAppearance(direction, expected, observed);
    const reason = contradiction
      ? `Rejected stale cardinal semantics for ${direction}: ${text("reason") || observed}`.slice(0, 400)
      : text("reason");
    return [direction, {
      direction,
      verdict: contradiction ? "fail" as const : reportedVerdict,
      expected,
      observed,
      horizontalEvidence: text("horizontalEvidence"),
      verticalEvidence: text("verticalEvidence"),
      reason,
      modelProvenance: provenance,
    }] as const;
  }));
  return input.expectedDirections.map((direction) => byDirection.get(direction) ?? {
    direction,
    verdict: "fail" as const,
    expected: direction,
    observed: "missing verdict",
    horizontalEvidence: "",
    verticalEvidence: "",
    reason: "QA response omitted this direction",
    modelProvenance: provenance,
  });
}
