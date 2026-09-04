/**
 * novel-task-runner 拆分后的共享契约层:任务行形状,以及被 persist / run 两侧共用的四个
 * 叶子小工具。
 *
 * `jsonValue` 把 null/undefined 归一成 `Prisma.JsonNull`:直接把 undefined 塞进 prisma 的
 * JSON 列会在运行时才炸,而这里是编译期就拦住的唯一位置。
 *
 * 依赖方向:本文件是叶子。不 import 同域拆分出的任何文件。
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { type NovelSetupTargetKind, type NovelTargetKind } from "./novel-types.js";
import { isPlainObject } from "../../runtime/records.js";

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

export function isSetupTargetKind(kind: NovelTargetKind): kind is NovelSetupTargetKind {
  return kind === "setupBible" || kind === "setupCharacters" || kind === "setupLocations" || kind === "setupPlot";
}

export function operationId(): string {
  return `novel:${randomUUID()}`;
}
