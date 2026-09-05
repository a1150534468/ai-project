/**
 * 多平台图文工作区的纯函数与判定。三处收掉的：
 *  - **状态文案从 `switch` 收成一张表**，与下面 busy 那组判定用同一份词表口口相对；
 *  - **`Intl.DateTimeFormat` 提到模块级**，原来每渲染一行历史就现造一个格式化器；
 *  - **`cloneImageManifest` 换成 `structuredClone`**，`JSON.parse(JSON.stringify())` 只是
 *    当年没有这个 API 时的写法。
 *
 * 另外把一句挂错地方的注释挪回它说的那个函数：「自动保存的脏判定基准」讲的是
 * `articleWorkflowDraftHash`，原来贴在 `withoutImageSignature` 头上。
 */
import type { ArticleWorkflowImageAsset } from "@ai-assistant/article-workflow";
import type { ArticleWorkflowProject, ArticleWorkflowProjectSummary } from "../../workflowArticleApi";

export interface ArticleWorkflowStudioProps {
  readonly token: string;
  readonly initialHistory?: readonly ArticleWorkflowProjectSummary[];
  readonly initialProject?: ArticleWorkflowProject | null;
  readonly initialBootstrapping?: boolean;
}

/** 服务端还在写这一行的两档，前端只能等：轮询继续、编辑器与保存都锁着。 */
const BUSY_STATUSES = new Set(["generating", "revising"]);

export function isBusyArticleWorkflowStatus(status: string | null | undefined): boolean {
  return BUSY_STATUSES.has(status ?? "");
}

/**
 * 保存只允许发生在已有成品的行上，与后端 PATCH 的 409 判定保持一致。
 * failed 行放开保存的话，编辑器打开就自动存一次空正文，把状态刷成 ready、失败原因也没了。
 */
export function canSaveArticleWorkflowStatus(status: string | null | undefined): boolean {
  return status === "ready";
}

/**
 * 「这一行还缺图」：出完稿了，但 manifest 里还有槽位没有地址。
 * 后补配图挑目标、工具栏上那个「还差几个平台」的角标，用的都是这一句。
 */
export function needsArticleWorkflowImages(project: ArticleWorkflowProject): boolean {
  return project.status === "ready" && project.imageManifestJson.some((image) => !image.imageUrl.trim());
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  generating: "生成中",
  revising: "改稿中",
  ready: "可编辑",
  failed: "失败",
};

/** 认不出来的状态原样显示 —— 服务端加了新档位时，界面上看到的是那个原文而不是空白。 */
export function formatArticleWorkflowStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatArticleWorkflowTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TIME_FORMAT.format(date);
}

/** 编辑器要一份能随便改的副本，改动落在草稿里而不是原项目上。 */
export function cloneImageManifest(
  imageManifest: readonly ArticleWorkflowImageAsset[],
): readonly ArticleWorkflowImageAsset[] {
  return structuredClone(imageManifest) as ArticleWorkflowImageAsset[];
}

/**
 * 配图地址上的短期签名不算内容。
 *
 * 服务端每次出参都会给图片地址现签一份（`exp` 每次都不一样），保存的响应也是。
 * 不摘掉签名的话：编辑器手里是上一份签名、基线换成了新签名，两边永远不等，
 * 于是这行永远「脏」着，自动保存每 1.5 秒撞一次 —— 恰恰是我们特意去掉的行为。
 */
function withoutImageSignature(html: string): string {
  return html.replace(/(\/api\/workflow\/article-workflow\/images\/[A-Za-z0-9%._~-]+\/blob)\?[^\s"'<>]*/g, "$1");
}

/** 自动保存的脏判定基准。caption 与 tags 也要进来，否则改了文案不会触发保存。 */
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
