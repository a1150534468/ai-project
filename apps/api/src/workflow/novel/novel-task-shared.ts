/**
 * novel-task-runner 拆分后的共享契约层:计费窄接口、任务行形状,以及被 persist / run
 * 两侧共用的四个叶子小工具。
 *
 * `BillingForNovels` 里 `reserveResource` 的 `reservationTtlSeconds?` 是可选的,但小说链路
 * 必须传 —— 预留在建单时就下,结算却要等 worker 生成完,不声明有效期会被 billing 的 10 分钟
 * 兜底按 actual=0 关账,之后 settle 静默返回 0(见 novel-reservation-window.ts)。
 *
 * `jsonValue` 把 null/undefined 归一成 `Prisma.JsonNull`:直接把 undefined 塞进 prisma 的
 * JSON 列会在运行时才炸,而这里是编译期就拦住的唯一位置。
 *
 * `estimateReserveChars` 给的是**预留**字数,不是最终计费字数 —— 最终按
 * `billableCharCount(实际产出)` 结算。两者故意不共用一套上下限。
 *
 * 依赖方向:本文件是叶子。不 import 同域拆分出的任何文件。
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { type NovelSetupTargetKind, type NovelTargetKind } from "./novel-types.js";
import { isPlainObject } from "../../runtime/records.js";
import type { NovelPlatformModel } from "./novel-models.js";

export interface BillingForNovels {
  reserveResource: (args: { operationId: string; userId: string; resourceKey: string; units: number; reservationTtlSeconds?: number }) => Promise<{ reserved: number }>;
  settleResource: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
  listModels?: () => Promise<{ data: NovelPlatformModel[] }>;
}

export interface NovelTaskRow {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly operationId: string;
  readonly status: string;
  readonly progressPercent: number;
  readonly progressStage: string;
  readonly progressMessage: string | null;
  readonly progressPreview: string;
  readonly streamedChars: number;
  readonly requestPayload: Prisma.JsonValue | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
}

export function jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export function taskPayload(task: NovelTaskRow): Record<string, unknown> {
  return isPlainObject(task.requestPayload) ? task.requestPayload : {};
}

export function estimateReserveChars(targetKind: NovelTargetKind, targetChars?: number, _targetCount?: number): number {
  if (targetKind === "chapter") return Math.max(1000, Math.min(targetChars ?? 3000, 12000));
  if (targetKind === "chapterRewrite") return Math.max(200, Math.min(targetChars ?? 500, 6000));
  if (targetKind === "setupPlot") return 16_000;
  return 10_000;
}

export function isSetupTargetKind(kind: NovelTargetKind): kind is NovelSetupTargetKind {
  return kind === "setupBible" || kind === "setupCharacters" || kind === "setupLocations" || kind === "setupPlot";
}

export function operationId(): string {
  return `novel:${randomUUID()}`;
}
