// @vitest-environment jsdom

/**
 * 小说容器自己的用例。这一层不画 UI，所以三个子页面全换成探针，断言落在容器的状态机上：
 * 取数、hash 直达、建档校验、删除确认、章节草稿的自动保存，以及各处「请求回来时项目还对不对」。
 *
 * 上一版是 4 条 `renderToStaticMarkup` + `expect(html).toContain(...)`，其中**八条 `not.toContain`
 * 从写下那天起就不可能红** —— `#b8502d`、`#d7a08b`、扮演、roleplay、核心要求、是否金手指、频道、
 * 新建当前输入，`git grep` 全仓库只有那个测试文件自己命中。它们记的是上一版建档表单和「小说专用
 * 配色」被删掉这件事，删掉的东西不会自己回来，留着只是让人以为有护栏。所以：
 *  - 三条纯 archaeology 的用例（配色、无 roleplay、书库文案）整条删掉，
 *  - 其中真有意义的那部分 —— 建档页的文案与档位 —— 换成 `NovelCreatePage.test.tsx` 里对真组件的断言，
 *  - 第四条「两个面板冒烟」保留（那两个组件没有自己的用例文件），但换成按角色/文案查询。
 *
 * 与 `NovelWorkflowStudio.live.test.tsx` 分工：那边盯「引擎运行跑完 → 正文刷新」与「切写作模型」，
 * 这边盯其余的路径，两边都用探针替掉 `NovelWorkbenchShell`。
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NovelChapter,
  NovelProjectDetail,
  NovelProjectSummary,
  NovelTask,
  NovelWorkbenchPayload,
} from "../../api";
import { NovelChapterIntelligencePanel } from "./NovelChapterIntelligencePanel";
import { NovelReviewPanel } from "./NovelReviewPanel";
import { NovelWorkflowStudio } from "./NovelWorkflowStudio";
import { createDefaultNovelDraft, type NovelCreateDraft } from "./NovelCreatePage";

interface RewritePayload {
  readonly selectedText: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly instruction: string;
}

interface LibraryProbeProps {
  readonly projects: readonly { readonly id: string; readonly title: string }[];
  readonly loading: boolean;
  readonly isCreating: boolean;
  readonly error: string;
  readonly draft: NovelCreateDraft;
  readonly onDraftChange: (draft: NovelCreateDraft) => void;
  readonly onCreate: () => void;
  readonly onOpenProject: (projectId: string) => void;
  readonly onDeleteProject: (project: { readonly id: string; readonly title: string }) => void;
}

interface WizardProbeProps {
  readonly project: { readonly id: string; readonly title: string };
  readonly onClose: () => void;
  readonly onCompleted: () => void;
  readonly onProjectChanged: () => void;
}

interface ShellProbeProps {
  readonly selectedChapter: NovelChapter | null;
  readonly chapterLoading: boolean;
  readonly chapterLoadError: string;
  readonly onRetryChapter: () => void;
  readonly onRefresh: () => void;
  readonly selectedChapterId: string;
  readonly chapterTitle: string;
  readonly chapterContent: string;
  readonly saveStatus: string;
  readonly notice: string;
  readonly error: string;
  readonly onBackToLibrary: () => void;
  readonly onOpenSetup: () => void;
  readonly onSelectChapter: (chapterId: string) => void;
  readonly onCreateChapter: () => void;
  readonly onTitleChange: (value: string) => void;
  readonly onContentChange: (value: string) => void;
  readonly onRewrite: (payload: RewritePayload) => Promise<void>;
  readonly onAnalyze: () => void;
}

const api = vi.hoisted(() => ({
  analyzeNovelChapter: vi.fn(),
  createNovelProject: vi.fn(),
  deleteNovelProject: vi.fn(),
  getNovelEngineRun: vi.fn(),
  getNovelProject: vi.fn(),
  getNovelChapter: vi.fn(),
  getNovelWorkbench: vi.fn(),
  listNovelProjects: vi.fn(),
  rewriteNovelChapterSelection: vi.fn(),
  saveNovelChapter: vi.fn(),
  saveNovelChapterReview: vi.fn(),
  startNovelAssistedRun: vi.fn(),
  updateNovelProject: vi.fn(),
}));

/** 探针每次渲染都把 props 存下来，测试里直接调那些没做成按钮的回调。 */
const probe = vi.hoisted(() => ({
  library: null as LibraryProbeProps | null,
  wizard: null as WizardProbeProps | null,
  shell: null as ShellProbeProps | null,
}));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...api,
}));

vi.mock("../novel/NovelLibraryPage", () => ({
  NovelLibraryPage: (props: LibraryProbeProps) => {
    probe.library = props;
    return (
      <div>
        <p data-testid="library-state">{props.loading ? "loading" : `books:${props.projects.length}`}</p>
        <p data-testid="library-error">{props.error}</p>
        {props.projects.map((project) => (
          <div key={project.id}>
            <button type="button" onClick={() => props.onOpenProject(project.id)}>{`打开 ${project.title}`}</button>
            <button type="button" onClick={() => props.onDeleteProject(project)}>{`删除 ${project.title}`}</button>
          </div>
        ))}
        <button type="button" onClick={props.onCreate}>
          {props.isCreating ? "建档中" : "建档"}
        </button>
      </div>
    );
  },
}));

vi.mock("../novel/NovelSetupWizard", () => ({
  NovelSetupWizard: (props: WizardProbeProps) => {
    probe.wizard = props;
    return (
      <div role="dialog" aria-label="新书设置">
        <p data-testid="wizard-project">{props.project.title}</p>
        <button type="button" onClick={props.onCompleted}>
          完成设置
        </button>
      </div>
    );
  },
}));

vi.mock("../novel/NovelWorkbenchShell", () => ({
  NovelWorkbenchShell: (props: ShellProbeProps) => {
    probe.shell = props;
    return (
      <div role="main" aria-label="写作工作台">
        <p data-testid="selected-chapter">{props.selectedChapterId}</p>
        <p data-testid="chapter-title">{props.chapterTitle}</p>
        <p data-testid="chapter-content">{props.chapterContent}</p>
        <p data-testid="save-status">{props.saveStatus}</p>
        <p data-testid="shell-notice">{props.notice}</p>
        <p data-testid="shell-error">{props.error}</p>
        <button type="button" onClick={props.onBackToLibrary}>
          返回书库
        </button>
        <button type="button" onClick={props.onCreateChapter}>
          新建章节
        </button>
        <button type="button" onClick={props.onAnalyze}>
          分析章节
        </button>
      </div>
    );
  },
}));

const PROJECT: NovelProjectDetail["project"] = {
  id: "project-1",
  title: "长夜纪元",
  genre: "男频 · 东方玄幻",
  premise: "被逐出宗门的阵法师听见古阵残响。",
  settings: {},
  generationPrefs: {},
  targetChapters: 100,
  targetCharsPerChapter: 3200,
  setupStage: 5,
  setupCompleted: true,
  storyPhase: "middle",
  autopilotStatus: "idle",
  currentBranch: "main",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const PREMISE = "被逐出宗门的阵法师要在王朝封锁前修复失落阵图。";

function makeChapter(overrides: Partial<NovelChapter> = {}): NovelChapter {
  return {
    id: "chapter-1",
    volumeIndex: 1,
    chapterIndex: 1,
    title: "寒泉院",
    summary: "沈九泠发现锁灵坠。",
    outline: "入院、试阵、听见残响。",
    generationHint: "",
    content: "第一章正文。",
    consistencyJson: { status: "warning", quality: { score: 70, styleRisk: "medium" } },
    status: "ready",
    reviewStatus: "pending",
    reviewNotes: "",
    aiReview: "诊断：质量分 70 /100",
    aiActionItems: ["补足场景"],
    modificationRate: 0,
    billableChars: 6,
    lastTaskId: null,
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

const QUEUED_TASK: NovelTask = {
  id: "task-1",
  projectId: PROJECT.id,
  targetKind: "chapter",
  targetId: "chapter-1",
  status: "queued",
  progressPercent: 0,
  progressStage: "queued",
  progressMessage: null,
  progressPreview: "",
  streamedChars: 0,
  requestPayload: {},
  error: null,
  createdAt: PROJECT.updatedAt,
  updatedAt: PROJECT.updatedAt,
  completedAt: null,
  cancelledAt: null,
};

function makeDetail(
  project: Partial<NovelProjectDetail["project"]> = {},
  rest: { readonly chapters?: readonly NovelChapter[]; readonly tasks?: readonly NovelTask[] } = {},
): NovelProjectDetail {
  return {
    project: { ...PROJECT, ...project },
    bible: null,
    chapters: [...(rest.chapters ?? [makeChapter()])],
    tasks: [...(rest.tasks ?? [])],
  };
}

function makeWorkbench(chapters: readonly NovelChapter[] = [makeChapter()]): NovelWorkbenchPayload {
  return {
    project: {
      id: PROJECT.id,
      title: PROJECT.title,
      genre: PROJECT.genre,
      status: PROJECT.status,
      createdAt: PROJECT.createdAt,
      updatedAt: PROJECT.updatedAt,
    },
    stats: { totalWords: 6, finishedChapters: 1, completionRate: 1, averageWords: 6, lastUpdate: PROJECT.updatedAt },
    chapters: [...chapters],
    knowledgeFacts: [{ subject: "锁灵坠", predicate: "能力", object: "护住心脉" }],
    foreshadowItems: [{ title: "锁灵坠来历", status: "open", expectedPayoffChapter: 4 }],
    workbenchHighlights: {
      focusChapterNumber: 2,
      recommendedFocus: "回收伏笔",
      continuityAlerts: [{ title: "伏笔接近回收窗口", detail: "优先处理" }],
      microBeats: [{ index: 1, label: "场景落位", targetWords: 600, objective: "定位场景" }],
      focusCard: { mission: "推进主线", conflict: "制造阻力", endingHook: "留下问题" },
      qualitySnapshot: { consistencyStatus: "warning", styleRisk: "medium" },
      workflowGate: { status: "warning" },
    },
  };
}

function makeSummary(): NovelProjectSummary {
  return {
    id: PROJECT.id,
    title: PROJECT.title,
    genre: PROJECT.genre,
    premise: PROJECT.premise,
    status: PROJECT.status,
    setupStage: PROJECT.setupStage,
    setupCompleted: PROJECT.setupCompleted,
    targetChapters: PROJECT.targetChapters,
    chapterCount: 1,
    totalWords: 6,
    updatedAt: PROJECT.updatedAt,
  };
}

function libraryProps(): LibraryProbeProps {
  if (!probe.library) throw new Error("书库探针还没渲染");
  return probe.library;
}

function shellProps(): ShellProbeProps {
  if (!probe.shell) throw new Error("工作台探针还没渲染");
  return probe.shell;
}

/**
 * 假时钟全程开着（自动保存 850ms、任务轮询 2200ms 都得手动推），所以这里不用 RTL 的 `waitFor` /
 * `findBy*`：它们只认 jest 的假时钟，在 vitest 下会照真时间等，一等就是超时。取数与计时都走这个。
 */
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function setDraft(patch: Partial<NovelCreateDraft>) {
  const props = libraryProps();
  await act(async () => props.onDraftChange({ ...props.draft, ...patch }));
}

async function openWorkbench() {
  render(<NovelWorkflowStudio token="token" />);
  await advance();
  fireEvent.click(screen.getByRole("button", { name: "打开 长夜纪元" }));
  await advance();
}

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/");
  probe.library = null;
  probe.wizard = null;
  probe.shell = null;
  api.listNovelProjects.mockResolvedValue([makeSummary()]);
  api.getNovelProject.mockResolvedValue(makeDetail());
  api.getNovelWorkbench.mockResolvedValue(makeWorkbench());
  api.getNovelChapter.mockResolvedValue(makeChapter());
  api.deleteNovelProject.mockResolvedValue(undefined);
  api.saveNovelChapter.mockImplementation(
    async (_token: string, _projectId: string, chapterIndex: number, payload: Partial<NovelChapter>) =>
      makeChapter({
        ...payload,
        id: `chapter-${chapterIndex}`,
        chapterIndex,
        updatedAt: "2026-08-20T01:00:00.000Z",
      }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("NovelWorkflowStudio 书库与建档", () => {
  it("先交出加载态，取到书目再交给书库页", async () => {
    render(<NovelWorkflowStudio token="token" />);
    expect(screen.getByTestId("library-state")).toHaveTextContent("loading");

    await advance();

    expect(api.listNovelProjects).toHaveBeenCalledWith("token");
    expect(screen.getByTestId("library-state")).toHaveTextContent("books:1");
  });

  it("书目取数失败时把原因交给书库页", async () => {
    api.listNovelProjects.mockRejectedValue(new Error("上游 500"));
    render(<NovelWorkflowStudio token="token" />);

    await advance();

    expect(screen.getByTestId("library-error")).toHaveTextContent("上游 500");
  });

  it("失败原因不是 Error 时用兜底文案", async () => {
    api.listNovelProjects.mockRejectedValue({ status: 503 });
    render(<NovelWorkflowStudio token="token" />);

    await advance();

    expect(screen.getByTestId("library-error")).toHaveTextContent("加载小说书库失败");
  });

  /**
   * hash 直达走的是另一条路：它只 `refreshProject` 然后进工作台，**不看 `setupCompleted`** ——
   * 而点封面进来的 `openProject` 会先拦一道。这是定下来的分工：链接分享要能落到工作台上，
   * 不拿向导把人按住；「设置没做完」改由工作台里那条警告条说（见 NovelWorkbenchShell.test.tsx）。
   */
  it("hash 里带项目 id 就直接进工作台，设置没做完也不改道去向导", async () => {
    window.history.replaceState(null, "", "/#novel/project-1/workbench");
    api.getNovelProject.mockResolvedValue(makeDetail({ setupCompleted: false, setupStage: 2 }));
    render(<NovelWorkflowStudio token="token" />);

    await advance();

    expect(api.getNovelProject).toHaveBeenCalledWith("token", "project-1", true);
    expect(screen.getByRole("main", { name: "写作工作台" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "新书设置" })).not.toBeInTheDocument();
  });

  it("hash 指向的作品打不开就留在书库", async () => {
    window.history.replaceState(null, "", "/#novel/project-9/workbench");
    api.getNovelProject.mockRejectedValue(new Error("作品不存在"));
    render(<NovelWorkflowStudio token="token" />);

    await advance();

    expect(screen.getByTestId("library-error")).toHaveTextContent("作品不存在");
    expect(screen.queryByRole("main", { name: "写作工作台" })).not.toBeInTheDocument();
  });

  it("打开还没做完设置的作品先开向导，不进工作台也不写 hash", async () => {
    api.getNovelProject.mockResolvedValue(makeDetail({ setupCompleted: false, setupStage: 1 }));
    render(<NovelWorkflowStudio token="token" />);
    await advance();

    fireEvent.click(screen.getByRole("button", { name: "打开 长夜纪元" }));
    await advance();

    expect(screen.getByRole("dialog", { name: "新书设置" })).toBeInTheDocument();
    expect(screen.getByTestId("wizard-project")).toHaveTextContent("长夜纪元");
    expect(screen.queryByRole("main", { name: "写作工作台" })).not.toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });

  it("向导报完成后刷一遍作品并进工作台", async () => {
    api.getNovelProject
      .mockResolvedValueOnce(makeDetail({ setupCompleted: false, setupStage: 1 }))
      .mockResolvedValue(makeDetail());
    render(<NovelWorkflowStudio token="token" />);
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "打开 长夜纪元" }));
    await advance();

    fireEvent.click(screen.getByRole("button", { name: "完成设置" }));
    await advance();

    expect(screen.getByRole("main", { name: "写作工作台" })).toBeInTheDocument();
    expect(screen.getByTestId("shell-notice")).toHaveTextContent("新书叙事基座已就绪");
    expect(screen.queryByRole("dialog", { name: "新书设置" })).not.toBeInTheDocument();
  });

  it("打开已完成设置的作品进工作台，并把项目 id 写进 hash", async () => {
    render(<NovelWorkflowStudio token="token" />);
    await advance();

    fireEvent.click(screen.getByRole("button", { name: "打开 长夜纪元" }));
    await advance();

    expect(screen.getByRole("main", { name: "写作工作台" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#novel/project-1/workbench");
    expect(screen.getByTestId("selected-chapter")).toHaveTextContent("chapter-1");
    expect(screen.getByTestId("chapter-title")).toHaveTextContent("寒泉院");
  });

  it("梗概不到一句话就不发建档请求", async () => {
    render(<NovelWorkflowStudio token="token" />);
    await advance();

    fireEvent.click(screen.getByRole("button", { name: "建档" }));
    await advance();

    expect(api.createNovelProject).not.toHaveBeenCalled();
    expect(screen.getByTestId("library-error")).toHaveTextContent("请先用一段话写清故事梗概");
  });

  it("章节数或每章字数越界就不发建档请求", async () => {
    render(<NovelWorkflowStudio token="token" />);
    await advance();

    await setDraft({ premise: PREMISE, chapterCount: "0" });
    fireEvent.click(screen.getByRole("button", { name: "建档" }));
    await advance();
    expect(screen.getByTestId("library-error")).toHaveTextContent("请检查章节数与每章字数");

    await setDraft({ chapterCount: "100", chapterChars: "100" });
    fireEvent.click(screen.getByRole("button", { name: "建档" }));
    await advance();
    expect(screen.getByTestId("library-error")).toHaveTextContent("请检查章节数与每章字数");
    expect(api.createNovelProject).not.toHaveBeenCalled();
  });

  it("建档把草稿整份下发，成功后清空草稿并打开新书设置向导", async () => {
    const base = createDefaultNovelDraft();
    let settle: (created: NovelProjectDetail) => void = () => undefined;
    api.createNovelProject.mockReturnValue(
      new Promise<NovelProjectDetail>((resolve) => {
        settle = resolve;
      }),
    );
    render(<NovelWorkflowStudio token="token" />);
    await advance();
    await setDraft({ title: "长夜纪元", premise: `  ${PREMISE}  ` });

    fireEvent.click(screen.getByRole("button", { name: "建档" }));
    await advance();

    expect(screen.getByRole("button", { name: "建档中" })).toBeInTheDocument();
    expect(api.createNovelProject).toHaveBeenCalledWith("token", {
      title: "长夜纪元",
      premise: PREMISE,
      genre: "男频 · 东方玄幻",
      worldPreset: base.worldPreset,
      storyStructure: base.storyStructure,
      pacingControl: base.pacingControl,
      writingStyle: base.writingStyle,
      specialRequirements: base.specialRequirements,
      targetChapters: 100,
      targetCharsPerChapter: 3000,
    });

    settle(makeDetail({ id: "project-2", setupCompleted: false, setupStage: 0 }));
    await advance();

    expect(screen.getByRole("dialog", { name: "新书设置" })).toBeInTheDocument();
    expect(screen.getByTestId("library-state")).toHaveTextContent("books:2");
    expect(libraryProps().draft.premise).toBe("");
  });

  it("建档失败时留住草稿并说明原因", async () => {
    api.createNovelProject.mockRejectedValue(new Error("配额不足"));
    render(<NovelWorkflowStudio token="token" />);
    await advance();
    await setDraft({ premise: PREMISE });

    fireEvent.click(screen.getByRole("button", { name: "建档" }));
    await advance();

    expect(screen.getByTestId("library-error")).toHaveTextContent("配额不足");
    expect(libraryProps().draft.premise).toBe(PREMISE);
    expect(screen.queryByRole("dialog", { name: "新书设置" })).not.toBeInTheDocument();
  });

  it("删除要先确认，取消就什么都不做", async () => {
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<NovelWorkflowStudio token="token" />);
    await advance();

    fireEvent.click(screen.getByRole("button", { name: "删除 长夜纪元" }));
    await advance();

    expect(confirmed).toHaveBeenCalledWith("确定删除《长夜纪元》吗？小说数据会被完整删除。");
    expect(api.deleteNovelProject).not.toHaveBeenCalled();
    expect(screen.getByTestId("library-state")).toHaveTextContent("books:1");

    confirmed.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除 长夜纪元" }));
    await advance();

    expect(api.deleteNovelProject).toHaveBeenCalledWith("token", "project-1");
    expect(screen.getByTestId("library-state")).toHaveTextContent("books:0");
  });

  it("删除失败时把作品留在列表里", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.deleteNovelProject.mockRejectedValue(new Error("作品正在生成中"));
    render(<NovelWorkflowStudio token="token" />);
    await advance();

    fireEvent.click(screen.getByRole("button", { name: "删除 长夜纪元" }));
    await advance();

    expect(screen.getByTestId("library-error")).toHaveTextContent("作品正在生成中");
    expect(screen.getByTestId("library-state")).toHaveTextContent("books:1");
  });
});

describe("NovelWorkflowStudio 工作台", () => {
  it("刚进工作台没有待存的改动，状态停在 idle", async () => {
    await openWorkbench();

    expect(screen.getByTestId("save-status")).toHaveTextContent("idle");
    expect(api.saveNovelChapter).not.toHaveBeenCalled();
  });

  it("停手 850 毫秒才保存，「已保存」不会被自己那次刷新顶掉", async () => {
    await openWorkbench();

    await act(async () => shellProps().onTitleChange("  寒泉院（改）  "));
    await act(async () => shellProps().onContentChange("改过的第一章正文。"));
    expect(screen.getByTestId("save-status")).toHaveTextContent("saving");

    await advance(400);
    expect(api.saveNovelChapter).not.toHaveBeenCalled();

    await advance(500);
    expect(api.saveNovelChapter).toHaveBeenCalledWith("token", "project-1", 1, {
      title: "寒泉院（改）",
      summary: "沈九泠发现锁灵坠。",
      outline: "入院、试阵、听见残响。",
      generationHint: "",
      content: "改过的第一章正文。",
    });
    expect(screen.getByTestId("save-status")).toHaveTextContent("saved");
    expect(screen.getByTestId("chapter-content")).toHaveTextContent("改过的第一章正文。");

    // 存回来的那一章 `updatedAt` 变了，重置 effect 会再跑一遍：同一章、内容一致，就不该刷回 idle。
    await advance(900);
    expect(screen.getByTestId("save-status")).toHaveTextContent("saved");
    expect(api.saveNovelChapter).toHaveBeenCalledTimes(1);
  });

  it("自动保存失败时把状态写成 error 并说明原因", async () => {
    await openWorkbench();
    api.saveNovelChapter.mockRejectedValue(new Error("章节被锁定"));

    await act(async () => shellProps().onContentChange("改过的正文。"));
    await advance(900);

    expect(screen.getByTestId("save-status")).toHaveTextContent("error");
    expect(screen.getByTestId("shell-error")).toHaveTextContent("章节被锁定");
  });

  it("换章把编辑器换成那一章，不留下待存状态", async () => {
    const second = makeChapter({
      id: "chapter-2",
      chapterIndex: 2,
      title: "锁灵坠",
      summary: "",
      outline: "",
      content: "第二章正文。",
    });
    api.getNovelProject.mockResolvedValue(makeDetail({}, { chapters: [makeChapter(), second] }));
    api.getNovelWorkbench.mockResolvedValue(makeWorkbench([makeChapter(), second]));
    await openWorkbench();

    await act(async () => shellProps().onSelectChapter("chapter-2"));
    await advance(900);

    expect(screen.getByTestId("selected-chapter")).toHaveTextContent("chapter-2");
    expect(screen.getByTestId("chapter-title")).toHaveTextContent("锁灵坠");
    expect(screen.getByTestId("chapter-content")).toHaveTextContent("第二章正文。");
    expect(screen.getByTestId("save-status")).toHaveTextContent("idle");
    expect(api.saveNovelChapter).not.toHaveBeenCalled();
  });

  it("新建章节接在末尾并选中它", async () => {
    await openWorkbench();

    fireEvent.click(screen.getByRole("button", { name: "新建章节" }));
    await advance();

    expect(api.saveNovelChapter).toHaveBeenCalledWith("token", "project-1", 2, {
      title: "第 2 章",
      summary: "",
      outline: "",
      generationHint: "",
      content: "",
    });
    expect(screen.getByTestId("selected-chapter")).toHaveTextContent("chapter-2");
    expect(screen.getByTestId("chapter-title")).toHaveTextContent("第 2 章");
  });

  it("正文还没落盘就不许改写", async () => {
    await openWorkbench();

    await act(async () => shellProps().onContentChange("改到一半的正文。"));
    await expect(
      shellProps().onRewrite({ selectedText: "改到一半", selectionStart: 0, selectionEnd: 4, instruction: "更紧张" }),
    ).rejects.toThrow("请等待当前修改自动保存后再改写");

    expect(api.rewriteNovelChapterSelection).not.toHaveBeenCalled();
  });

  it("章节分析回来的整章写回两份状态", async () => {
    api.analyzeNovelChapter.mockResolvedValue(
      makeChapter({ aiReview: "诊断：质量分 88 /100", content: "分析后回填的正文。", updatedAt: "2026-08-21T00:00:00.000Z" }),
    );
    await openWorkbench();

    fireEvent.click(screen.getByRole("button", { name: "分析章节" }));
    await advance();

    expect(api.analyzeNovelChapter).toHaveBeenCalledWith("token", "project-1", 1);
    expect(screen.getByTestId("shell-notice")).toHaveTextContent("章节质量、连续性与叙事资产已刷新");
    expect(screen.getByTestId("chapter-content")).toHaveTextContent("分析后回填的正文。");
  });

  /**
   * 轮询的依赖只认「项目 id + 有没有在跑的任务」，所以每 2.2 秒该只多一次请求 —— 依赖写成整个 `detail`
   * 时这个 interval 会被每轮刷新拆掉重建。任务跑完（返回里没有 queued/running）就该停下来。
   */
  it("有任务在跑就每 2.2 秒刷一次，任务没了就停", async () => {
    api.getNovelProject
      .mockResolvedValueOnce(makeDetail({}, { tasks: [QUEUED_TASK] }))
      .mockResolvedValueOnce(makeDetail({}, { tasks: [QUEUED_TASK] }))
      .mockResolvedValue(makeDetail());
    await openWorkbench();
    expect(api.getNovelProject).toHaveBeenCalledTimes(1);

    await advance(2200);
    expect(api.getNovelProject).toHaveBeenCalledTimes(2);

    await advance(2200);
    expect(api.getNovelProject).toHaveBeenCalledTimes(3);

    await advance(4400);
    expect(api.getNovelProject).toHaveBeenCalledTimes(3);
  });

  it("返回书库会清掉 hash 并重新取一遍书目", async () => {
    await openWorkbench();
    expect(window.location.hash).toBe("#novel/project-1/workbench");

    fireEvent.click(screen.getByRole("button", { name: "返回书库" }));
    await advance();

    expect(screen.getByTestId("library-state")).toHaveTextContent("books:1");
    expect(screen.queryByRole("main", { name: "写作工作台" })).not.toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(api.listNovelProjects).toHaveBeenCalledTimes(2);
  });
});

/**
 * 这两个面板没有自己的用例文件，所以冒烟留在这里：容器的用例把 `NovelWorkbenchShell` 换成了探针，
 * 面板在探针后面永远渲染不到。断言只认面板标题，别的交给 `NovelChapterDesk` 那些用例。
 */
describe("小说工作台情报面板", () => {
  it("渲染章节情报、质量诊断与审阅三块", () => {
    const workbench = makeWorkbench();
    render(
      <>
        <NovelChapterIntelligencePanel chapter={workbench.chapters[0] ?? null} workbench={workbench} />
        <NovelReviewPanel
          chapter={workbench.chapters[0] ?? null}
          isSaving={false}
          onSave={() => undefined}
          onAnalyze={() => undefined}
        />
      </>,
    );

    expect(screen.getByText("章节情报")).toBeInTheDocument();
    expect(screen.getByText("质量诊断")).toBeInTheDocument();
    expect(screen.getByText("审阅")).toBeInTheDocument();
  });
});





describe("NovelWorkflowStudio compact reads", () => {
  function directory(chapters = [makeChapter()]) {
    return makeDetail({}, { chapters: chapters.map((chapter) => ({ ...chapter, content: "", rawContent: undefined, contextSnapshot: undefined, detailLoaded: false, hasContent: true })) });
  }

  it("loads only the selected chapter and cannot autosave an unloaded directory entry", async () => {
    let resolve!: (chapter: NovelChapter) => void;
    api.getNovelProject.mockResolvedValue(directory());
    api.getNovelWorkbench.mockResolvedValue(makeWorkbench([]));
    api.getNovelChapter.mockImplementationOnce(() => new Promise<NovelChapter>((done) => { resolve = done; }));
    await openWorkbench();
    expect(api.getNovelProject).toHaveBeenCalledWith("token", "project-1", true);
    expect(api.getNovelWorkbench).toHaveBeenCalledWith("token", "project-1", true);
    expect(api.getNovelChapter).toHaveBeenCalledWith("token", "project-1", 1);
    expect(shellProps().selectedChapter).toBeNull();
    expect(shellProps().chapterLoading).toBe(true);
    await advance(2000);
    expect(api.saveNovelChapter).not.toHaveBeenCalled();
    await act(async () => resolve(makeChapter()));
    expect(shellProps().chapterContent).toBe(makeChapter().content);
    expect(shellProps().chapterLoading).toBe(false);
    await act(async () => shellProps().onRefresh());
    await advance();
    expect(api.getNovelChapter).toHaveBeenCalledTimes(1);
    expect(api.saveNovelChapter).not.toHaveBeenCalled();
  });

  it("ignores a late chapter response after switching chapters", async () => {
    const second = makeChapter({ id: "chapter-2", chapterIndex: 2, content: "第二章正文" });
    let resolve!: (chapter: NovelChapter) => void;
    api.getNovelProject.mockResolvedValue(directory([makeChapter(), second]));
    api.getNovelChapter.mockImplementationOnce(() => new Promise<NovelChapter>((done) => { resolve = done; })).mockResolvedValueOnce(second);
    await openWorkbench();
    await act(async () => shellProps().onSelectChapter("chapter-2"));
    await advance();
    expect(shellProps().chapterContent).toBe("第二章正文");
    await act(async () => resolve(makeChapter()));
    expect(shellProps().chapterContent).toBe("第二章正文");
    expect(api.saveNovelChapter).not.toHaveBeenCalled();
  });

  it("shows a retryable load failure and retries without saving an empty chapter", async () => {
    api.getNovelProject.mockResolvedValue(directory());
    api.getNovelChapter.mockRejectedValueOnce(new Error("网络暂不可用")).mockResolvedValueOnce(makeChapter());
    await openWorkbench();
    expect(shellProps().chapterLoadError).toBe("网络暂不可用");
    expect(shellProps().selectedChapter).toBeNull();
    await act(async () => shellProps().onRetryChapter());
    await advance();
    expect(shellProps().chapterContent).toBe(makeChapter().content);
    expect(api.getNovelChapter).toHaveBeenCalledTimes(2);
    expect(api.saveNovelChapter).not.toHaveBeenCalled();
  });

  it("does not overlap slow polls and ignores refreshes after leaving the project", async () => {
    api.getNovelProject.mockResolvedValueOnce(makeDetail({}, { tasks: [QUEUED_TASK] }));
    await openWorkbench();
    let resolve!: (detail: NovelProjectDetail) => void;
    api.getNovelProject.mockImplementationOnce(() => new Promise<NovelProjectDetail>((done) => { resolve = done; }));
    await advance(8800);
    expect(api.getNovelProject).toHaveBeenCalledTimes(2);
    expect(api.getNovelWorkbench).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "返回书库" }));
    await act(async () => resolve(makeDetail()));
    expect(screen.queryByRole("main", { name: "写作工作台" })).not.toBeInTheDocument();
  });

  it("keeps a dirty draft when a compact refresh reports a newer chapter version", async () => {
    api.getNovelProject.mockResolvedValue(directory());
    await openWorkbench();
    await act(async () => shellProps().onContentChange("尚未保存的修改"));
    api.getNovelProject.mockResolvedValue(directory([makeChapter({ updatedAt: "2026-09-19T00:00:00Z" })]));
    await act(async () => shellProps().onRefresh());
    await advance();
    expect(shellProps().chapterContent).toBe("尚未保存的修改");
    expect(api.getNovelChapter).toHaveBeenCalledTimes(1);
  });
});
