import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "motion/react";
import { RippleButton, Stagger, StaggerItem, spring, msgIn } from "../../motion";
import {
  ApiError,
  analyzeNovelChapter,
  cancelNovelTask,
  createNovelProject,
  generateNovelChapter,
  generateNovelStage,
  getNovelProject,
  getNovelWorkbench,
  listNovelProjects,
  saveNovelChapter,
  saveNovelChapterReview,
  saveNovelSection,
  type NovelChapter,
  type NovelProjectDetail,
  type NovelProjectSummary,
  type NovelStageKind,
  type NovelTask,
  type NovelWorkbenchPayload,
} from "../../api";
import {
  createDefaultNovelDraft,
  NovelCreatePage,
  novelCreateGenre,
  novelCreateInitialSettings,
  type NovelCreateDraft,
} from "./NovelCreatePage";
import { STAGE_OPTIONS } from "./NovelWorkflowPieces";
import { normalizeNovelDraftText } from "./novelDraftNormalizer";
import { appendRepeatBlock, removeRepeatBlock, splitRepeatBlocks, updateRepeatBlock } from "./novelRepeatBlocks";
import { NovelChapterEditorPanel } from "./NovelChapterEditorPanel";
import { NovelChapterIntelligencePanel } from "./NovelChapterIntelligencePanel";
import { NovelChapterListPanel } from "./NovelChapterListPanel";
import { NovelReviewPanel } from "./NovelReviewPanel";
import { NovelWorkbenchSignals } from "./NovelWorkbenchSignals";

interface NovelWorkflowStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
}

type NovelTabKind = "projects" | "create" | NovelStageKind;
type CountedNovelStageKind = Extract<NovelStageKind, "chars" | "volumes" | "outline">;
type ChapterSaveStatus = "idle" | "saving" | "saved" | "error";

type FieldConfig = {
  readonly title: string;
  readonly helper: string;
  readonly columns?: 1 | 2;
  readonly fields: readonly { key: string; label: string; placeholder: string; rows?: number }[];
};

type RepeatFieldConfig = {
  readonly itemLabel: string;
  readonly addLabel: string;
  readonly emptyBlock: string;
  readonly rows: number;
};

type StageCountConfig = {
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: string;
};

const TASK_STATUS_LABELS: Record<NovelTask["status"], string> = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const TASK_STATUS_CLASSES: Record<NovelTask["status"], string> = {
  queued: "bg-orange-50 text-orange-700",
  running: "bg-brand-soft text-brand-ink",
  succeeded: "bg-gray-100 text-gray-600",
  failed: "bg-red-50 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

const POLL_MS = 3000;

const TAB_OPTIONS: readonly { kind: NovelStageKind; label: string; icon: string }[] = STAGE_OPTIONS;

const STAGE_COUNT_CONFIGS: Record<CountedNovelStageKind, StageCountConfig> = {
  chars: { label: "角色数量", unit: "个", min: 1, max: 50, defaultValue: "6" },
  volumes: { label: "卷数", unit: "卷", min: 1, max: 50, defaultValue: "6" },
  outline: { label: "章节数", unit: "章", min: 1, max: 500, defaultValue: "12" },
};

const DEFAULT_STAGE_COUNTS: Record<CountedNovelStageKind, string> = {
  chars: STAGE_COUNT_CONFIGS.chars.defaultValue,
  volumes: STAGE_COUNT_CONFIGS.volumes.defaultValue,
  outline: STAGE_COUNT_CONFIGS.outline.defaultValue,
};

const FIELD_CONFIGS: Record<NovelStageKind, FieldConfig> = {
  settings: {
    title: "设定",
    helper: "定义卖点、目标读者和前 30 章承诺，决定作品第一屏吸引力。",
    columns: 2,
    fields: [
      { key: "核心要求", label: "核心要求", placeholder: "视角：第三人称；金手指：否；章节数：12；每章约 5000 字；语言：中文", rows: 5 },
      { key: "频道", label: "频道", placeholder: "男频长篇", rows: 3 },
      { key: "平台", label: "平台", placeholder: "番茄 / 起点 / 七猫", rows: 3 },
      { key: "题材", label: "题材", placeholder: "玄幻 / 武侠", rows: 3 },
      { key: "视角", label: "视角", placeholder: "第三人称", rows: 3 },
      { key: "文风模式", label: "文风模式", placeholder: "强爽点", rows: 3 },
      { key: "年代", label: "年代", placeholder: "古代", rows: 3 },
      { key: "是否金手指", label: "是否金手指", placeholder: "否", rows: 3 },
      { key: "风格标签", label: "风格标签", placeholder: "升级流 / 打脸文", rows: 4 },
      { key: "语言", label: "语言", placeholder: "中文", rows: 3 },
      { key: "章节规划", label: "章节规划", placeholder: "章节数：12\n每章字数：5000", rows: 4 },
      { key: "卖点", label: "卖点", placeholder: "治愈异能搭配乡村种田与权谋复仇，主角一路打脸恶势力。", rows: 6 },
      { key: "目标读者", label: "目标读者", placeholder: "25-35 岁男性网文读者，偏好升级、复仇、经营和强情绪爽点。", rows: 6 },
      { key: "前30章承诺", label: "前 30 章承诺（每行一条）", placeholder: "第1章：主角陷入危机并觉醒能力。\n第2章：揭示第一重压迫关系。", rows: 8 },
    ],
  },
  macro: {
    title: "宏观",
    helper: "把长篇主线、核心矛盾和升级循环先定住，避免后续越写越散。",
    columns: 2,
    fields: [
      { key: "故事引擎", label: "故事引擎", placeholder: "治愈异能驱动乡村种田与权谋复仇循环。", rows: 5 },
      { key: "主线", label: "主线", placeholder: "主角从乡村底层逆袭，逐步掌控资源、组织与舆论。", rows: 5 },
      { key: "长期对立", label: "长期对立", placeholder: "主角阵营与地方恶霸、腐败官员、权贵家族的持续斗争。", rows: 5 },
      { key: "节奏底盘", label: "节奏底盘", placeholder: "每 5-10 章一个小循环：困局、破局、收益、反扑、升级。", rows: 5 },
      { key: "前30章承诺", label: "前 30 章承诺（每行一条）", placeholder: "第1章：赤脚医生的隐忍\n第2章：枯井边的生死一刻", rows: 8 },
    ],
  },
  world: {
    title: "世界观",
    helper: "沉淀世界规则、势力、地点和关系，让后续生成能持续引用同一套事实。",
    columns: 2,
    fields: [
      { key: "世界手册", label: "世界手册", placeholder: "世界背景、核心资源、能力体系、社会结构。", rows: 7 },
      { key: "规则", label: "规则（每行一条）", placeholder: "异能使用后必须通过自然恢复补充。\n治疗不能直接交易权贵赏赐。", rows: 7 },
      { key: "势力", label: "势力（每段一组：名称 / 简介）", placeholder: "李阳正义联盟：以主角为核心的乡村改革势力。", rows: 9 },
      { key: "地点", label: "地点（每段一处：名称 / 简介）", placeholder: "李家村：主角故乡，也是故事起点。", rows: 9 },
      { key: "关系", label: "关系（每行一条）", placeholder: "李阳与赵虎：经济控制与反控制的直接冲突。", rows: 8 },
    ],
  },
  chars: {
    title: "角色",
    helper: "管理人物身份锚点、动机、关系网和角色数量，保证人物不会写丢。",
    fields: [
      { key: "角色", label: "角色（每段一人：名称 / 身份锚点 / 动机 / 关系）", placeholder: "李阳\n身份锚点：赤脚医生。\n动机：救人、护村、复仇。", rows: 14 },
      { key: "关系网", label: "关系网（每行一条）", placeholder: "李阳 <-> 赵虎：压迫与反抗。\n李阳 <-> 父母：守护与亏欠。", rows: 8 },
    ],
  },
  volumes: {
    title: "卷纲",
    helper: "规划每卷标题、战略和骨架，避免章节只剩流水账。",
    fields: [
      { key: "分卷", label: "分卷（每段一卷：标题 / 战略 / 骨架）", placeholder: "觉醒之始：乡村赤脚医生的崛起\n战略：建立主角隐忍背景和治疗异能觉醒。", rows: 16 },
    ],
  },
  outline: {
    title: "拆章",
    helper: "把卷纲拆成可生成正文的章节列表，每章要有标题、摘要和本章目标。",
    fields: [
      { key: "章节列表", label: "章节列表", placeholder: "序号：1\n标题：赤脚医生的隐忍\n摘要：暴雨夜，主角守住底线。\n本章目标：建立压迫感。", rows: 16 },
    ],
  },
  draft: {
    title: "正文",
    helper: "从章节列表选择章节生成正文，并保留长篇记忆辅助连续写作。",
    fields: [
      { key: "长篇记忆", label: "长篇记忆（已记忆至第几章）", placeholder: "李阳目前的能力边界、未回收伏笔、角色关系变化。", rows: 7 },
    ],
  },
  style: {
    title: "写法",
    helper: "粘贴样文提取写法特征，保存后绑定到正文续写。",
    fields: [
      { key: "样文", label: "粘贴样本文本（从中提取写法特征）", placeholder: "粘贴一段你想模仿的网文。", rows: 8 },
      { key: "写法名", label: "写法名", placeholder: "强情绪乡村爽文写法" },
      { key: "特征池", label: "特征池（每行一条）", placeholder: "短句推进。\n对话带压迫感。\n每段结尾留钩子。", rows: 8 },
    ],
  },
};

const REPEAT_FIELD_CONFIGS: Partial<Record<NovelStageKind, Partial<Record<string, RepeatFieldConfig>>>> = {
  chars: {
    角色: {
      itemLabel: "角色",
      addLabel: "新增角色",
      emptyBlock: "新角色\n身份锚点：\n动机：\n关系：",
      rows: 10,
    },
  },
  volumes: {
    分卷: {
      itemLabel: "分卷",
      addLabel: "新增分卷",
      emptyBlock: "标题：新分卷\n战略：\n骨架：",
      rows: 8,
    },
  },
  outline: {
    章节列表: {
      itemLabel: "章节",
      addLabel: "新增章节",
      emptyBlock: "序号：\n标题：新章节\n摘要：\n本章目标：",
      rows: 8,
    },
  },
};

function isActiveTask(task: NovelTask): boolean {
  return task.status === "queued" || task.status === "running";
}

function mergeTask(detail: NovelProjectDetail, task: NovelTask): NovelProjectDetail {
  return {
    ...detail,
    tasks: [task, ...detail.tasks.filter((item) => item.id !== task.id)].slice(0, 20),
  };
}

function upsertChapter(detail: NovelProjectDetail, chapter: NovelChapter): NovelProjectDetail {
  const chapters = [
    ...detail.chapters.filter((item) => item.id !== chapter.id && item.chapterIndex !== chapter.chapterIndex),
    chapter,
  ].sort((a, b) => a.chapterIndex - b.chapterIndex);
  return { ...detail, chapters };
}

function upsertWorkbenchChapter(workbench: NovelWorkbenchPayload, chapter: NovelChapter): NovelWorkbenchPayload {
  const chapters = [
    ...workbench.chapters.filter((item) => item.id !== chapter.id && item.chapterIndex !== chapter.chapterIndex),
    chapter,
  ].sort((a, b) => a.chapterIndex - b.chapterIndex);
  return { ...workbench, chapters };
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 402) return "算力点不足，请充值";
  return error instanceof Error ? error.message : fallback;
}

function taskTitle(task: NovelTask): string {
  if (task.targetKind === "chapter") return "章节正文";
  return STAGE_OPTIONS.find((stage) => stage.kind === task.targetKind)?.label ?? task.targetKind;
}

function isCountedStageKind(kind: NovelStageKind): kind is CountedNovelStageKind {
  return kind === "chars" || kind === "volumes" || kind === "outline";
}

function emptyDrafts(): Record<NovelStageKind, string> {
  return STAGE_OPTIONS.reduce((acc, stage) => ({ ...acc, [stage.kind]: "" }), {} as Record<NovelStageKind, string>);
}

function draftsFromSections(sections: NovelProjectDetail["sections"]): Record<NovelStageKind, string> {
  const drafts = emptyDrafts();
  for (const section of sections) {
    const config = FIELD_CONFIGS[section.kind];
    if (!config) continue;
    const fieldKeys = config.fields.map((field) => field.key);
    drafts[section.kind] = normalizeNovelDraftText(section.kind, section.displayText ?? "", fieldKeys);
  }
  return drafts;
}

function parseFields(text: string, fields: FieldConfig["fields"]): Record<string, string> {
  const labels = new Set(fields.map((field) => field.key));
  const values = Object.fromEntries(fields.map((field) => [field.key, ""])) as Record<string, string>;
  let current = fields[0]?.key ?? "";
  let sawHeading = false;
  for (const rawLine of text.split("\n")) {
    const match = rawLine.match(/^【(.+?)】\s*$/);
    if (match && labels.has(match[1])) {
      current = match[1];
      sawHeading = true;
      continue;
    }
    if (current) values[current] = values[current] ? `${values[current]}\n${rawLine}` : rawLine;
  }
  if (!sawHeading && fields[0]) values[fields[0].key] = text;
  for (const key of Object.keys(values)) values[key] = values[key].trim();
  return values;
}

function composeFields(fields: FieldConfig["fields"], values: Record<string, string>): string {
  return fields.map((field) => `【${field.key}】\n${values[field.key]?.trim() ?? ""}`).join("\n\n").trim();
}

function repeatFieldConfig(kind: NovelStageKind, fieldKey: string): RepeatFieldConfig | undefined {
  return REPEAT_FIELD_CONFIGS[kind]?.[fieldKey];
}

function primaryProjectSummary(detail: NovelProjectDetail): NovelProjectSummary {
  return {
    id: detail.project.id,
    title: detail.project.title,
    genre: detail.project.genre,
    status: detail.project.status,
    updatedAt: detail.project.updatedAt,
  };
}

export function NovelWorkflowStudio({ token, onBalanceRefresh }: NovelWorkflowStudioProps) {
  const [projects, setProjects] = useState<readonly NovelProjectSummary[]>([]);
  const [detail, setDetail] = useState<NovelProjectDetail | null>(null);
  const [workbench, setWorkbench] = useState<NovelWorkbenchPayload | null>(null);
  const [activeTab, setActiveTab] = useState<NovelTabKind>("projects");
  const [createDraft, setCreateDraft] = useState<NovelCreateDraft>(() => createDefaultNovelDraft());
  const [drafts, setDrafts] = useState<Record<NovelStageKind, string>>(() => emptyDrafts());
  const [selectedChapterId, setSelectedChapterId] = useState("");
  const [chapterTitle, setChapterTitle] = useState("");
  const [chapterSummary, setChapterSummary] = useState("");
  const [chapterContent, setChapterContent] = useState("");
  const [targetChars, setTargetChars] = useState("3000");
  const [stageCounts, setStageCounts] = useState<Record<CountedNovelStageKind, string>>(() => DEFAULT_STAGE_COUNTS);
  const [chapterSaveStatus, setChapterSaveStatus] = useState<ChapterSaveStatus>("idle");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);

  const activeTasks = detail?.tasks.filter(isActiveTask) ?? [];
  const displayChapters = workbench?.chapters ?? detail?.chapters ?? [];
  const selectedChapter = useMemo(
    () => displayChapters.find((chapter) => chapter.id === selectedChapterId) ?? displayChapters[0] ?? null,
    [displayChapters, selectedChapterId],
  );

  const applyDetail = useCallback((next: NovelProjectDetail) => {
    setDetail(next);
    setDrafts(draftsFromSections(next.sections));
    setSelectedChapterId((current) => next.chapters.some((chapter) => chapter.id === current) ? current : next.chapters[0]?.id || "");
  }, []);

  const applyWorkbench = useCallback((next: NovelWorkbenchPayload) => {
    setWorkbench(next);
    setSelectedChapterId((current) => next.chapters.some((chapter) => chapter.id === current) ? current : next.chapters[0]?.id || "");
  }, []);

  const refreshDetail = useCallback(async (projectId: string, quiet = false) => {
    try {
      const [nextDetail, nextWorkbench] = await Promise.all([
        getNovelProject(token, projectId),
        getNovelWorkbench(token, projectId).catch(() => null),
      ]);
      applyDetail(nextDetail);
      if (nextWorkbench) applyWorkbench(nextWorkbench);
      if (!quiet) setNotice("");
    } catch (err) {
      if (!quiet) setError(errorMessage(err, "获取小说项目失败"));
    }
  }, [applyDetail, applyWorkbench, token]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listNovelProjects(token);
      setProjects(rows);
    } catch (err) {
      setError(errorMessage(err, "加载小说项目失败"));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!detail?.tasks.some(isActiveTask)) return undefined;
    const timer = window.setInterval(() => {
      void refreshDetail(detail.project.id, true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [detail, refreshDetail]);

  useEffect(() => {
    if (!selectedChapter) {
      setChapterTitle("");
      setChapterSummary("");
      setChapterContent("");
      setChapterSaveStatus("idle");
      return;
    }
    setChapterTitle(selectedChapter.title);
    setChapterSummary(selectedChapter.summary);
    setChapterContent(selectedChapter.content);
    setChapterSaveStatus("idle");
  }, [selectedChapter?.id, selectedChapter?.updatedAt]);

  useEffect(() => {
    if (!detail || !selectedChapter) return undefined;
    const title = chapterTitle.trim();
    const summary = chapterSummary.trim();
    if (title === selectedChapter.title && summary === selectedChapter.summary && chapterContent === selectedChapter.content) {
      return undefined;
    }
    setChapterSaveStatus("saving");
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const saved = await saveNovelChapter(token, detail.project.id, selectedChapter.chapterIndex, {
            title,
            summary,
            content: chapterContent,
          });
          setDetail((current) => current && current.project.id === detail.project.id ? upsertChapter(current, saved) : current);
          setWorkbench((current) => current && current.project.id === detail.project.id ? upsertWorkbenchChapter(current, saved) : current);
          setChapterSaveStatus("saved");
        } catch (err) {
          setChapterSaveStatus("error");
          setError(err instanceof Error ? errorMessage(err, "自动保存章节失败") : "自动保存章节失败");
        }
      })();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [
    chapterContent,
    chapterSummary,
    chapterTitle,
    detail?.project.id,
    selectedChapter?.chapterIndex,
    selectedChapter?.content,
    selectedChapter?.summary,
    selectedChapter?.title,
    token,
  ]);

  const submitTask = async (task: Promise<NovelTask>, successText: string) => {
    const created = await task;
    setDetail((current) => current ? mergeTask(current, created) : current);
    setNotice(successText);
    onBalanceRefresh?.();
  };

  const handleCreateProject = () => {
    if (!createDraft.title.trim()) {
      setError("请输入小说标题");
      return;
    }
    setBusyAction("create");
    setError("");
    setNotice("");
    void (async () => {
      try {
        const created = await createNovelProject(token, {
          title: createDraft.title.trim(),
          genre: novelCreateGenre(createDraft),
          initialSettings: novelCreateInitialSettings(createDraft),
        });
        applyDetail(created);
        setWorkbench(null);
        setProjects((prev) => [primaryProjectSummary(created), ...prev.filter((item) => item.id !== created.project.id)]);
        setActiveTab("settings");
        setCreateDraft(createDefaultNovelDraft());
        setNotice("小说项目已创建");
      } catch (err) {
        setError(errorMessage(err, "创建小说项目失败"));
      } finally {
        setBusyAction("");
      }
    })();
  };

  const handleSelectProject = (projectId: string) => {
    setError("");
    setNotice("");
    setDetail((current) => current?.project.id === projectId ? current : null);
    setWorkbench((current) => current?.project.id === projectId ? current : null);
    setActiveTab("settings");
    void refreshDetail(projectId);
  };

  const handleOpenCreatePage = () => {
    setCreateDraft(createDefaultNovelDraft());
    setError("");
    setNotice("");
    setActiveTab("create");
  };

  const handleOpenProjectsPage = () => {
    setError("");
    setNotice("");
    setWorkbench(null);
    setActiveTab("projects");
    void loadProjects();
  };

  const updateField = (kind: NovelStageKind, fieldKey: string, value: string) => {
    const config = FIELD_CONFIGS[kind];
    const values = parseFields(drafts[kind] ?? "", config.fields);
    values[fieldKey] = value;
    setDrafts((current) => ({ ...current, [kind]: composeFields(config.fields, values) }));
  };

  const handleSaveSection = (kind: NovelStageKind) => {
    if (!detail) return;
    setBusyAction(`save:${kind}`);
    setError("");
    setNotice("");
    void (async () => {
      try {
        const saved = await saveNovelSection(token, detail.project.id, kind, drafts[kind] ?? "");
        setDetail((current) => current ? {
          ...current,
          sections: current.sections.map((section) => section.kind === saved.kind ? saved : section),
        } : current);
        setNotice("已保存当前模块");
      } catch (err) {
        setError(errorMessage(err, "保存当前模块失败"));
      } finally {
        setBusyAction("");
      }
    })();
  };

  const handleStageGenerate = (kind: NovelStageKind) => {
    if (!detail) return;
    let targetCount: number | undefined;
    if (isCountedStageKind(kind)) {
      const config = STAGE_COUNT_CONFIGS[kind];
      const rawCount = stageCounts[kind].trim();
      const parsedCount = Number.parseInt(rawCount, 10);
      if (!/^\d+$/.test(rawCount) || parsedCount < config.min || parsedCount > config.max) {
        setError(`${config.label}需在 ${config.min} 到 ${config.max} ${config.unit}之间`);
        return;
      }
      targetCount = parsedCount;
    }
    setBusyAction(`stage:${kind}`);
    setError("");
    setNotice("");
    void (async () => {
      try {
        await submitTask(
          generateNovelStage(token, detail.project.id, kind, drafts[kind] ?? "", targetCount),
          "AI 生成任务已提交",
        );
      } catch (err) {
        setError(errorMessage(err, "创建生成任务失败"));
      } finally {
        setBusyAction("");
      }
    })();
  };

  const handleChapterGenerate = () => {
    if (!detail) return;
    const parsedTarget = Number.parseInt(targetChars, 10);
    if (!Number.isFinite(parsedTarget) || parsedTarget < 500 || parsedTarget > 12000) {
      setError("章节目标字数需在 500 到 12000 之间");
      return;
    }
    setBusyAction("chapter");
    setError("");
    setNotice("");
    void (async () => {
      try {
        await submitTask(
          generateNovelChapter(token, detail.project.id, {
            chapterIndex: selectedChapter?.chapterIndex,
            title: chapterTitle.trim() || selectedChapter?.title || "",
            summary: chapterSummary.trim() || selectedChapter?.summary || "",
            targetChars: parsedTarget,
          }),
          "章节生成任务已提交",
        );
      } catch (err) {
        setError(errorMessage(err, "创建章节任务失败"));
      } finally {
        setBusyAction("");
      }
    })();
  };

  const handleSaveReview = (payload: { status?: "pending" | "approved" | "revise"; reviewNotes?: string; regenerateAi?: boolean }) => {
    if (!detail || !selectedChapter) return;
    setReviewSaving(true);
    setError("");
    setNotice("");
    void (async () => {
      try {
        const saved = await saveNovelChapterReview(token, detail.project.id, selectedChapter.chapterIndex, payload);
        setDetail((current) => current && current.project.id === detail.project.id ? upsertChapter(current, saved) : current);
        setWorkbench((current) => current && current.project.id === detail.project.id ? upsertWorkbenchChapter(current, saved) : current);
        setNotice("章节审阅已保存");
      } catch (err) {
        setError(errorMessage(err, "保存章节审阅失败"));
      } finally {
        setReviewSaving(false);
      }
    })();
  };

  const handleAnalyzeChapter = () => {
    if (!detail || !selectedChapter) return;
    setReviewSaving(true);
    setError("");
    setNotice("");
    void (async () => {
      try {
        const saved = await analyzeNovelChapter(token, detail.project.id, selectedChapter.chapterIndex);
        setDetail((current) => current && current.project.id === detail.project.id ? upsertChapter(current, saved) : current);
        const nextWorkbench = await getNovelWorkbench(token, detail.project.id).catch(() => null);
        if (nextWorkbench) applyWorkbench(nextWorkbench);
        else setWorkbench((current) => current && current.project.id === detail.project.id ? upsertWorkbenchChapter(current, saved) : current);
        setNotice("章节分析已刷新");
      } catch (err) {
        setError(errorMessage(err, "分析章节失败"));
      } finally {
        setReviewSaving(false);
      }
    })();
  };

  const handleCancelTask = (taskId: string) => {
    setError("");
    setNotice("");
    void (async () => {
      try {
        const task = await cancelNovelTask(token, taskId);
        setDetail((current) => current ? mergeTask(current, task) : current);
        setNotice("已取消任务");
        onBalanceRefresh?.();
      } catch (err) {
        setError(errorMessage(err, "取消任务失败"));
      }
    })();
  };

  const renderFields = (kind: NovelStageKind) => {
    const config = FIELD_CONFIGS[kind];
    const values = parseFields(drafts[kind] ?? "", config.fields);
    const countConfig = isCountedStageKind(kind) ? STAGE_COUNT_CONFIGS[kind] : null;
    return (
      <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-5 shadow-[0_16px_44px_rgba(15,23,42,0.055)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#1d1d1f]">{config.title}</h2>
            <p className="mt-1 text-sm leading-6 text-[#6e6e73]">{config.helper}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {countConfig && isCountedStageKind(kind) && (
              <label className="flex h-10 items-center gap-2 rounded-[10px] border border-[#d2d2d7] bg-white px-3 text-xs font-semibold text-[#4f4f55]">
                {countConfig.label}
                <input
                  value={stageCounts[kind]}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setStageCounts((current) => ({ ...current, [kind]: value }));
                  }}
                  inputMode="numeric"
                  aria-label={countConfig.label}
                  className="h-7 w-16 rounded-[8px] border border-[#e8e8ed] px-2 text-sm font-semibold text-[#1d1d1f] outline-none focus:border-brand/60"
                />
              </label>
            )}
            <RippleButton type="button" onClick={() => handleStageGenerate(kind)} disabled={busyAction === `stage:${kind}`} className="flex h-10 items-center gap-2 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover disabled:bg-brand/40">
              <Icon icon="mdi:auto-fix" aria-hidden />
              {busyAction === `stage:${kind}` ? "提交中" : "AI 生成"}
            </RippleButton>
            <button type="button" className="h-10 rounded-[10px] border border-[#d2d2d7] px-4 text-sm font-semibold text-[#1d1d1f]">历史版本</button>
            <RippleButton type="button" onClick={() => handleSaveSection(kind)} disabled={busyAction === `save:${kind}`} className="flex h-10 items-center gap-2 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover disabled:bg-brand/40">
              <Icon icon="mdi:check" aria-hidden />
              {busyAction === `save:${kind}` ? "保存中" : "保存"}
            </RippleButton>
          </div>
        </div>
        <div className={`mt-5 grid gap-4 ${config.columns === 2 ? "lg:grid-cols-2" : ""}`}>
          {config.fields.map((field) => {
            const repeatConfig = repeatFieldConfig(kind, field.key);
            const fieldValue = values[field.key] ?? "";
            if (repeatConfig) {
              const blocks = splitRepeatBlocks(fieldValue);
              return (
                <div key={field.key} className="grid gap-3 text-sm font-semibold text-[#4f4f55]">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <span>{field.label}</span>
                      <p className="mt-1 text-xs font-normal text-[#8a8a8f]">每个{repeatConfig.itemLabel}单独编辑，保存时自动按块合并。</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => updateField(kind, field.key, appendRepeatBlock(fieldValue, repeatConfig.emptyBlock))}
                      className="h-9 rounded-[8px] border border-brand/25 px-3 text-xs font-semibold text-brand-ink hover:bg-brand-soft"
                    >
                      + {repeatConfig.addLabel}
                    </button>
                  </div>
                  <div className="grid gap-3">
                    {blocks.map((block, blockIndex) => (
                      <div key={`${field.key}:${blockIndex}`} className="rounded-[10px] border border-[#e8e8ed] bg-[#fbfefd] p-3">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <span className="text-xs font-bold text-brand-ink">第 {blockIndex + 1} 个{repeatConfig.itemLabel}</span>
                          {blocks.length > 1 && (
                            <button
                              type="button"
                              onClick={() => updateField(kind, field.key, removeRepeatBlock(fieldValue, blockIndex))}
                              className="rounded-[8px] border border-red-100 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                            >
                              删除
                            </button>
                          )}
                        </div>
                        <textarea
                          value={block}
                          onChange={(event) => updateField(kind, field.key, updateRepeatBlock(fieldValue, blockIndex, event.target.value))}
                          placeholder={field.placeholder}
                          rows={repeatConfig.rows}
                          className="w-full resize-y rounded-[8px] border border-[#d2d2d7] bg-white p-3 text-sm leading-6 text-[#1d1d1f] outline-none focus:border-brand/60"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            }
            return (
              <label key={field.key} className="grid gap-2 text-sm font-semibold text-[#4f4f55]">
                {field.label}
                <textarea
                  value={fieldValue}
                  onChange={(event) => updateField(kind, field.key, event.target.value)}
                  placeholder={field.placeholder}
                  rows={field.rows ?? 3}
                  className="w-full resize-y rounded-[8px] border border-[#d2d2d7] bg-white p-3 text-sm leading-6 text-[#1d1d1f] outline-none focus:border-brand/60"
                />
              </label>
            );
          })}
        </div>
      </section>
    );
  };

  const renderDraftTab = () => {
    const config = FIELD_CONFIGS.draft;
    const values = parseFields(drafts.draft ?? "", config.fields);
    return (
      <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-5 shadow-[0_16px_44px_rgba(15,23,42,0.055)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#1d1d1f]">正文</h2>
            <p className="mt-1 text-sm leading-6 text-[#6e6e73]">{config.helper}</p>
          </div>
        </div>
        <div className="mt-5 rounded-[10px] border border-[#e8e8ed] p-4">
          <label className="grid gap-2 text-sm font-semibold text-[#4f4f55]">
            长篇记忆（已记忆至第几章）
            <textarea value={values["长篇记忆"] ?? ""} onChange={(event) => updateField("draft", "长篇记忆", event.target.value)} rows={4} className="w-full resize-y rounded-[8px] border border-[#d2d2d7] p-3 text-sm leading-6" />
          </label>
        </div>
        <div className="mt-5 grid items-start gap-4 xl:grid-cols-[300px_minmax(0,1fr)_320px]">
          <NovelChapterListPanel chapters={displayChapters} selectedChapterId={selectedChapterId} onSelect={setSelectedChapterId} />
          <NovelChapterEditorPanel
            selectedChapter={selectedChapter}
            chapterTitle={chapterTitle}
            chapterSummary={chapterSummary}
            chapterContent={chapterContent}
            targetChars={targetChars}
            saveStatus={chapterSaveStatus}
            isGenerating={busyAction === "chapter"}
            onTitleChange={setChapterTitle}
            onSummaryChange={setChapterSummary}
            onContentChange={setChapterContent}
            onTargetCharsChange={setTargetChars}
            onGenerate={handleChapterGenerate}
          />
          <div className="grid gap-4">
            <NovelChapterIntelligencePanel chapter={selectedChapter} workbench={workbench} />
            <NovelReviewPanel chapter={selectedChapter} isSaving={reviewSaving} onSave={handleSaveReview} onAnalyze={handleAnalyzeChapter} />
          </div>
        </div>
      </section>
    );
  };

  const renderProjectEntryPage = () => (
    <section className="grid min-w-0 gap-5">
      <div className="rounded-[14px] border border-[#e8e8ed] bg-white p-5 shadow-[0_16px_44px_rgba(15,23,42,0.055)]">
        <div className="flex flex-col gap-4 border-b border-[#e8e8ed] pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-brand-ink">
              <Icon icon="mdi:bookshelf" aria-hidden />
              小说创作工作台
            </div>
            <h2 className="mt-2 text-xl font-semibold text-[#1d1d1f]">小说作品</h2>
            <p className="mt-1 text-sm leading-6 text-[#6e6e73]">选择作品进入编辑，或新建一个作品开始生成设定、卷纲、拆章和正文。</p>
          </div>
          <RippleButton type="button" onClick={handleOpenCreatePage} className="flex h-10 items-center justify-center gap-2 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover">
            <Icon icon="mdi:plus" aria-hidden />
            新建作品
          </RippleButton>
        </div>

        {loading && (
          <div className="mt-5 flex min-h-[220px] items-center justify-center rounded-[12px] border border-dashed border-[#d2d2d7] bg-[#f7faf9] text-sm font-semibold text-brand-ink">
            <Icon icon="mdi:loading" className="mr-2 animate-spin text-xl" aria-hidden />
            正在加载作品
          </div>
        )}

        {!loading && projects.length > 0 && (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => handleSelectProject(project.id)}
                className="group grid min-h-[148px] content-between rounded-[12px] border border-[#e8e8ed] bg-white p-4 text-left transition hover:border-brand/40 hover:bg-[#fbfefd] hover:shadow-[0_10px_28px_rgba(15,23,42,0.06)]"
              >
                <span className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-base font-semibold text-[#1d1d1f]">{project.title}</span>
                    <span className="mt-2 block truncate text-sm text-[#6e6e73]">{project.genre || "未设题材"}</span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${project.status === "active" ? "bg-brand-soft text-brand-ink" : "bg-gray-100 text-gray-500"}`}>
                    {project.status === "active" ? "创作中" : project.status}
                  </span>
                </span>
                <span className="mt-5 flex items-center justify-between gap-3 text-xs text-[#8a8a8f]">
                  <span>更新 {formatTime(project.updatedAt)}</span>
                  <span className="flex items-center gap-1 font-semibold text-brand-ink">
                    进入编辑
                    <Icon icon="mdi:arrow-right" className="transition group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {!loading && projects.length === 0 && (
          <div className="mt-5 grid min-h-[220px] place-items-center rounded-[12px] border border-dashed border-[#d2d2d7] bg-[#f7faf9] px-4 text-center">
            <div>
              <p className="text-base font-semibold text-[#1d1d1f]">暂无小说作品</p>
              <p className="mt-2 text-sm text-[#6e6e73]">先新建作品，再进入工作流生成内容。</p>
              <RippleButton type="button" onClick={handleOpenCreatePage} className="mt-4 inline-flex h-10 items-center gap-2 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover">
                <Icon icon="mdi:plus" aria-hidden />
                新建作品
              </RippleButton>
            </div>
          </div>
        )}
      </div>

      {error && <p className="rounded-[10px] bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && !error && <p className="rounded-[10px] bg-brand-soft px-3 py-2 text-sm text-brand-ink">{notice}</p>}
    </section>
  );

  const renderActiveTab = () => {
    if (activeTab === "projects" || activeTab === "create") return null;
    if (activeTab === "draft") return renderDraftTab();
    return renderFields(activeTab);
  };

  if (activeTab === "projects") return renderProjectEntryPage();

  if (activeTab === "create") {
    return (
      <section className="grid min-w-0 gap-5">
        <NovelCreatePage
          draft={createDraft}
          canGoBack={true}
          isSubmitting={busyAction === "create"}
          onBack={handleOpenProjectsPage}
          onChange={setCreateDraft}
          onSubmit={handleCreateProject}
        />
        {error && <p className="rounded-[10px] bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {notice && !error && <p className="rounded-[10px] bg-brand-soft px-3 py-2 text-sm text-brand-ink">{notice}</p>}
      </section>
    );
  }

  return (
    <section className="grid min-w-0 gap-5">
      <div className="rounded-[14px] border border-[#e8e8ed] bg-white p-4 shadow-[0_16px_44px_rgba(15,23,42,0.055)]">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h2 className="truncate text-xl font-semibold text-[#1d1d1f]">{detail?.project.title ?? "小说模块"}</h2>
              {loading && <Icon icon="mdi:loading" className="animate-spin text-xl text-brand-ink" aria-hidden />}
              {activeTasks.length > 0 && <span aria-label="小说生成中" className="h-4 w-4 rounded-full border-2 border-brand/20 border-t-brand animate-spin" />}
            </div>
            <p className="mt-1 text-sm text-[#6e6e73]">{detail?.project.genre || "创建项目后开始生成"} · 运行中 {activeTasks.length} 个任务</p>
            {activeTasks.length > 0 && (
              <p className="mt-2 rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand-ink">
                后台生成中，可切换页面，回来后会自动刷新结果
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={handleOpenProjectsPage} className="flex h-10 items-center gap-2 rounded-[10px] border border-[#d2d2d7] px-4 text-sm font-semibold">
              <Icon icon="mdi:bookshelf" aria-hidden />
              作品列表
            </button>
            <button type="button" onClick={handleOpenCreatePage} className="flex h-10 items-center gap-2 rounded-[10px] border border-[#d2d2d7] px-4 text-sm font-semibold">
              <Icon icon="mdi:plus" aria-hidden />
              新建作品
            </button>
          </div>
        </div>
        {workbench && <NovelWorkbenchSignals workbench={workbench} />}
        <div className="mt-4 flex min-w-0 gap-2 overflow-x-auto border-b border-[#e8e8ed] pb-2 [scrollbar-width:thin]">
          {TAB_OPTIONS.map((tab) => (
            <button key={tab.kind} type="button" onClick={() => setActiveTab(tab.kind)} className={`flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-semibold ${activeTab === tab.kind ? "border-brand text-brand-ink" : "border-transparent text-[#6e6e73]"}`}>
              <Icon icon={tab.icon} aria-hidden />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="rounded-[10px] bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && !error && <p className="rounded-[10px] bg-brand-soft px-3 py-2 text-sm text-brand-ink">{notice}</p>}

      {renderActiveTab()}

      <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-5 shadow-[0_16px_44px_rgba(15,23,42,0.055)]">
        <h3 className="text-base font-semibold text-[#1d1d1f]">最近任务</h3>
        <div className="mt-3">
          {detail?.tasks.slice(0, 10).length ? (
            <Stagger className="grid gap-2">
              <AnimatePresence mode="popLayout">
                {detail?.tasks.slice(0, 10).map((task) => (
                  <StaggerItem key={task.id}>
                    <motion.div
                      layout
                      className="flex flex-col gap-2 rounded-[10px] border border-[#e8e8ed] px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                      whileHover={{ y: -4, boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)" }}
                      transition={spring.smooth}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#1d1d1f]">{taskTitle(task)}</p>
                        <p className="text-xs text-[#6e6e73]">{formatTime(task.updatedAt)}{task.error ? ` · ${task.error}` : ""}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <AnimatePresence>
                          <motion.span
                            key={`${task.id}-status`}
                            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${TASK_STATUS_CLASSES[task.status]}`}
                            variants={msgIn}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                          >
                            {TASK_STATUS_LABELS[task.status]}
                          </motion.span>
                        </AnimatePresence>
                        {isActiveTask(task) && <RippleButton type="button" onClick={() => handleCancelTask(task.id)} className="rounded-[8px] border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700">取消</RippleButton>}
                      </div>
                    </motion.div>
                  </StaggerItem>
                ))}
              </AnimatePresence>
            </Stagger>
          ) : (
            <p className="rounded-[10px] border border-dashed border-[#d2d2d7] bg-[#f7faf9] py-8 text-center text-xs text-[#8a8a8f]">暂无任务</p>
          )}
        </div>
      </section>
    </section>
  );
}
