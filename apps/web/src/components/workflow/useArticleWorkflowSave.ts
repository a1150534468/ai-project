/**
 * 图文工坊的保存层:手动保存 + 1.5s 自动保存,以及保存撞上 409 的竞态处理。
 *
 * 从 `useArticleWorkflowStudio.ts` 原样搬出。三条不能动的规则:
 *  - **只有 ready 行能存**,与后端 PATCH 的 409 判定一致。failed 行放开的话,编辑器一打开
 *    就每 1.5s 撞一次 409。
 *  - **内容没变就不发车**。hash 与「上次保存的基线」一致时直接返回成功,不打接口。
 *  - **409 不当报错弹**。那意味着提交途中这行在服务端变成了 failed / 生成中,
 *    静默撤脏并刷一次这行状态就够了。
 *
 * 草稿一律以**五个原始值**传入而不是打包成对象:对象每次渲染都是新身份,会把自动保存的
 * 1.5s 计时器在每次渲染时重置掉——批次轮询每 2.5s 回填一次,那就等于自动保存永不发车。
 */
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../apiError";
import { articleWorkflowPlatformConfig, type ArticleWorkflowPlatform } from "@ai-assistant/article-workflow";
import { ApiError } from "../../apiError";
import {
  getArticleWorkflowProject,
  updateArticleWorkflowProject,
  type ArticleWorkflowProject,
} from "../../workflowArticleApi";
import { articleWorkflowDraftHash, canSaveArticleWorkflowStatus } from "./articleWorkflowStudioModel";

const AUTOSAVE_DELAY_MS = 1500;

export function useArticleWorkflowSave(args: {
  readonly token: string;
  readonly project: ArticleWorkflowProject | null;
  readonly titleDraft: string;
  readonly summaryDraft: string;
  readonly bodyHtmlDraft: string;
  readonly captionDraft: string;
  readonly tagsDraft: readonly string[];
  readonly dirty: boolean;
  readonly rewriting: boolean;
  readonly hashOf: (platform: ArticleWorkflowPlatform) => string | undefined;
  readonly markDirty: (platform: ArticleWorkflowPlatform, next: boolean) => void;
  readonly noteSaved: (project: ArticleWorkflowProject) => string;
  readonly replaceProjectRow: (project: ArticleWorkflowProject) => void;
  readonly refreshHistory: () => Promise<void>;
  readonly setError: (value: string) => void;
  readonly setNotice: (value: string) => void;
  readonly toast: { readonly show: (kind: "ok" | "err", text: string) => void };
}) {
  const {
    token, project, titleDraft, summaryDraft, bodyHtmlDraft, captionDraft, tagsDraft,
    dirty, rewriting, hashOf, markDirty, noteSaved, replaceProjectRow, refreshHistory,
    setError, setNotice, toast,
  } = args;
  const [saving, setSaving] = useState(false);

  const saveProject = useCallback(
    async (mode: "manual" | "auto" = "manual"): Promise<boolean> => {
      if (!project) return false;
      const target = project.platform;
      // 兜底：后端对非 ready 行一律 409，这里先拦住，别让失败行被自动保存反复撞
      if (!canSaveArticleWorkflowStatus(project.status)) {
        markDirty(target, false);
        return false;
      }
      const nextHash = articleWorkflowDraftHash({
        title: titleDraft,
        summary: summaryDraft,
        bodyHtml: bodyHtmlDraft,
        captionText: captionDraft,
        tags: tagsDraft,
      });
      if (nextHash === hashOf(target)) {
        markDirty(target, false);
        return true;
      }
      setSaving(true);
      setError("");
      if (mode === "manual") setNotice("");
      try {
        const isCaption = articleWorkflowPlatformConfig(target).outputKind === "caption";
        const saved = await updateArticleWorkflowProject(
          token,
          project.id,
          isCaption
            ? {
                title: titleDraft.trim(),
                summary: summaryDraft.trim(),
                captionText: captionDraft.trim(),
                tags: tagsDraft.map((tag) => tag.trim()).filter(Boolean),
              }
            : {
                title: titleDraft.trim(),
                summary: summaryDraft.trim(),
                bodyHtml: bodyHtmlDraft.trim(),
              },
        );
        replaceProjectRow(saved);
        noteSaved(saved);
        setNotice(mode === "auto" ? "已自动保存" : "已保存修改");
        if (mode === "manual") toast.show("ok", "已保存修改");
        await refreshHistory();
        return true;
      } catch (err) {
        // 竞态：提交途中这行在服务端变成了 failed / 生成中。不当报错弹，静默刷一次这行状态
        if (err instanceof ApiError && err.status === 409) {
          markDirty(target, false);
          const latest = await getArticleWorkflowProject(token, project.id).catch(() => null);
          if (latest) replaceProjectRow(latest);
          return false;
        }
        const message = errorMessage(err, "保存失败");
        setError(message);
        toast.show("err", message);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [
      bodyHtmlDraft,
      captionDraft,
      hashOf,
      markDirty,
      noteSaved,
      project,
      refreshHistory,
      replaceProjectRow,
      setError,
      setNotice,
      summaryDraft,
      tagsDraft,
      titleDraft,
      toast,
      token,
    ],
  );

  // 只有 ready 行自动保存：failed 行放开的话，编辑器一打开就每 1.5s 撞一次 409
  useEffect(() => {
    if (!project || !dirty || saving || rewriting || !canSaveArticleWorkflowStatus(project.status)) return undefined;
    const timer = window.setTimeout(() => {
      void saveProject("auto");
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, project, rewriting, saveProject, saving]);

  return { saving, saveProject };
}
