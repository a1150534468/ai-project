/**
 * 文档状态与体积文案的唯一出处。这两件事页面上有三处在用（徽标、轮询判定、列表元信息），
 * 原来各写一遍：徽标是四个并排的 `status === "…"` 判断，落在名单外的状态整个徽标只剩个图标；
 * 体积那份在 1 TB 以上会跳出单位表。
 */
import type { BadgeTone } from "../ui";
import type { KbDocument } from "../../kbApi";

type KbDocumentStatus = KbDocument["status"];

export interface KbStatusMeta {
  readonly label: string;
  readonly tone: BadgeTone;
  readonly icon: string;
  /** 图标要不要转。排队中的文档还没落地，但它那只钟不该转 */
  readonly spin: boolean;
  /** false = 还在索引流水线上，页面得继续轮询 */
  readonly settled: boolean;
}

const STATUS: Record<KbDocumentStatus, KbStatusMeta> = {
  pending: { label: "待处理", tone: "neutral", icon: "mdi:clock-outline", spin: false, settled: false },
  indexing: { label: "索引中", tone: "warning", icon: "mdi:loading", spin: true, settled: false },
  indexed: { label: "已建立知识晶格链接", tone: "brand", icon: "mdi:check-circle", spin: false, settled: true },
  failed: { label: "失败", tone: "danger", icon: "mdi:alert-circle", spin: false, settled: true },
};

/**
 * 认不出来的状态按「待处理」显示。接口的类型标注说只会是这四个值之一，但那是标注不是保证，
 * 真回来个别的，页面得有话说。
 */
export function kbStatusMeta(status: string): KbStatusMeta {
  return STATUS[status as KbDocumentStatus] ?? STATUS.pending;
}

/** 还在索引流水线上 —— 轮询要盯的就是这些。 */
export function isIndexing(document: KbDocument): boolean {
  return !kbStatusMeta(document.status).settled;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 字节数变人话：只有 B 取整，往上都留一位小数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${UNITS[0]}`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? Math.round(value) : Math.round(value * 10) / 10} ${UNITS[unit]}`;
}
