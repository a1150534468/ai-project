import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowSourceFormat,
} from "@yc/article-workflow";
import { useToast } from "../../motion";
import {
  createArticleWorkflowProject,
  getArticleWorkflowPricing,
  getArticleWorkflowProject,
  listArticleWorkflowHistory,
  regenerateArticleWorkflowImage,
  rewriteArticleWorkflowProject,
  type ArticleWorkflowPricing,
  type ArticleWorkflowProject,
  type ArticleWorkflowProjectSummary,
  updateArticleWorkflowProject,
} from "../../workflowArticleApi";
import { createArticleWorkflowCopyActions } from "./articleWorkflowCopyActions";
import type { ArticleWorkflowStudioProps } from "./articleWorkflowStudioModel";
import {
  articleWorkflowDraftHash,
  cloneImageManifest,
  isBusyArticleWorkflowStatus,
} from "./articleWorkflowStudioModel";

const AUTOSAVE_DELAY_MS = 1500;

export function useArticleWorkflowStudio({
  token,
  onBalanceRefresh,
  initialHistory,
  initialProject = null,
  initialBootstrapping,
}: ArticleWorkflowStudioProps) {
  const toast = useToast();
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const lastSavedHashRef = useRef("");
  const [editorSyncKey, setEditorSyncKey] = useState("");
  const [bootstrapping, setBootstrapping] = useState(initialBootstrapping ?? !initialHistory);
  const [history, setHistory] = useState<readonly ArticleWorkflowProjectSummary[]>(initialHistory ?? []);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProject?.id ?? null);
  const [project, setProject] = useState<ArticleWorkflowProject | null>(initialProject);
  const [pricing, setPricing] = useState<ArticleWorkflowPricing | null>(null);
  const [titleDraft, setTitleDraft] = useState(initialProject?.title ?? "");
  const [summaryDraft, setSummaryDraft] = useState(initialProject?.summary ?? "");
  const [bodyHtmlDraft, setBodyHtmlDraft] = useState(initialProject?.bodyHtml ?? "");
  const [sourceFormat, setSourceFormat] = useState<ArticleWorkflowSourceFormat>("plain-text");
  const [generationMode, setGenerationMode] = useState<ArticleWorkflowGenerationMode>("preserve-text");
  const [sourceText, setSourceText] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [regeneratingSlot, setRegeneratingSlot] = useState<string | null>(null);
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [rewriteGenerationMode, setRewriteGenerationMode] = useState<ArticleWorkflowGenerationMode>(initialProject?.generationMode ?? "preserve-text");
  const [rewriteRegenerateImages, setRewriteRegenerateImages] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);

  const hydrateProject = useCallback((detail: ArticleWorkflowProject, force = true) => {
    const nextHash = articleWorkflowDraftHash({
      title: detail.title,
      summary: detail.summary,
      bodyHtml: detail.bodyHtml,
    });
    setProject({
      ...detail,
      imageManifestJson: cloneImageManifest(detail.imageManifestJson),
    });
    setSelectedProjectId(detail.id);
    if (force || !dirty || isBusyArticleWorkflowStatus(detail.status)) {
      setTitleDraft(detail.title);
      setSummaryDraft(detail.summary);
      setBodyHtmlDraft(detail.bodyHtml);
      setRewriteGenerationMode(detail.generationMode);
      setDirty(false);
      lastSavedHashRef.current = nextHash;
      setEditorSyncKey(`${detail.id}:${nextHash}`);
    }
    return detail;
  }, [dirty]);

  const resetMessages = () => {
    setError("");
    setNotice("");
  };

  const refreshHistory = useCallback(async () => {
    setHistory(await listArticleWorkflowHistory(token));
  }, [token]);

  const refreshPricing = useCallback(async () => {
    try {
      setPricing(await getArticleWorkflowPricing(token));
    } catch {
      setPricing(null);
    }
  }, [token]);

  const loadProject = useCallback(async (projectId: string, force = true) => {
    const detail = await getArticleWorkflowProject(token, projectId);
    return hydrateProject(detail, force);
  }, [hydrateProject, token]);

  useEffect(() => {
    if (initialProject) {
      lastSavedHashRef.current = articleWorkflowDraftHash({
        title: initialProject.title,
        summary: initialProject.summary,
        bodyHtml: initialProject.bodyHtml,
      });
      setEditorSyncKey(`${initialProject.id}:${lastSavedHashRef.current}`);
    }
  }, [initialProject]);

  useEffect(() => {
    if (initialHistory) {
      setBootstrapping(false);
      void refreshPricing();
      return;
    }
    void (async () => {
      try {
        await Promise.all([refreshHistory(), refreshPricing()]);
      } catch {
        setError("加载公众号图文工作台失败");
      } finally {
        setBootstrapping(false);
      }
    })();
  }, [initialHistory, refreshHistory, refreshPricing]);

  useEffect(() => {
    if (!project || !isBusyArticleWorkflowStatus(project.status)) return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const detail = await getArticleWorkflowProject(token, project.id);
          hydrateProject(detail, true);
          await refreshHistory();
          if (!isBusyArticleWorkflowStatus(detail.status)) {
            setNotice(detail.progressMessage || (detail.status === "failed" ? "图文处理失败" : "图文已生成完成"));
            onBalanceRefresh?.();
          }
          if (detail.status === "failed") {
            setError(detail.error || "图文处理失败");
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : "刷新项目失败");
        }
      })();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hydrateProject, onBalanceRefresh, project, refreshHistory, token]);

  const canGenerate = sourceText.trim().length > 0 && !creating;
  const canSave = Boolean(project && dirty && !isBusyArticleWorkflowStatus(project.status) && !saving);
  const canRewrite = Boolean(project && rewriteInstruction.trim() && !rewriting && !saving && !isBusyArticleWorkflowStatus(project.status));

  const { handleCopyBody, handleCopyTitle, handleCopySummary } = createArticleWorkflowCopyActions({
    previewBodyRef,
    titleDraft,
    summaryDraft,
    bodyHtmlDraft,
    toast,
    setError,
    setNotice,
  });

  const saveProject = useCallback(async (mode: "manual" | "auto" = "manual"): Promise<boolean> => {
    if (!project) return false;
    const nextHash = articleWorkflowDraftHash({
      title: titleDraft,
      summary: summaryDraft,
      bodyHtml: bodyHtmlDraft,
    });
    if (nextHash === lastSavedHashRef.current) {
      setDirty(false);
      return true;
    }
    setSaving(true);
    setError("");
    if (mode === "manual") setNotice("");
    try {
      const saved = await updateArticleWorkflowProject(token, project.id, {
        title: titleDraft.trim(),
        summary: summaryDraft.trim(),
        bodyHtml: bodyHtmlDraft.trim(),
      });
      hydrateProject(saved, true);
      setNotice(mode === "auto" ? "已自动保存" : "已保存修改");
      if (mode === "manual") toast.show("ok", "已保存修改");
      await refreshHistory();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "保存失败";
      setError(message);
      toast.show("err", message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [bodyHtmlDraft, hydrateProject, project, refreshHistory, summaryDraft, titleDraft, toast, token]);

  useEffect(() => {
    if (!project || !dirty || saving || rewriting || isBusyArticleWorkflowStatus(project.status)) return undefined;
    const timer = window.setTimeout(() => {
      void saveProject("auto");
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, project, rewriting, saveProject, saving]);

  const ensureCanLeaveDirty = () => {
    if (!dirty) return true;
    return typeof window === "undefined" || window.confirm("当前有未保存修改，确定切换项目吗？");
  };

  const handleNewProject = () => {
    if (!ensureCanLeaveDirty()) return;
    setSelectedProjectId(null);
    setProject(null);
    setTitleDraft("");
    setSummaryDraft("");
    setBodyHtmlDraft("");
    setEditorSyncKey("");
    setSourceFormat("plain-text");
    setGenerationMode("preserve-text");
    setSourceText("");
    setRewriteInstruction("");
    setRewriteGenerationMode("preserve-text");
    setRewriteRegenerateImages(false);
    setDirty(false);
    resetMessages();
  };

  const handleSelectProject = (projectId: string) => {
    if (projectId === selectedProjectId || !ensureCanLeaveDirty()) return;
    void (async () => {
      try {
        resetMessages();
        await loadProject(projectId, true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载项目失败");
      }
    })();
  };

  const handleGenerate = () => {
    if (!canGenerate) return;
    setCreating(true);
    resetMessages();
    void (async () => {
      try {
        const created = await createArticleWorkflowProject(token, {
          sourceFormat,
          sourceText: sourceText.trim(),
          generationMode,
        });
        const detail = await loadProject(created.projectId, true);
        await refreshHistory();
        setNotice(detail.progressMessage || "已开始生成图文");
      } catch (err) {
        setError(err instanceof Error ? err.message : "创建公众号图文项目失败");
      } finally {
        setCreating(false);
      }
    })();
  };

  const handleRewrite = () => {
    if (!project || !canRewrite) return;
    void (async () => {
      const saved = dirty ? await saveProject("manual") : true;
      if (!saved) return;
      setRewriting(true);
      resetMessages();
      try {
        await rewriteArticleWorkflowProject(token, project.id, {
          instruction: rewriteInstruction.trim(),
          generationMode: rewriteGenerationMode,
          regenerateImages: rewriteRegenerateImages,
        });
        const detail = await loadProject(project.id, true);
        setRewriteInstruction("");
        setNotice(detail.progressMessage || "已提交重新生成");
        toast.show("ok", "已提交重新生成");
        await refreshHistory();
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI 重新生成失败";
        setError(message);
        toast.show("err", message);
      } finally {
        setRewriting(false);
      }
    })();
  };

  const handleRegenerateImage = (slot: string) => {
    if (!project) return;
    void (async () => {
      const saved = dirty ? await saveProject("manual") : true;
      if (!saved) return;
      setRegeneratingSlot(slot);
      resetMessages();
      try {
        const updated = await regenerateArticleWorkflowImage(token, project.id, slot, {});
        hydrateProject(updated, true);
        setNotice("图片已更新");
        toast.show("ok", "图片已更新");
        await refreshHistory();
        onBalanceRefresh?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : "图片重生失败";
        setError(message);
        toast.show("err", message);
      } finally {
        setRegeneratingSlot(null);
      }
    })();
  };

  return {
    bootstrapping,
    history,
    selectedProjectId,
    project,
    pricing,
    titleDraft,
    summaryDraft,
    bodyHtmlDraft,
    editorSyncKey,
    sourceFormat,
    generationMode,
    sourceText,
    creating,
    saving,
    rewriting,
    regeneratingSlot,
    rewriteInstruction,
    rewriteGenerationMode,
    rewriteRegenerateImages,
    error,
    notice,
    dirty,
    previewBodyRef,
    canGenerate,
    canSave,
    canRewrite,
    setSourceFormat,
    setGenerationMode,
    setSourceText: (value: string) => {
      setSourceText(value);
      resetMessages();
    },
    setRewriteInstruction,
    setRewriteGenerationMode,
    setRewriteRegenerateImages,
    handleNewProject,
    handleSelectProject,
    handleGenerate,
    handleSave: () => saveProject("manual"),
    handleCopyBody,
    handleCopyTitle,
    handleCopySummary,
    handleRewrite,
    handleRegenerateImage,
    markTitleDirty: (value: string) => {
      setTitleDraft(value);
      setDirty(true);
      resetMessages();
    },
    markSummaryDirty: (value: string) => {
      setSummaryDraft(value);
      setDirty(true);
      resetMessages();
    },
    markBodyHtmlDirty: (value: string) => {
      setBodyHtmlDraft(value);
      setDirty(true);
      resetMessages();
    },
    handleBodyBlur: (value: string) => {
      setBodyHtmlDraft(value);
      setDirty(true);
      if (project && !isBusyArticleWorkflowStatus(project.status)) {
        void saveProject("auto");
      }
    },
  };
}
