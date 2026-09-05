import {
  ARTICLE_WORKFLOW_PLATFORMS,
  articleWorkflowPlatformConfig,
  type ArticleWorkflowPlatform,
} from "@ai-assistant/article-workflow";
import type { ArticleWorkflowProject, ArticleWorkflowProjectSummary } from "../../workflowArticleApi";
import { isBusyArticleWorkflowStatus } from "./articleWorkflowStudioModel";

export type ArticleWorkflowBatchStatus = "busy" | "ready" | "failed";

export interface ArticleWorkflowBatchEntry {
  /** 存量单项目行没有批次，为 null */
  readonly batchId: string | null;
  /** 列表 key 与选中标识；无批次时用 project:${id} 自成一批 */
  readonly key: string;
  /** 打开这一批时的落点项目 */
  readonly projectId: string;
  readonly title: string;
  readonly summary: string;
  readonly platforms: readonly ArticleWorkflowPlatform[];
  readonly status: ArticleWorkflowBatchStatus;
  readonly updatedAt: string;
}

export function platformLabel(platform: string): string {
  return articleWorkflowPlatformConfig(platform).label;
}

/** 短标签：页签与历史列表里用，避免「微信公众号」把行挤满 */
export function shortPlatformLabel(platform: string): string {
  switch (platform) {
    case "wechat":
      return "公众号";
    case "xiaohongshu":
      return "小红书";
    case "douyin":
      return "抖音";
    default:
      return platformLabel(platform);
  }
}

function platformOrder(platform: string): number {
  const index = ARTICLE_WORKFLOW_PLATFORMS.indexOf(platform as ArticleWorkflowPlatform);
  return index === -1 ? ARTICLE_WORKFLOW_PLATFORMS.length : index;
}

function batchStatus(rows: readonly ArticleWorkflowProjectSummary[]): ArticleWorkflowBatchStatus {
  if (rows.some((row) => isBusyArticleWorkflowStatus(row.status))) return "busy";
  if (rows.every((row) => row.status === "ready")) return "ready";
  return "failed";
}

/** 批次标题优先取公众号行，其次任一已完成行，最后退回第一行——空标题不算数 */
function batchTitleRow(rows: readonly ArticleWorkflowProjectSummary[]): ArticleWorkflowProjectSummary {
  const titled = rows.filter((row) => row.title.trim().length > 0);
  const pool = titled.length > 0 ? titled : rows;
  return pool.find((row) => row.platform === "wechat")
    ?? pool.find((row) => row.status === "ready")
    ?? pool[0]!;
}

/**
 * 侧栏行的身份。存量项目没有 `batchId`（多平台之前建的），只能拿自己的 id 当一批。
 * 主控判断「点的是不是当前这批」用的是同一个键，所以这句只能有一份。
 */
export function articleWorkflowBatchKey(row: { readonly id: string; readonly batchId: string | null }): string {
  return row.batchId ? `batch:${row.batchId}` : `project:${row.id}`;
}

export function groupArticleWorkflowHistory(
  rows: readonly ArticleWorkflowProjectSummary[],
): readonly ArticleWorkflowBatchEntry[] {
  const buckets = new Map<string, ArticleWorkflowProjectSummary[]>();
  for (const row of rows) {
    const key = articleWorkflowBatchKey(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const entries = [...buckets.entries()].map(([key, bucket]) => {
    const ordered = [...bucket].sort((left, right) => platformOrder(left.platform) - platformOrder(right.platform));
    const titleRow = batchTitleRow(ordered);
    // 批次时间取最新一行，保证任一平台有动静都会把这批顶上去
    const updatedAt = ordered.reduce(
      (latest, row) => (row.updatedAt > latest ? row.updatedAt : latest),
      ordered[0]!.updatedAt,
    );
    return {
      batchId: ordered[0]!.batchId,
      key,
      projectId: titleRow.id,
      title: titleRow.title,
      summary: titleRow.summary,
      platforms: ordered.map((row) => row.platform),
      status: batchStatus(ordered),
      updatedAt,
    } satisfies ArticleWorkflowBatchEntry;
  });

  return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export interface ArticleWorkflowBatchProgress {
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
}

export function articleWorkflowBatchProgress(
  projects: readonly ArticleWorkflowProjectSummary[],
): ArticleWorkflowBatchProgress {
  const total = projects.length;
  const completed = projects.filter((row) => !isBusyArticleWorkflowStatus(row.status)).length;
  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

/** 批次内选中平台的落点：优先选中的平台，其次第一个已完成的，最后第一行 */
export function resolveActiveArticleWorkflowProject(
  projects: readonly ArticleWorkflowProject[],
  activePlatform: ArticleWorkflowPlatform | null,
): ArticleWorkflowProject | null {
  if (projects.length === 0) return null;
  return projects.find((item) => item.platform === activePlatform)
    ?? projects.find((item) => item.status === "ready")
    ?? projects[0]!;
}
