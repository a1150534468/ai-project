/**
 * 图文工坊的草稿层:五个按平台分桶的草稿记录 + 脏标记 + 「上次保存的 hash」基线。
 *
 * 从 `useArticleWorkflowStudio.ts` 原样搬出,三条不能动的规则一并搬来:
 *  - **草稿和脏标记都按平台分桶**。切页签不能把别的平台的未保存改动一起提交。
 *  - **脏标记按内容判定,不按「有没有触发过 onChange」**。编辑器载入时对 HTML 做的规范化
 *    也会走 onChange,无条件打脏会让 1.5s 后的自动保存把成品冲掉。
 *  - **只有 ready 行能打脏标记**。failed / 生成中的行打了也存不进去(后端一律 409),
 *    结果是挂着「待保存」每 1.5 秒撞一次。
 */
import { useCallback, useRef, useState } from "react";
import type { ArticleWorkflowPlatform } from "@ai-assistant/article-workflow";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";
import {
  articleWorkflowDraftHash,
  canSaveArticleWorkflowStatus,
  isBusyArticleWorkflowStatus,
} from "./articleWorkflowStudioModel";

type PlatformRecord<T> = Partial<Record<ArticleWorkflowPlatform, T>>;
type DraftRecord = PlatformRecord<string>;
type TagsRecord = PlatformRecord<readonly string[]>;

export interface ArticleWorkflowDraftValues {
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
  readonly captionText: string;
  readonly tags: readonly string[];
}

export type ArticleWorkflowDraftPatch = Partial<ArticleWorkflowDraftValues>;

export function articleWorkflowProjectHash(project: ArticleWorkflowProject): string {
  return articleWorkflowDraftHash({
    title: project.title,
    summary: project.summary,
    bodyHtml: project.bodyHtml,
    captionText: project.captionText,
    tags: project.tags,
  });
}

function seed<T>(
  project: ArticleWorkflowProject | null,
  pick: (project: ArticleWorkflowProject) => T,
): PlatformRecord<T> {
  return project ? { [project.platform]: pick(project) } : {};
}

export function useArticleWorkflowDrafts(args: {
  readonly initialProject: ArticleWorkflowProject | null;
  readonly batchProjects: readonly ArticleWorkflowProject[];
}) {
  const { initialProject, batchProjects } = args;
  /** 每个平台各自记住上次保存的 hash，切页签不会互相误判脏 */
  const lastSavedHashRef = useRef(new Map<ArticleWorkflowPlatform, string>());
  /** 轮询回调里要读最新脏状态，用 ref 避免把轮询 effect 绑到 state 上反复重建 */
  const dirtyPlatformsRef = useRef<readonly ArticleWorkflowPlatform[]>([]);
  const [titleDrafts, setTitleDrafts] = useState<DraftRecord>(seed(initialProject, (item) => item.title));
  const [summaryDrafts, setSummaryDrafts] = useState<DraftRecord>(seed(initialProject, (item) => item.summary));
  const [bodyHtmlDrafts, setBodyHtmlDrafts] = useState<DraftRecord>(seed(initialProject, (item) => item.bodyHtml));
  const [captionDrafts, setCaptionDrafts] = useState<DraftRecord>(seed(initialProject, (item) => item.captionText));
  const [tagsDrafts, setTagsDrafts] = useState<TagsRecord>(seed(initialProject, (item) => item.tags));
  /** 脏标记按平台记，避免切页签后把别的平台的未保存改动一起提交 */
  const [dirtyPlatforms, setDirtyPlatforms] = useState<readonly ArticleWorkflowPlatform[]>([]);

  dirtyPlatformsRef.current = dirtyPlatforms;

  const markDirtyRaw = useCallback((target: ArticleWorkflowPlatform, next: boolean) => {
    // 两个分支都要在「状态没变」时把原数组原样返回：撤脏是热路径（每次 onChange 都会走一遍），
    // 每次都造新数组等于每次都多一轮渲染
    setDirtyPlatforms((current) => {
      if (next) return current.includes(target) ? current : [...current, target];
      return current.includes(target) ? current.filter((item) => item !== target) : current;
    });
  }, []);

  /** 打脏标记要看这行存不存得下去：failed / 生成中的行不打，免得挂着「待保存」又永远存不进 */
  const markDirty = useCallback(
    (target: ArticleWorkflowPlatform, next: boolean) => {
      if (next && !canSaveArticleWorkflowStatus(batchProjects.find((item) => item.platform === target)?.status)) return;
      markDirtyRaw(target, next);
    },
    [batchProjects, markDirtyRaw],
  );

  const draftsFor = useCallback(
    (platform: ArticleWorkflowPlatform): ArticleWorkflowDraftValues => ({
      title: titleDrafts[platform] ?? "",
      summary: summaryDrafts[platform] ?? "",
      bodyHtml: bodyHtmlDrafts[platform] ?? "",
      captionText: captionDrafts[platform] ?? "",
      tags: tagsDrafts[platform] ?? [],
    }),
    [bodyHtmlDrafts, captionDrafts, summaryDrafts, tagsDrafts, titleDrafts],
  );

  const writeDrafts = useCallback((target: ArticleWorkflowPlatform, patch: ArticleWorkflowDraftPatch) => {
    if (patch.title !== undefined) setTitleDrafts((current) => ({ ...current, [target]: patch.title }));
    if (patch.summary !== undefined) setSummaryDrafts((current) => ({ ...current, [target]: patch.summary }));
    if (patch.bodyHtml !== undefined) setBodyHtmlDrafts((current) => ({ ...current, [target]: patch.bodyHtml }));
    if (patch.captionText !== undefined) setCaptionDrafts((current) => ({ ...current, [target]: patch.captionText }));
    if (patch.tags !== undefined) setTagsDrafts((current) => ({ ...current, [target]: patch.tags }));
  }, []);

  const hashOf = useCallback((target: ArticleWorkflowPlatform) => lastSavedHashRef.current.get(target), []);

  /** 把这一行的服务端值定为新基线，并撤掉它的脏标记 */
  const noteSaved = useCallback(
    (project: ArticleWorkflowProject) => {
      const hash = articleWorkflowProjectHash(project);
      lastSavedHashRef.current.set(project.platform, hash);
      markDirtyRaw(project.platform, false);
      return hash;
    },
    [markDirtyRaw],
  );

  /**
   * 按内容决定脏标记，而不是按「有没有触发过 onChange」。
   *
   * 早先每次 onChange 都无条件打脏，1.5s 后自动保存就发车。于是编辑器载入时对
   * HTML 做的规范化（它不认识的标签被拍平）也被当成用户编辑存回库里，成品被冲掉。
   * 现在拿完整草稿的 hash 跟「上次保存的 hash」比：一致就撤脏标记，自动保存不发车；
   * 用户把内容改回原样也会自动退出待保存状态。
   *
   * 注意这只挡住「内容没变」的那一类。编辑器把内容真改了（规范化就属于这种）
   * hash 一定不同，仍然会存——那一层要靠编辑器自己只在用户真操作时才 onChange。
   */
  const syncDirtyByContent = useCallback(
    (target: ArticleWorkflowPlatform, override: ArticleWorkflowDraftPatch) => {
      const current = draftsFor(target);
      const nextHash = articleWorkflowDraftHash({
        title: override.title ?? current.title,
        summary: override.summary ?? current.summary,
        bodyHtml: override.bodyHtml ?? current.bodyHtml,
        captionText: override.captionText ?? current.captionText,
        tags: override.tags ?? current.tags,
      });
      markDirty(target, nextHash !== lastSavedHashRef.current.get(target));
    },
    [draftsFor, markDirty],
  );

  /** 编辑器回调的统一入口：先写草稿，再按内容重判脏 */
  const editDraft = useCallback(
    (target: ArticleWorkflowPlatform, patch: ArticleWorkflowDraftPatch) => {
      writeDrafts(target, patch);
      syncDirtyByContent(target, patch);
    },
    [syncDirtyByContent, writeDrafts],
  );

  /**
   * 把批次的服务端值写回草稿。
   * force=false 时保留仍在编辑的平台草稿（生成中的行没有用户改动，一律覆盖）。
   */
  const hydrateDrafts = useCallback((details: readonly ArticleWorkflowProject[], force: boolean) => {
    const nextTitles: DraftRecord = {};
    const nextSummaries: DraftRecord = {};
    const nextBodies: DraftRecord = {};
    const nextCaptions: DraftRecord = {};
    const nextTags: TagsRecord = {};
    const keptDirty: ArticleWorkflowPlatform[] = [];
    for (const detail of details) {
      const overwrite =
        force || isBusyArticleWorkflowStatus(detail.status) || !dirtyPlatformsRef.current.includes(detail.platform);
      if (!overwrite) {
        keptDirty.push(detail.platform);
        continue;
      }
      nextTitles[detail.platform] = detail.title;
      nextSummaries[detail.platform] = detail.summary;
      nextBodies[detail.platform] = detail.bodyHtml;
      nextCaptions[detail.platform] = detail.captionText;
      nextTags[detail.platform] = detail.tags;
      lastSavedHashRef.current.set(detail.platform, articleWorkflowProjectHash(detail));
    }
    setTitleDrafts((current) => ({ ...current, ...nextTitles }));
    setSummaryDrafts((current) => ({ ...current, ...nextSummaries }));
    setBodyHtmlDrafts((current) => ({ ...current, ...nextBodies }));
    setCaptionDrafts((current) => ({ ...current, ...nextCaptions }));
    setTagsDrafts((current) => ({ ...current, ...nextTags }));
    setDirtyPlatforms((current) => current.filter((item) => keptDirty.includes(item)));
  }, []);

  /** 切项目前先把脏标记清干净：ref 也要同步，轮询回调下一拍就要读它 */
  const clearDirty = useCallback(() => {
    setDirtyPlatforms([]);
    dirtyPlatformsRef.current = [];
  }, []);

  const resetDrafts = useCallback(() => {
    setTitleDrafts({});
    setSummaryDrafts({});
    setBodyHtmlDrafts({});
    setCaptionDrafts({});
    setTagsDrafts({});
    lastSavedHashRef.current.clear();
    setDirtyPlatforms([]);
  }, []);

  return {
    dirtyPlatforms,
    dirtyPlatformsRef,
    draftsFor,
    hashOf,
    noteSaved,
    writeDrafts,
    editDraft,
    syncDirtyByContent,
    markDirty,
    hydrateDrafts,
    clearDirty,
    resetDrafts,
  };
}
