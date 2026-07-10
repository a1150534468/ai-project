// @vitest-environment jsdom

import { act, type ChangeEvent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS,
  createDefaultLocalBusinessPromoSettings,
  createEmptyLocalBusinessPromoAudioState,
  createEmptyLocalBusinessPromoBrief,
  createEmptyLocalBusinessPromoMaterials,
} from "./localBusinessPromoWorkflowModel";
import { useLocalBusinessPromoWorkflowStudio, type LocalBusinessPromoWorkflowStudioController } from "./useLocalBusinessPromoWorkflowStudio";
import type {
  LocalBusinessPromoProject,
  LocalBusinessPromoProjectSummary,
  LocalBusinessPromoRun,
  LocalBusinessPromoState,
} from "../../workflowLocalBusinessPromoApi";

const toastMocks = vi.hoisted(() => ({
  show: vi.fn(),
}));

const videoApiMocks = vi.hoisted(() => ({
  uploadWorkflowVideoMaterial: vi.fn(),
}));

const workflowApiMocks = vi.hoisted(() => ({
  createLocalBusinessPromoProject: vi.fn(),
  generateLocalBusinessPromoBgm: vi.fn(),
  generateLocalBusinessPromoNarration: vi.fn(),
  generateLocalBusinessPromoScript: vi.fn(),
  generateLocalBusinessPromoVideo: vi.fn(),
  getLocalBusinessPromoOptions: vi.fn(),
  getLocalBusinessPromoState: vi.fn(),
  listLocalBusinessPromoProjects: vi.fn(),
  previewLocalBusinessPromoBgm: vi.fn(),
  previewLocalBusinessPromoNarration: vi.fn(),
  updateLocalBusinessPromoActiveAudio: vi.fn(),
  updateLocalBusinessPromoProject: vi.fn(),
  updateLocalBusinessPromoScript: vi.fn(),
  uploadLocalBusinessPromoBgm: vi.fn(),
  uploadLocalBusinessPromoVoiceSample: vi.fn(),
}));

vi.mock("../../motion", () => ({
  useToast: () => toastMocks,
}));

vi.mock("../../videoApi", () => ({
  uploadWorkflowVideoMaterial: videoApiMocks.uploadWorkflowVideoMaterial,
}));

vi.mock("../../workflowLocalBusinessPromoApi", async () => {
  const actual = await vi.importActual<typeof import("../../workflowLocalBusinessPromoApi")>("../../workflowLocalBusinessPromoApi");
  return {
    ...actual,
    createLocalBusinessPromoProject: workflowApiMocks.createLocalBusinessPromoProject,
    generateLocalBusinessPromoBgm: workflowApiMocks.generateLocalBusinessPromoBgm,
    generateLocalBusinessPromoNarration: workflowApiMocks.generateLocalBusinessPromoNarration,
    generateLocalBusinessPromoScript: workflowApiMocks.generateLocalBusinessPromoScript,
    generateLocalBusinessPromoVideo: workflowApiMocks.generateLocalBusinessPromoVideo,
    getLocalBusinessPromoOptions: workflowApiMocks.getLocalBusinessPromoOptions,
    getLocalBusinessPromoState: workflowApiMocks.getLocalBusinessPromoState,
    listLocalBusinessPromoProjects: workflowApiMocks.listLocalBusinessPromoProjects,
    previewLocalBusinessPromoBgm: workflowApiMocks.previewLocalBusinessPromoBgm,
    previewLocalBusinessPromoNarration: workflowApiMocks.previewLocalBusinessPromoNarration,
    updateLocalBusinessPromoActiveAudio: workflowApiMocks.updateLocalBusinessPromoActiveAudio,
    updateLocalBusinessPromoProject: workflowApiMocks.updateLocalBusinessPromoProject,
    updateLocalBusinessPromoScript: workflowApiMocks.updateLocalBusinessPromoScript,
    uploadLocalBusinessPromoBgm: workflowApiMocks.uploadLocalBusinessPromoBgm,
    uploadLocalBusinessPromoVoiceSample: workflowApiMocks.uploadLocalBusinessPromoVoiceSample,
  };
});

function makeProject(overrides: Partial<LocalBusinessPromoProject> = {}): LocalBusinessPromoProject {
  return {
    id: "project-1",
    title: "禾木咖啡",
    brief: {
      ...createEmptyLocalBusinessPromoBrief(),
      storeName: "禾木咖啡",
      industry: "精品咖啡",
      cityArea: "上海静安",
      targetCustomers: "周边白领",
      mainOffer: "招牌拿铁",
      sellingPoints: "稳定出品",
    },
    materials: createEmptyLocalBusinessPromoMaterials(),
    settings: createDefaultLocalBusinessPromoSettings(),
    scriptDraft: "第一行\n第二行\n第三行",
    latestRunId: null,
    status: "draft",
    createdAt: "2026-07-07T08:00:00.000Z",
    updatedAt: "2026-07-07T08:00:00.000Z",
    ...overrides,
  };
}

function makeSummary(project: LocalBusinessPromoProject): LocalBusinessPromoProjectSummary {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    latestRunId: project.latestRunId,
    materialCount: Object.values(project.materials).reduce((sum, items) => sum + items.length, 0),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function makeRun(overrides: Partial<LocalBusinessPromoRun> = {}): LocalBusinessPromoRun {
  return {
    id: "run-1",
    projectId: "project-1",
    settingsSnapshot: createDefaultLocalBusinessPromoSettings(),
    scriptSnapshot: "第一行\n第二行\n第三行",
    shotPlan: [],
    mergedAssetId: null,
    mergedAsset: null,
    status: "running",
    progressPercent: 25,
    progressStage: "rendering",
    progressMessage: "处理中",
    error: null,
    createdAt: "2026-07-07T08:10:00.000Z",
    updatedAt: "2026-07-07T08:10:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function makeState(project: LocalBusinessPromoProject, run: LocalBusinessPromoRun | null): LocalBusinessPromoState {
  return {
    project,
    latestRun: run,
    runs: run ? [run] : [],
    audio: createEmptyLocalBusinessPromoAudioState(),
  };
}

async function flushEffects(iterations = 3): Promise<void> {
  for (let attempt = 0; attempt < iterations; attempt += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function Harness(props: {
  readonly onBalanceRefresh?: () => void;
  readonly initialProject: LocalBusinessPromoProject;
  readonly initialLatestRun?: LocalBusinessPromoRun | null;
  readonly initialRuns?: readonly LocalBusinessPromoRun[];
  readonly onReady: (controller: LocalBusinessPromoWorkflowStudioController) => void;
}) {
  const controller = useLocalBusinessPromoWorkflowStudio({
    token: "token",
    onBalanceRefresh: props.onBalanceRefresh,
    initialOptions: LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS,
    initialProjects: [makeSummary(props.initialProject)],
    initialProject: props.initialProject,
    initialLatestRun: props.initialLatestRun ?? null,
    initialRuns: props.initialRuns ?? [],
    initialAudioState: createEmptyLocalBusinessPromoAudioState(),
    initialBootstrapping: false,
  });

  props.onReady(controller);
  return (
    <div>
      <div data-testid="notice">{controller.state.notice}</div>
      <div data-testid="error">{controller.state.error}</div>
      <div data-testid="opening-count">{controller.state.project?.materials.opening.length ?? -1}</div>
    </div>
  );
}

describe("useLocalBusinessPromoWorkflowStudio", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    toastMocks.show.mockReset();
    workflowApiMocks.getLocalBusinessPromoOptions.mockResolvedValue(LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS);
    workflowApiMocks.listLocalBusinessPromoProjects.mockResolvedValue([]);
    workflowApiMocks.getLocalBusinessPromoState.mockReset();
    workflowApiMocks.updateLocalBusinessPromoProject.mockReset();
    videoApiMocks.uploadWorkflowVideoMaterial.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("refreshes balance once polling sees the run leave the busy state", async () => {
    const runningProject = makeProject({ latestRunId: "run-1", status: "generating" });
    const runningRun = makeRun();
    const failedProject = { ...runningProject, status: "failed", updatedAt: "2026-07-07T08:15:00.000Z" } satisfies LocalBusinessPromoProject;
    const failedRun = makeRun({
      status: "failed",
      progressPercent: 100,
      progressStage: "failed",
      progressMessage: "失败",
      error: "任务失败",
      updatedAt: "2026-07-07T08:15:00.000Z",
      completedAt: "2026-07-07T08:15:00.000Z",
    });
    const onBalanceRefresh = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let controller!: LocalBusinessPromoWorkflowStudioController;

    workflowApiMocks.getLocalBusinessPromoState.mockResolvedValue(makeState(failedProject, failedRun));

    await act(async () => {
      root.render(
        <Harness
          initialProject={runningProject}
          initialLatestRun={runningRun}
          initialRuns={[runningRun]}
          onBalanceRefresh={onBalanceRefresh}
          onReady={(nextController) => { controller = nextController; }}
        />,
      );
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    await flushEffects();

    expect(workflowApiMocks.getLocalBusinessPromoState).toHaveBeenCalledWith("token", "project-1");
    expect(controller.state.latestRun?.status).toBe("failed");
    expect(onBalanceRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("does not show a success toast when material upload saves fail", async () => {
    const project = makeProject();
    const uploaded = {
      url: "https://example.test/opening.mp4",
      mime: "video/mp4",
      name: "门头.mp4",
      durationSec: 8,
    };
    const saveBlocked = createDeferred();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let controller!: LocalBusinessPromoWorkflowStudioController;

    videoApiMocks.uploadWorkflowVideoMaterial.mockResolvedValue(uploaded);
    workflowApiMocks.updateLocalBusinessPromoProject.mockImplementation(async () => {
      await saveBlocked.promise;
      throw new Error("数据库暂时不可用");
    });

    await act(async () => {
      root.render(
        <Harness
          initialProject={project}
          onReady={(nextController) => { controller = nextController; }}
        />,
      );
    });
    await flushEffects();

    const file = new File(["video"], "门头.mp4", { type: "video/mp4" });
    await act(async () => {
      controller.actions.openUploadPicker("opening");
    });
    await flushEffects();
    await act(async () => {
      const input = document.createElement("input");
      Object.defineProperty(input, "files", { value: [file] });
      controller.actions.onUploadInputChange({
        target: input,
        currentTarget: input,
      } as unknown as ChangeEvent<HTMLInputElement>);
      await Promise.resolve();
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="opening-count"]')?.textContent).toBe("1");

    await act(async () => {
      saveBlocked.resolve();
      await Promise.resolve();
    });
    await flushEffects(5);

    expect(workflowApiMocks.updateLocalBusinessPromoProject).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="notice"]')?.textContent).toBe("");
    expect(container.querySelector('[data-testid="error"]')?.textContent).toContain("数据库暂时不可用");
    expect(toastMocks.show).toHaveBeenCalledWith("err", "保存失败：数据库暂时不可用");
    expect(toastMocks.show).not.toHaveBeenCalledWith("ok", "已添加素材：门头.mp4");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
