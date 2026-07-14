// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NovelProjectDetail, NovelSetupPayload } from "../../api";
import { NovelSetupWizard } from "./NovelSetupWizard";

const api = vi.hoisted(() => ({
  completeNovelSetup: vi.fn(),
  generateNovelSetup: vi.fn(),
  getNovelSetup: vi.fn(),
  saveNovelSetup: vi.fn(),
}));

vi.mock("../../api", () => api);

const project: NovelProjectDetail["project"] = {
  id: "project-1",
  title: "寒泉烬",
  genre: "东方玄幻",
  premise: "沈氏后人追查家族旧案。",
  settings: {},
  targetChapters: 100,
  targetCharsPerChapter: 3000,
  setupStage: 1,
  setupCompleted: false,
  storyPhase: "opening",
  autopilotStatus: "idle",
  currentBranch: "main",
  status: "active",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

const emptySetup: NovelSetupPayload = {
  project: { id: project.id, setupStage: 1, setupCompleted: false },
  bible: null,
  characters: [],
  relations: [],
  locations: [],
  storylines: [],
  structure: [],
  chapters: [],
  activeTask: null,
  latestTask: null,
};

const generatedBible: NovelSetupPayload = {
  ...emptySetup,
  project: { id: project.id, setupStage: 2, setupCompleted: false },
  bible: {
    worldDimensions: [{ id: "world-1", dimensionKey: "coreRules", title: "核心法则", summary: "灵力守恒" }],
    styleNotes: [{ id: "style-1", category: "narrativeVoice", title: "叙事声音", content: "第三人称限知" }],
  },
};

function renderWizard(projectOverride: Partial<NovelProjectDetail["project"]> = {}) {
  return render(
    <NovelSetupWizard
      token="token"
      project={{ ...project, ...projectOverride }}
      onClose={vi.fn()}
      onCompleted={vi.fn()}
    />,
  );
}

describe("NovelSetupWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.completeNovelSetup.mockResolvedValue({ id: project.id, setupStage: 5, setupCompleted: true });
    api.generateNovelSetup.mockResolvedValue({});
    api.saveNovelSetup.mockResolvedValue(undefined);
  });

  it("生成完成后停留在当前步骤展示结果，不自动跳到下一步", async () => {
    api.getNovelSetup
      .mockResolvedValueOnce(emptySetup)
      .mockResolvedValueOnce(generatedBible);

    renderWizard();
    await screen.findByText("准备生成文风 / 世界观");
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    expect(await screen.findByText("灵力守恒")).toBeVisible();
    expect(screen.getByRole("button", { name: /1\. 文风 \/ 世界观/ })).toHaveAttribute("aria-current", "step");
    expect(screen.queryByText("准备生成人物")).toBeNull();
  });

  it("展示 Worker 回传的真实进度与模型流式输出", async () => {
    const activeTask = {
      id: "task-1",
      projectId: project.id,
      targetKind: "setupBible",
      targetId: null,
      status: "running" as const,
      progressPercent: 47,
      progressStage: "streaming",
      progressMessage: "模型正在流式生成，已接收 842 字",
      progressPreview: "{\"styleGuide\":{\"narrativeVoice\":\"第三人称限知\"}",
      streamedChars: 842,
      requestPayload: {},
      error: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:01.000Z",
      completedAt: null,
      cancelledAt: null,
    };
    api.getNovelSetup.mockResolvedValue({
      ...emptySetup,
      activeTask,
      latestTask: activeTask,
    } satisfies NovelSetupPayload);

    renderWizard();

    expect(await screen.findByText("模型正在流式生成，已接收 842 字")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "文风 / 世界观生成进度" })).toHaveAttribute("aria-valuenow", "47");
    expect(screen.getByText("47%")).toBeVisible();
    expect(screen.getByText("AI 实时输出")).toBeVisible();
    expect(screen.getByText(/第三人称限知/)).toBeVisible();
  });

  it("只在任务所属步骤显示生成状态，返回地图时展示已生成地图", async () => {
    const plotTask = {
      id: "task-plot",
      projectId: project.id,
      targetKind: "setupPlot",
      targetId: null,
      status: "running" as const,
      progressPercent: 48,
      progressStage: "streaming",
      progressMessage: "正在生成剧情总纲",
      progressPreview: "{\"storylines\":[]}",
      streamedChars: 900,
      requestPayload: {},
      error: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:01.000Z",
      completedAt: null,
      cancelledAt: null,
    };
    api.getNovelSetup.mockResolvedValue({
      ...emptySetup,
      project: { id: project.id, setupStage: 4, setupCompleted: false },
      locations: [{ id: "location-1", name: "程序员避难所", description: "主角团队据点", rules: "禁止暴露坐标" }],
      activeTask: plotTask,
      latestTask: plotTask,
    } satisfies NovelSetupPayload);

    renderWizard({ setupStage: 4 });
    await screen.findByRole("progressbar", { name: "剧情总纲生成进度" });
    fireEvent.click(screen.getByRole("button", { name: /3\. 地图/ }));

    expect(await screen.findByText("程序员避难所")).toBeVisible();
    expect(screen.queryByText("正在生成地图")).toBeNull();
  });

  it("异步生成失败后展示错误并允许直接重试", async () => {
    api.getNovelSetup.mockResolvedValue({
      ...emptySetup,
      project: { id: project.id, setupStage: 4, setupCompleted: false },
      latestTask: {
        id: "task-failed",
        projectId: project.id,
        targetKind: "setupPlot",
        targetId: null,
        status: "failed",
        progressPercent: 86,
        progressStage: "failed",
        progressMessage: "写入失败",
        progressPreview: "",
        streamedChars: 8000,
        requestPayload: {},
        error: "Unique constraint failed on storyline milestones",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:02:00.000Z",
        completedAt: null,
        cancelledAt: null,
      },
    } satisfies NovelSetupPayload);

    renderWizard({ setupStage: 4 });

    expect(await screen.findByText("剧情总纲生成失败")).toBeVisible();
    expect(screen.getByText("Unique constraint failed on storyline milestones")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新生成剧情总纲" })).toBeEnabled();
  });

  it("完成设置后可返回任意已完成步骤查看结果", async () => {
    const completedSetup: NovelSetupPayload = {
      ...generatedBible,
      project: { id: project.id, setupStage: 5, setupCompleted: true },
    };
    api.getNovelSetup.mockResolvedValue(completedSetup);

    renderWizard({ setupStage: 5, setupCompleted: true });
    await screen.findByText("叙事基座已经就绪");
    fireEvent.click(screen.getByRole("button", { name: /1\. 文风 \/ 世界观/ }));

    await waitFor(() => expect(screen.getByText("灵力守恒")).toBeVisible());
    expect(screen.getByRole("button", { name: /1\. 文风 \/ 世界观/ })).toHaveAttribute("aria-current", "step");
    expect(api.getNovelSetup).toHaveBeenCalledTimes(1);
  });
});
