import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowProjectStatus,
} from "@ai-assistant/article-workflow";
import type {
  ArticleWorkflowPricing,
  ArticleWorkflowPricingRow,
  ArticleWorkflowProject,
} from "../../workflowArticleApi";

export interface ArticleWorkflowStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
  readonly initialHistory?: readonly {
    id: string;
    title: string;
    summary: string;
    generationMode: ArticleWorkflowGenerationMode;
    status: ArticleWorkflowProjectStatus;
    progressStage: string;
    progressPercent: number;
    progressMessage: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
  readonly initialProject?: ArticleWorkflowProject | null;
  readonly initialBootstrapping?: boolean;
}

export function isBusyArticleWorkflowStatus(status: string | null | undefined): boolean {
  return status === "generating" || status === "revising";
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

export function articleWorkflowDraftHash(args: {
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
}): string {
  return JSON.stringify([
    args.title.trim(),
    args.summary.trim(),
    args.bodyHtml.trim(),
  ]);
}
