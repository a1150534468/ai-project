// P3.1 阶段 2 Task 2.2：三份 look 修复循环合一。
//
// executeRun 原先有四段近乎逐字重复的方向行修复循环：行内 look-a、行内 look-b，
// 以及校验期重建里的 look-a 与 look-b。逐字节比对后差异空间是二维的，且恰好可分解：
//
// - 行别轴：输入产物、参考图组合、注册时锁定的 row-9、门禁函数、文案里的角度区间；
// - 阶段轴：循环形状、进度、额度耗尽的报错方式、是否 emit run.repairing、首轮 hint。
//
// 所以行别拆成两个导出函数，阶段差异全部收进 LookRepairOptions，而真正出过漂移的
// 那部分控制流（额度耗尽判定、累积修复要求、诊断板、循环形状）只在
// runLookRepairLoop 里写一次。

import { Buffer } from "node:buffer";
import { LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT, petRowSpec } from "@ai-assistant/codex-pet-pipeline";
import { type CodexPetArtifact } from "@prisma/client";
import { buildLookRowPrompt } from "../codex-pet-prompts.js";
import { runBoardJob } from "./runner-board-job.js";
import {
  type ApprovedRegisteredDirectionRow,
  type FirstLookRowGate,
  type SecondLookRowGate,
  appendCumulativeRepairRequirement,
  lookRowReferences,
  registerDirectionRow,
  reviewFirstLookRow,
  reviewSecondLookRow,
} from "./runner-direction.js";
import { emit } from "./runner-lease.js";
import {
  CodexPetImageApprovalRequiredError,
  type LookBReferenceState,
  type LookRowState,
  type RunnerContext,
} from "./runner-types.js";

/**
 * 修复循环真正需要读的门禁字段。
 *
 * row-9 与 row-10 的门禁返回类型不同，但循环只关心这三样；收窄成这个接口后
 * runLookRepairLoop 不必泛型化，两行的状态对象都能直接传进来。
 */
export interface LookRowGateCore {
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly repairPrompt: string;
}

/** 阶段轴上的全部差异。行别差异不在这里，由 A/B 两个函数各自承担。 */
export interface LookRepairOptions {
  /** runBoardJob 与 run.repairing 事件用的进度。 */
  readonly progress: number;
  /** registerDirectionRow 用的进度。行内 look-a 是 73 而不是 74，不能与上一项合并。 */
  readonly registerProgress: number;
  /** 只有校验期重建写 "validating"；行内前置门禁留空，走 runBoardJob 的默认阶段。 */
  readonly workflowStage?: "validating";
  /**
   * 非 null = 先生成后判（校验期重建的 `for (;;)` 形状），值即首轮的修复要求；
   * null = 先判后生成（行内前置门禁的 `while (!pass)` 形状），首轮生成在调用点循环外。
   *
   * 这两件事本来就是同一个决定，所以合成一个字段：进入校验期重建时门禁通常已经是
   * pass 的，`while` 形状根本进不去循环体，必须先生成；而"首轮该发什么 hint"也只有
   * 这条路用得上。拆成 forceFirstRound + initialHint 两个字段反而能配出无意义的组合。
   */
  readonly initialHint: string | null;
  /** 门禁没给出可用修复文案时的兜底句。四份实现各写了不同的一句，不是笔误。 */
  readonly gateFallbackHint: string;
  /** 额度耗尽时报错文案的前半句，冒号与失败原因由循环补齐。 */
  readonly exhaustedPrefix: string;
  /** 额度耗尽时：审批门开着就抛 CodexPetImageApprovalRequiredError，否则一律普通 Error。 */
  readonly budgetExhausted: "approval-gate" | "plain-error";
  /** 行内门禁在循环里 emit；校验期重建由调用点先行 emit，这里不能重复发。 */
  readonly emitRepairing: boolean;
}

/** 两行都要用、且在一次修复循环期间不变的输入。 */
interface LookRepairSharedDeps {
  readonly mechanics: string;
  readonly canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  readonly cardinalAnchor: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  readonly standardContact: Buffer;
  readonly standardContactArtifactId: string;
  readonly layout: Buffer;
  readonly neutral: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  readonly anchorStoryboard: Buffer;
}

export type LookARepairDeps = LookRepairSharedDeps;

export interface LookBRepairDeps extends LookRepairSharedDeps {
  /** 已批准的 row-9：既是 look-b 的输入产物，也是注册要锁定的行，也是门禁的前一行。 */
  readonly lockedRow9: ApprovedRegisteredDirectionRow;
  /** 由 row-9 派生的两张参考图。重建 look-a 之后会整体换掉，所以按引用读。 */
  readonly references: LookBReferenceState;
}

/**
 * 一行方向图的修复循环骨架。行别无关，只负责"什么时候该再生成一轮、带什么 hint"。
 *
 * `round` 回调直接写回传进来的 state（而不是返回新值再由这里赋值），这样
 * 生成 / 注册 / 门禁三步的赋值时机与合一之前逐字一致 —— 其中任何一步抛出时，
 * state 里已经推进的部分保持原样。
 */
async function runLookRepairLoop(ctx: RunnerContext, input: {
  readonly row: "look-a" | "look-b";
  readonly state: LookRowState<LookRowGateCore>;
  readonly repairingMessage: string;
  readonly options: LookRepairOptions;
  readonly round: (round: { readonly diagnosticBoard: Buffer; readonly hint: string }) => Promise<void>;
}): Promise<void> {
  const { options, state } = input;
  const requirements: string[] = [];
  let diagnosticBoard = state.row.board;
  let hint = options.initialHint === null
    ? ""
    : appendCumulativeRepairRequirement(requirements, options.initialHint);
  // 首轮是否跳过门禁判定 —— 也就是 while 形状与 for(;;) 形状的唯一区别。
  let generateBeforeGate = options.initialHint !== null;
  for (;;) {
    if (!generateBeforeGate) {
      if (state.gate.pass) return;
      if (state.row.job.attempt >= state.row.job.maxAttempts) {
        const message = `${options.exhaustedPrefix}：${state.gate.failures.join("；") || "方向语义或连续性失败"}`;
        if (options.budgetExhausted === "approval-gate" && ctx.env.CODEX_PET_IMAGE_APPROVAL_GATE !== "0") {
          throw new CodexPetImageApprovalRequiredError(input.row, `${message}，需要确认后才能重新生成`);
        }
        throw new Error(message);
      }
      if (options.emitRepairing) {
        await emit(ctx, "run.repairing", "repairing", options.progress, input.repairingMessage, {
          attempt: state.row.job.attempt,
          retryKind: "visual",
          failures: state.gate.failures,
        }, state.row.job.key);
      }
      diagnosticBoard = state.row.board;
      hint = appendCumulativeRepairRequirement(
        requirements,
        state.gate.repairPrompt || state.gate.failures.join("；") || options.gateFallbackHint,
      );
    }
    generateBeforeGate = false;
    await input.round({ diagnosticBoard, hint });
  }
}

/** 重建 row-9 直到前置门禁通过。调用点：行内前置门禁、校验期方向重建。 */
export async function repairLookARow(ctx: RunnerContext, input: {
  readonly state: LookRowState<FirstLookRowGate>;
  readonly deps: LookARepairDeps;
  readonly options: LookRepairOptions;
}): Promise<void> {
  const { deps, options, state } = input;
  await runLookRepairLoop(ctx, {
    row: "look-a",
    state,
    repairingMessage: "正在修复第一组观察方向，第二组尚未启动",
    options,
    round: async ({ diagnosticBoard, hint }) => {
      state.row = await runBoardJob(ctx, {
        key: "look-a",
        kind: "look_row",
        dependencies: ["look-cardinals"],
        inputArtifactIds: [deps.canonical.artifact.id, deps.cardinalAnchor.artifact.id, deps.standardContactArtifactId],
        prompt: buildLookRowPrompt(ctx.identity, "look-a", deps.mechanics),
        references: lookRowReferences({
          row: "look-a",
          anchorStoryboard: deps.anchorStoryboard,
          canonical: { buffer: deps.canonical.buffer, mime: deps.canonical.artifact.mime },
          cardinalAnchor: { buffer: deps.cardinalAnchor.buffer, mime: deps.cardinalAnchor.artifact.mime },
          standardContact: deps.standardContact,
          layout: deps.layout,
          diagnosticBoard,
        }),
        columns: 4,
        rows: 2,
        frameCount: 8,
        frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
        progress: options.progress,
        qaKind: "directions",
        qaContext: "修复方向 000 到 157.5 的完整连续动作组",
        workflowStage: options.workflowStage,
        animationDurations: petRowSpec("look-a").durations,
        force: true,
        repairHint: hint,
      });
      state.registered = await registerDirectionRow(ctx, {
        row: "look-a",
        source: state.row,
        neutral: deps.neutral,
        progress: options.registerProgress,
      });
      state.gate = await reviewFirstLookRow(ctx, {
        look: state.registered,
        canonical: deps.canonical,
        standardContact: deps.standardContact,
        cardinalAnchor: deps.cardinalAnchor,
      });
    },
  });
}

/** 重建 row-10 直到前置门禁通过。row-9 全程锁定，不会被这条路径改写。 */
export async function repairLookBRow(ctx: RunnerContext, input: {
  readonly state: LookRowState<SecondLookRowGate>;
  readonly deps: LookBRepairDeps;
  readonly options: LookRepairOptions;
}): Promise<void> {
  const { deps, options, state } = input;
  await runLookRepairLoop(ctx, {
    row: "look-b",
    state,
    repairingMessage: "正在修复第二组观察方向，最终组装尚未启动",
    options,
    round: async ({ diagnosticBoard, hint }) => {
      state.row = await runBoardJob(ctx, {
        key: "look-b",
        kind: "look_row",
        dependencies: ["look-a-registration"],
        inputArtifactIds: [
          deps.canonical.artifact.id,
          deps.cardinalAnchor.artifact.id,
          deps.lockedRow9.registeredRowArtifact.id,
          deps.lockedRow9.manifestArtifact.id,
          deps.standardContactArtifactId,
        ],
        prompt: buildLookRowPrompt(ctx.identity, "look-b", deps.mechanics),
        references: lookRowReferences({
          row: "look-b",
          anchorStoryboard: deps.anchorStoryboard,
          directionArcGuide: deps.references.lookBScreenLeftTrajectoryReference,
          canonical: { buffer: deps.canonical.buffer, mime: deps.canonical.artifact.mime },
          cardinalAnchor: { buffer: deps.cardinalAnchor.buffer, mime: deps.cardinalAnchor.artifact.mime },
          registeredLookA: deps.references.registeredLookAReference,
          standardContact: deps.standardContact,
          layout: deps.layout,
          diagnosticBoard,
        }),
        columns: 4,
        rows: 2,
        frameCount: 8,
        frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
        progress: options.progress,
        qaKind: "directions",
        qaContext: "修复方向 180 到 337.5 的完整连续动作组",
        workflowStage: options.workflowStage,
        animationDurations: petRowSpec("look-b").durations,
        force: true,
        repairHint: hint,
      });
      state.registered = await registerDirectionRow(ctx, {
        row: "look-b",
        source: state.row,
        neutral: deps.neutral,
        lockedRow9: deps.lockedRow9,
        progress: options.registerProgress,
      });
      state.gate = await reviewSecondLookRow(ctx, {
        look: state.registered,
        previousLook: deps.lockedRow9,
        canonical: deps.canonical,
        standardContact: deps.standardContact,
        cardinalAnchor: deps.cardinalAnchor,
      });
    },
  });
}
