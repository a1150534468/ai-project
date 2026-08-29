/**
 * codex-pet-visual 拆分后的判据形状层:出图产物、视觉 QA 单票与合议、盲测方向与标注
 * 方向语义的类型,以及两个纯判定函数(单票过、合议过)。
 *
 * 这一层只有类型和两个不碰 IO 的判定函数,是整棵依赖树的叶子 —— 只要谁想引用
 * `PetVisualQaVerdict` 就不必再把整条上游客户端链拖进来。
 *
 * `codexPetVisualQaConsensusPasses` 的口径别动:五个硬维度各自要过半数,不是"总票
 * 过半就算过"。放宽成后者会让 identity 全票不过的板子靠 score 高被放行。
 *
 * 依赖方向:本文件(叶子)→ client → qa / direction;image 也直接取 GeneratedPetVisual。
 */

import type { Buffer } from "node:buffer";
import type { ImageGenerationResult } from "../_shared/image-service.js";
import type { CodexPetVisualQaRoute } from "./codex-pet-model-contract.js";

export interface CodexPetVisualModelProvenance {
  readonly requestedModel: string;
  readonly actualModel: string;
  readonly route: CodexPetVisualQaRoute | "injected_test_client";
}

export interface GeneratedPetVisual {
  readonly buffer: Buffer;
  readonly mime: string;
  readonly provider: ImageGenerationResult;
}

export interface PetVisualQaVerdict {
  readonly pass: boolean;
  readonly score: number;
  readonly mirrorSafe: boolean;
  readonly identity: boolean;
  readonly structure: boolean;
  readonly semantics: boolean;
  readonly continuity: boolean;
  readonly warnings: readonly string[];
  readonly failures: readonly string[];
  readonly repairPrompt: string;
  readonly modelProvenance?: CodexPetVisualModelProvenance;
  /**
   * Complete action groups that should be regenerated when this verdict
   * fails.  Older QA providers may omit the field; callers must then infer a
   * conservative repair scope from failures/repairPrompt.
   */
  readonly repairRows?: readonly string[];
}

export interface PetVisualQaConsensus {
  readonly pass: boolean;
  readonly verdicts: readonly PetVisualQaVerdict[];
  readonly score: number;
  readonly mirrorSafe: boolean;
  readonly warnings: readonly string[];
  readonly failures: readonly string[];
  readonly modelProvenance?: {
    readonly requestedModel: string;
    readonly actualModels: readonly string[];
    readonly route: CodexPetVisualModelProvenance["route"];
  };
}

export function codexPetVisualQaVerdictPasses(verdict: PetVisualQaVerdict): boolean {
  return verdict.pass
    && verdict.identity
    && verdict.structure
    && verdict.semantics
    && verdict.continuity;
}

/** Require a strict majority for every hard visual dimension independently. */
export function codexPetVisualQaConsensusPasses(consensus: PetVisualQaConsensus): boolean {
  if (!consensus.pass || consensus.verdicts.length === 0) return false;
  const required = Math.floor(consensus.verdicts.length / 2) + 1;
  const majority = (field: "pass" | "identity" | "structure" | "semantics" | "continuity") => (
    consensus.verdicts.filter((verdict) => verdict[field]).length >= required
  );
  return majority("pass")
    && majority("identity")
    && majority("structure")
    && majority("semantics")
    && majority("continuity");
}

export type BlindDirectionClass = "screen-left" | "screen-right" | "up" | "down" | "ambiguous";
export interface BlindDirectionPairVerdict {
  readonly pair: string;
  readonly A: BlindDirectionClass;
  readonly B: BlindDirectionClass;
  readonly reason: string;
}

export interface BlindDirectionValidation {
  readonly ok: boolean;
  readonly reviewers: readonly { readonly pairs: readonly BlindDirectionPairVerdict[] }[];
  readonly consensus: readonly BlindDirectionPairVerdict[];
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly modelProvenance?: {
    readonly requestedModel: string;
    readonly actualModels: readonly string[];
    readonly route: CodexPetVisualModelProvenance["route"];
  };
}

export interface DirectionSemanticVerdict {
  readonly direction: string;
  readonly verdict: "pass" | "warning" | "fail";
  readonly expected: string;
  readonly observed: string;
  readonly horizontalEvidence: string;
  readonly verticalEvidence: string;
  readonly reason: string;
  readonly modelProvenance?: CodexPetVisualModelProvenance;
}
