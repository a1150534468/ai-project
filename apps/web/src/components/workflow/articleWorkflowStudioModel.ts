import type { ArticleWorkflowImageAsset } from "@ai-assistant/article-workflow";
import type {
  ArticleWorkflowPricingRow,
  ArticleWorkflowProject,
  ArticleWorkflowProjectSummary,
} from "../../workflowArticleApi";

export interface ArticleWorkflowStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
  readonly initialHistory?: readonly ArticleWorkflowProjectSummary[];
  readonly initialProject?: ArticleWorkflowProject | null;
  readonly initialBootstrapping?: boolean;
}

export function isBusyArticleWorkflowStatus(status: string | null | undefined): boolean {
  return status === "generating" || status === "revising";
}

/**
 * 保存只允许发生在已有成品的行上，与后端 PATCH 的 409 判定保持一致。
 * failed 行放开保存的话，编辑器打开就自动存一次空正文，把状态刷成 ready、失败原因也没了。
 */
export function canSaveArticleWorkflowStatus(status: string | null | undefined): boolean {
  return status === "ready";
}

export function formatArticleWorkflowStatus(status: string): string {
  switch (status) {
    case "draft":
      return "草稿";
    case "generating":
      return "生成中";
    case "revising":
      return "改稿中";
    case "ready":
      return "可编辑";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

export function formatArticleWorkflowTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
}

export function articleWorkflowPricingText(
  row: ArticleWorkflowPricingRow | null | undefined,
  fallback: string,
): string {
  if (!row) return fallback;
  return row.pricingType === "PER_UNIT"
    ? `每 ${row.perUnits} 单位 ${row.rate} 点`
    : `${row.rate} 点/次`;
}

export function cloneImageManifest(imageManifest: readonly ArticleWorkflowImageAsset[]): readonly ArticleWorkflowImageAsset[] {
  return JSON.parse(JSON.stringify(imageManifest)) as readonly ArticleWorkflowImageAsset[];
}

/** 自动保存的脏判定基准；caption 字段也要进来，否则改文案不会触发保存 */
/**
 * 配图地址上的短期签名不算内容。
 *
 * 服务端每次出参都会给图片地址现签一份（`exp` 每次都不一样），保存的响应也是。
 * 不摘掉签名的话：编辑器手里是上一份签名、基线换成了新签名，两边永远不等，
 * 于是这行永远「脏」着，自动保存每 1.5 秒撞一次——恰恰是我们特意去掉的行为。
 */
function withoutImageSignature(html: string): string {
  return html.replace(
    /(\/api\/workflow\/article-workflow\/images\/[A-Za-z0-9%._~-]+\/blob)\?[^\s"'<>]*/g,
    "$1",
  );
}

export function articleWorkflowDraftHash(args: {
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
  readonly captionText?: string;
  readonly tags?: readonly string[];
}): string {
  return JSON.stringify([
    args.title.trim(),
    args.summary.trim(),
    withoutImageSignature(args.bodyHtml.trim()),
    (args.captionText ?? "").trim(),
    (args.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
  ]);
}
