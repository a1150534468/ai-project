// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodexPetArtifact,
  CodexPetEvent,
  CodexPetJob,
  CodexPetPricing,
  CodexPetProject,
  CodexPetProjectDetail,
  CodexPetProjectSummary,
  CodexPetRun,
} from "../../codexPetApi";
import {
  CODEX_PET_POLL_MS,
  CODEX_PET_REFERENCE_MAX_BYTES,
  CODEX_PET_STREAM_RECONNECT_MS,
} from "./codexPetStudioModel";
import { CodexPetStudio, type CodexPetStudioClient } from "./CodexPetStudio";

const pricing: CodexPetPricing = {
  resourceKey: "codex_pet_v2_package",
  displayName: "Codex 桌宠 v2 生图调用",
  pricingType: "PER_UNIT",
  rate: 200,
  perUnits: 1,
  enabled: true,
  includedBaseCandidates: 2,
};

function makeProject(overrides: Partial<CodexPetProject> = {}): CodexPetProject {
  return {
    id: "project-1",
    name: "码仔",
    description: "会陪伴写代码的薄荷机器人",
    prompt: "一只薄荷色圆润机器人",
    stylePreset: "pixel",
    styleNotes: "清晰轮廓",
    referenceAssetIds: [],
    referenceAssets: [],
    autoContinue: false,
    imageModel: "gpt-image-2",
    qualityInspectionEnabled: false,
    status: "draft",
    latestRunId: null,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    ...overrides,
  };
}

function summary(project: CodexPetProject): CodexPetProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    stylePreset: project.stylePreset,
    status: project.status,
    latestRunId: project.latestRunId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function makeRun(overrides: Partial<CodexPetRun> = {}): CodexPetRun {
  return {
    id: "run-1",
    projectId: "project-1",
    status: "awaiting_base_review",
    progressStage: "awaiting_base_review",
    progressPercent: 15,
    progressMessage: "请选择主形象",
    autoContinue: false,
    colorKey: "#ff00ff",
    billingPoints: 0,
    billingMode: "per_image_call_v1",
    billingReservedUnits: 14,
    billingSettledUnits: 0,
    billingReservedPoints: 2800,
    billingSettledPoints: 0,
    billingSettlementStatus: "reserved",
    billingRefundedAt: null,
    cancelRequested: false,
    hasSuccessfulImage: true,
    selectedBaseArtifactId: null,
    spritesheetArtifactId: null,
    packageArtifactId: null,
    previewArtifactId: null,
    validationReport: null,
    requestedModel: "gpt-image-2",
    imageGenerationCallCount: 0,
    plannedImageCallLimit: 14,
    modelContractVersion: "gpt-only-quality-optional-v3",
    visualQaModel: "gpt-5.6-sol",
    qualityInspectionEnabled: false,
    visualQaActualModels: [],
    visualQaRoutes: [],
    actualModels: ["gpt-image-2-codex"],
    usage: { totalTokens: 321 },
    knowledgeDocumentId: null,
    lastEventSequence: 1,
    error: null,
    startedAt: "2026-07-17T08:01:00.000Z",
    completedAt: null,
    createdAt: "2026-07-17T08:01:00.000Z",
    updatedAt: "2026-07-17T08:02:00.000Z",
    ...overrides,
  };
}

function artifact(id: string, kind: string, overrides: Partial<CodexPetArtifact> = {}): CodexPetArtifact {
  return {
    id,
    projectId: "project-1",
    runId: "run-1",
    kind,
    name: `${kind}.png`,
    status: "ready",
    mime: "image/png",
    sizeBytes: 1_024,
    width: 1536,
    height: 1024,
    metadata: {},
    expiresAt: null,
    createdAt: "2026-07-17T08:02:00.000Z",
    previewUrl: `https://example.test/${id}.png`,
    ...overrides,
  };
}

function makeEvent(sequence: number, message: string): CodexPetEvent {
  return {
    sequence,
    type: sequence === 1 ? "run.queued" : "preview.ready",
    stage: sequence === 1 ? "queued" : "standard_generating",
    jobKey: sequence === 1 ? null : "idle",
    message,
    progress: sequence * 10,
    payload: {},
    createdAt: "2026-07-17T08:02:00.000Z",
  };
}

function makeJob(key: string, status: string, updatedAt: string): CodexPetJob {
  return {
    id: `job-${key}`,
    key,
    kind: "standard_row",
    status,
    attempt: status === "running" ? 2 : 1,
    maxAttempts: 3,
    error: null,
    createdAt: "2026-07-17T08:01:00.000Z",
    updatedAt,
  };
}

function makeClient(args: {
  readonly project?: CodexPetProject;
  readonly detail?: CodexPetProjectDetail;
  readonly replay?: readonly CodexPetEvent[];
  readonly streamEvent?: CodexPetEvent;
} = {}): CodexPetStudioClient & Record<string, ReturnType<typeof vi.fn>> {
  const project = args.project ?? makeProject();
  const detail = args.detail ?? { project, latestRun: null, runs: [], artifacts: [], jobs: [] };
  return {
    getPricing: vi.fn().mockResolvedValue(pricing),
    listProjects: vi.fn().mockResolvedValue([summary(project)]),
    createProject: vi.fn().mockResolvedValue(project),
    getProject: vi.fn().mockResolvedValue(detail),
    updateProject: vi.fn().mockResolvedValue(project),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    startRun: vi.fn().mockResolvedValue({ project: { ...project, status: "queued", latestRunId: "run-1" }, run: makeRun({ status: "queued" }) }),
    continueFailedRun: vi.fn().mockResolvedValue({
      project: { ...project, status: "awaiting_regeneration_approval", latestRunId: "run-continuation" },
      run: makeRun({
        id: "run-continuation",
        status: "awaiting_regeneration_approval",
        progressStage: "awaiting_regeneration_approval",
        pendingImageJobKey: "base-candidate-2",
        imageGenerationCallCount: 0,
      }),
    }),
    selectBase: vi.fn().mockResolvedValue(makeRun({ status: "standard_generating", selectedBaseArtifactId: "base-2" })),
    approveNextImage: vi.fn().mockResolvedValue(makeRun({ status: "direction_generating", imageGenerationApprovalBudget: 1, pendingImageJobKey: null })),
    cancelRun: vi.fn().mockResolvedValue(makeRun({ cancelRequested: true })),
    listEvents: vi.fn().mockImplementation(async (_token: string, _projectId: string, _runId: string, after = 0) => ({
      events: (args.replay ?? []).filter((event) => event.sequence > after),
      cursor: Math.max(after, ...(args.replay ?? []).map((event) => event.sequence)),
    })),
    streamEvents: vi.fn().mockImplementation(async (options: Parameters<CodexPetStudioClient["streamEvents"]>[0]) => {
      if (args.streamEvent) options.onEvent(args.streamEvent);
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    createInstallLink: vi.fn().mockResolvedValue({ installUrl: "codex://pets/install?name=%E7%A0%81%E4%BB%94" }),
    downloadPackage: vi.fn().mockResolvedValue({ blob: new Blob(["zip"]), filename: "pet.zip" }),
    uploadReference: vi.fn(),
  } as CodexPetStudioClient & Record<string, ReturnType<typeof vi.fn>>;
}

async function flushEffects(iterations = 6): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function mountStudio(props: Parameters<typeof CodexPetStudio>[0]): Promise<{
  readonly container: HTMLDivElement;
  readonly root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<CodexPetStudio {...props} />); });
  await flushEffects();
  return { container, root };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(text));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("CodexPetStudio", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders the complete create contract before any network effect runs", () => {
    const html = renderToStaticMarkup(<CodexPetStudio token="token" client={makeClient()} />);
    expect(html).toContain("Codex 桌宠工坊");
    expect(html).toContain("角色提示词");
    expect(html).toContain("参考图");
    expect(html).toContain("主形象生成后自动继续");
    expect(html).toContain("创建草稿");
    expect(html).toContain("开始制作");
    expect(html).toContain("上传即表示你拥有参考图与角色的使用权");
    expect(html).toContain("验证、打包与归档");
    expect(html).toContain("事件会先持久化，再通过 SSE 实时推送");
    expect(html).toContain("GPT Image 2 · Pixel");
    expect(html).toContain("正常路径最多 14 次计划内 GPT Image 2 调用");
    expect(html).toContain("AI 质检");
    expect(html).not.toContain("Seedream");
    expect(html).not.toContain("Qwen Image");
  });

  it("defaults AI quality inspection off and only exposes its model selector after opt-in", async () => {
    const project = makeProject();
    const detail: CodexPetProjectDetail = { project, latestRun: null, runs: [], artifacts: [], jobs: [] };
    const mounted = await mountStudio({ token: "token", client: makeClient({ project, detail }) });
    const qualityToggle = mounted.container.querySelector<HTMLInputElement>('input[aria-label="AI 质检"]');

    expect(qualityToggle?.checked).toBe(false);
    expect(mounted.container.querySelector('select[aria-label="视觉理解 / 质检模型"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain("Seedream");
    expect(mounted.container.textContent).not.toContain("Qwen Image");
    await act(async () => { qualityToggle?.click(); });
    expect(mounted.container.querySelector('select[aria-label="视觉理解 / 质检模型"]')).not.toBeNull();
    await act(async () => { mounted.root.unmount(); });
  });

  it("opens the exact project requested by a knowledge-base jump even when it is not first in history", async () => {
    const historyProject = makeProject({ id: "project-history", name: "历史桌宠" });
    const targetProject = makeProject({ id: "project-from-knowledge", name: "知识库桌宠" });
    const targetDetail: CodexPetProjectDetail = {
      project: targetProject,
      latestRun: null,
      runs: [],
      artifacts: [],
      jobs: [],
    };
    const client = makeClient({ project: targetProject, detail: targetDetail });
    vi.mocked(client.listProjects).mockResolvedValue([summary(historyProject)]);
    const mounted = await mountStudio({
      token: "token",
      client,
      initialProjectId: targetProject.id,
    });

    expect(client.getProject).toHaveBeenCalledWith("token", targetProject.id, expect.any(AbortSignal));
    const nameInput = mounted.container.querySelector<HTMLInputElement>('input[placeholder="例如：码仔"]');
    expect(nameInput?.value).toBe("知识库桌宠");
    expect(nameInput?.disabled).toBe(false);

    await act(async () => { mounted.root.unmount(); });
  });

  it("locks stale inputs while switching projects so they cannot overwrite the selected project", async () => {
    const firstProject = makeProject({ id: "project-first", name: "第一个桌宠" });
    const secondProject = makeProject({ id: "project-second", name: "第二个桌宠" });
    let resolveSecond!: (detail: CodexPetProjectDetail) => void;
    const secondDetail = new Promise<CodexPetProjectDetail>((resolve) => { resolveSecond = resolve; });
    const client = makeClient({
      project: firstProject,
      detail: { project: firstProject, latestRun: null, runs: [], artifacts: [], jobs: [] },
    });
    vi.mocked(client.listProjects).mockResolvedValue([summary(firstProject), summary(secondProject)]);
    vi.mocked(client.getProject).mockImplementation(async (_token, projectId) => {
      if (projectId === secondProject.id) return secondDetail;
      return { project: firstProject, latestRun: null, runs: [], artifacts: [], jobs: [] };
    });
    const mounted = await mountStudio({ token: "token", client, initialProjectId: firstProject.id });

    await act(async () => { buttonByText(mounted.container, secondProject.name).click(); });
    await flushEffects(2);

    const staleNameInput = mounted.container.querySelector<HTMLInputElement>('input[placeholder="例如：码仔"]');
    expect(staleNameInput?.value).toBe("");
    expect(staleNameInput?.disabled).toBe(true);
    expect(buttonByText(mounted.container, "保存草稿").disabled).toBe(true);
    await act(async () => { buttonByText(mounted.container, "保存草稿").click(); });
    expect(client.updateProject).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecond({ project: secondProject, latestRun: null, runs: [], artifacts: [], jobs: [] });
      await secondDetail;
    });
    await flushEffects();
    expect(staleNameInput?.value).toBe(secondProject.name);
    expect(staleNameInput?.disabled).toBe(false);

    await act(async () => { mounted.root.unmount(); });
  });

  it("restores base candidates and submits the explicitly selected candidate", async () => {
    const run = makeRun();
    const project = makeProject({ status: "awaiting_base_review", latestRunId: run.id });
    const detail: CodexPetProjectDetail = {
      project,
      latestRun: run,
      runs: [run],
      artifacts: [artifact("base-1", "base_candidate"), artifact("base-2", "base_candidate")],
      jobs: [],
    };
    const client = makeClient({ project, detail });
    const mounted = await mountStudio({ token: "token", client });

    expect(mounted.container.textContent).toContain("主形象候选");
    expect(mounted.container.textContent).toContain("QA 自动选优");
    expect(mounted.container.textContent).toContain("重生候选");

    await act(async () => { buttonByText(mounted.container, "重生候选").click(); });
    await flushEffects();
    expect(client.selectBase).toHaveBeenCalledWith("token", "project-1", "run-1", { regenerate: true });
    vi.mocked(client.selectBase).mockClear();

    await act(async () => { buttonByText(mounted.container, "候选 2").click(); });
    await act(async () => { buttonByText(mounted.container, "使用所选形象并继续").click(); });
    await flushEffects();

    expect(client.selectBase).toHaveBeenCalledWith("token", "project-1", "run-1", { artifactId: "base-2" });
    await act(async () => { mounted.root.unmount(); });
  });

  it("replays persisted events before opening the bearer-token SSE stream and accepts live events", async () => {
    const run = makeRun({ status: "standard_generating", progressPercent: 20 });
    const project = makeProject({ status: "standard_generating", latestRunId: run.id });
    const detail: CodexPetProjectDetail = { project, latestRun: run, runs: [run], artifacts: [], jobs: [] };
    const client = makeClient({
      project,
      detail,
      replay: [makeEvent(1, "已从数据库补发")],
      streamEvent: makeEvent(2, "SSE 新预览已到达"),
    });
    const mounted = await mountStudio({ token: "bearer-token", client });

    expect(mounted.container.textContent).toContain("已从数据库补发");
    expect(mounted.container.textContent).toContain("SSE 新预览已到达");
    expect(client.streamEvents).toHaveBeenCalledWith(expect.objectContaining({
      token: "bearer-token",
      projectId: "project-1",
      runId: "run-1",
      after: 1,
    }));

    await act(async () => { mounted.root.unmount(); });
  });

  it("shows the durable running job instead of a later completed-job event as the current subtask", async () => {
    const run = makeRun({
      status: "standard_generating",
      progressStage: "standard_generating",
      progressPercent: 25,
    });
    const project = makeProject({ status: "standard_generating", latestRunId: run.id });
    const completedIdleEvent: CodexPetEvent = {
      ...makeEvent(2, "idle 动作组已通过检查"),
      type: "job.completed",
      jobKey: "row-idle",
    };
    const detail: CodexPetProjectDetail = {
      project,
      latestRun: run,
      runs: [run],
      artifacts: [],
      jobs: [
        makeJob("row-running-right", "running", "2026-07-17T08:02:00.000Z"),
        makeJob("row-idle", "completed", "2026-07-17T08:03:00.000Z"),
      ],
    };
    const mounted = await mountStudio({
      token: "token",
      client: makeClient({ project, detail, replay: [completedIdleEvent] }),
    });

    expect(mounted.container.querySelector('[data-testid="codex-pet-current-subtask"]')?.textContent)
      .toBe("row-running-right");

    await act(async () => { mounted.root.unmount(); });
  });

  it("replays the latest database gap before reconnecting SSE with the newest cursor after 1.2 seconds", async () => {
    vi.useFakeTimers();
    const run = makeRun({ status: "standard_generating", progressPercent: 20 });
    const project = makeProject({ status: "standard_generating", latestRunId: run.id });
    const detail: CodexPetProjectDetail = { project, latestRun: run, runs: [run], artifacts: [], jobs: [] };
    const client = makeClient({ project, detail });
    const firstEvent = makeEvent(1, "首次数据库补发");
    const recoveredEvent = makeEvent(2, "断线期间数据库补发");
    vi.mocked(client.listEvents).mockImplementation(async (_token, _projectId, _runId, after = 0) => {
      if (after < firstEvent.sequence) return { events: [firstEvent], cursor: firstEvent.sequence };
      if (after < recoveredEvent.sequence) return { events: [recoveredEvent], cursor: recoveredEvent.sequence };
      return { events: [], cursor: after };
    });
    vi.mocked(client.streamEvents)
      .mockRejectedValueOnce(new Error("SSE disconnected"))
      .mockImplementation(async (options: Parameters<CodexPetStudioClient["streamEvents"]>[0]) => {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      });
    const mounted = await mountStudio({ token: "bearer-token", client });

    expect(client.streamEvents).toHaveBeenCalledTimes(1);
    expect(client.streamEvents).toHaveBeenLastCalledWith(expect.objectContaining({ after: 1 }));

    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_PET_STREAM_RECONNECT_MS - 1); });
    expect(client.streamEvents).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await flushEffects();

    expect(client.listEvents).toHaveBeenCalledWith("bearer-token", "project-1", "run-1", 1, expect.any(AbortSignal));
    expect(client.streamEvents).toHaveBeenCalledTimes(2);
    expect(client.streamEvents).toHaveBeenLastCalledWith(expect.objectContaining({
      token: "bearer-token",
      projectId: "project-1",
      runId: "run-1",
      after: 2,
    }));
    expect(vi.mocked(client.listEvents).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(client.streamEvents).mock.invocationCallOrder[1]!,
    );
    expect(mounted.container.textContent).toContain("断线期间数据库补发");

    await act(async () => { mounted.root.unmount(); });
  });

  it("polls project detail and event gaps every 2.5 seconds as the SSE fallback", async () => {
    vi.useFakeTimers();
    const run = makeRun({ status: "direction_generating" });
    const project = makeProject({ status: "direction_generating", latestRunId: run.id });
    const detail: CodexPetProjectDetail = { project, latestRun: run, runs: [run], artifacts: [], jobs: [] };
    const client = makeClient({ project, detail, replay: [makeEvent(1, "排队中")] });
    const mounted = await mountStudio({ token: "token", client });
    const getProjectMock = vi.mocked(client.getProject);
    const before = getProjectMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(CODEX_PET_POLL_MS);
      await Promise.resolve();
    });
    await flushEffects();

    expect(getProjectMock.mock.calls.length).toBeGreaterThan(before);
    expect(client.listEvents).toHaveBeenCalledWith("token", "project-1", "run-1", 1);
    await act(async () => { mounted.root.unmount(); });
  });

  it("allows an empty-visual draft to be saved but keeps the start gate strict", async () => {
    const project = makeProject({ prompt: "" });
    const detail: CodexPetProjectDetail = { project, latestRun: null, runs: [], artifacts: [], jobs: [] };
    const client = makeClient({ project, detail });
    const mounted = await mountStudio({ token: "token", client });

    await act(async () => { buttonByText(mounted.container, "保存草稿").click(); });
    await flushEffects();
    expect(client.updateProject).toHaveBeenCalledWith("token", "project-1", expect.objectContaining({ prompt: "", referenceAssetIds: [] }));

    await act(async () => { buttonByText(mounted.container, "开始制作").click(); });
    expect(mounted.container.textContent).toContain("请填写角色提示词或上传至少一张参考图");
    expect(client.startRun).not.toHaveBeenCalled();
    await act(async () => { mounted.root.unmount(); });
  });

  it("lets a failed immutable project be copied into a new runnable draft", async () => {
    const run = makeRun({ status: "failed", progressStage: "failed", error: "动作质检失败" });
    const project = makeProject({ status: "failed", latestRunId: run.id, name: "月薪喵" });
    const detail: CodexPetProjectDetail = { project, latestRun: run, runs: [run], artifacts: [], jobs: [] };
    const mounted = await mountStudio({ token: "token", client: makeClient({ project, detail }) });

    const copy = buttonByText(mounted.container, "复制为新项目");
    expect(copy.disabled).toBe(false);
    await act(async () => { copy.click(); });
    await flushEffects();

    expect(mounted.container.textContent).toContain("已复制输入信息为新草稿");
    expect(buttonByText(mounted.container, "开始制作").disabled).toBe(false);
    const nameInput = mounted.container.querySelector<HTMLInputElement>('input[maxlength="30"]');
    expect(nameInput?.value).toBe("月薪喵 副本");
    await act(async () => { mounted.root.unmount(); });
  });

  it("continues the eligible failed project while preserving candidate one", async () => {
    const run = makeRun({
      status: "failed",
      progressStage: "failed",
      error: "image relay 429 Concurrency limit exceeded",
      billingMode: "per_image_call_v1",
      billingSettlementStatus: "settled",
      qualityInspectionEnabled: false,
      hasSuccessfulImage: true,
      selectedBaseArtifactId: null,
      imageGenerationCallCount: 2,
      plannedImageCallLimit: 14,
    });
    const project = makeProject({ status: "failed", latestRunId: run.id });
    const detail: CodexPetProjectDetail = { project, latestRun: run, runs: [run], artifacts: [], jobs: [] };
    const client = makeClient({ project, detail });
    const mounted = await mountStudio({ token: "token", client });
    const continuedRun = makeRun({
      id: "run-continuation",
      status: "awaiting_regeneration_approval",
      progressStage: "awaiting_regeneration_approval",
      pendingImageJobKey: "base-candidate-2",
      imageGenerationCallCount: 0,
    });
    const continuedProject = { ...project, status: "awaiting_regeneration_approval" as const, latestRunId: continuedRun.id };
    vi.mocked(client.continueFailedRun).mockResolvedValue({ project: continuedProject, run: continuedRun });
    vi.mocked(client.getProject).mockResolvedValue({
      project: continuedProject,
      latestRun: continuedRun,
      runs: [continuedRun, run],
      artifacts: [],
      jobs: [],
    });

    const continuation = buttonByText(mounted.container, "复用候选 1，重试候选 2");
    await act(async () => { continuation.click(); });
    await flushEffects();

    expect(client.continueFailedRun).toHaveBeenCalledWith(
      "token",
      project.id,
      run.id,
      expect.stringMatching(/^codex-pet-continue-/),
    );
    expect(mounted.container.textContent).toContain("候选 1 已保留");
    expect(mounted.container.textContent).toContain("额外真实生图等待批准");
    expect(buttonByText(mounted.container, "批准 1 次生图").disabled).toBe(false);
    await act(async () => { mounted.root.unmount(); });
  });

  it("shows the planned-call cap and grants one explicitly approved extra call", async () => {
    const run = makeRun({
      status: "awaiting_regeneration_approval",
      progressStage: "awaiting_regeneration_approval",
      progressMessage: "等待批准 look-a",
      pendingImageJobKey: "look-a",
      imageGenerationApprovalBudget: 0,
      imageGenerationCallCount: 12,
    });
    const project = makeProject({ status: "awaiting_regeneration_approval", latestRunId: run.id });
    const detail: CodexPetProjectDetail = { project, latestRun: run, runs: [run], artifacts: [], jobs: [] };
    const client = makeClient({ project, detail });
    const mounted = await mountStudio({ token: "token", client });

    expect(mounted.container.querySelector('[data-testid="codex-pet-image-call-count"]')?.textContent).toBe("12/14");
    const approve = buttonByText(mounted.container, "批准 1 次生图");
    await act(async () => { approve.click(); });
    await flushEffects();

    expect(client.approveNextImage).toHaveBeenCalledWith("token", "project-1", "run-1", expect.stringMatching(/^codex-pet-extra-/));
    expect(mounted.container.textContent).toContain("已批准 look-a 的 1 次真实生图调用");
    await act(async () => { mounted.root.unmount(); });
  });

  it("rejects unsupported and oversized references, uploads at most three, and shows the rights notice", async () => {
    const project = makeProject();
    const detail: CodexPetProjectDetail = { project, latestRun: null, runs: [], artifacts: [], jobs: [] };
    const client = makeClient({ project, detail });
    vi.mocked(client.uploadReference).mockImplementation(async (_token, image) => ({
      id: `reference-${vi.mocked(client.uploadReference).mock.calls.length}`,
      name: "reference.png",
      mime: image.mime ?? "image/png",
      originalUrl: "https://example.test/reference.png",
      thumbnailUrl: "https://example.test/reference-thumb.png",
      createdAt: "2026-07-17T08:03:00.000Z",
    }));
    const mounted = await mountStudio({ token: "token", client });
    const input = mounted.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("reference upload input missing");

    expect(input.accept).toBe("image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif");
    expect(mounted.container.textContent).toContain("0/3 · 每张 10MB");
    expect(mounted.container.textContent).toContain("上传即表示你拥有参考图与角色的使用权");

    const unsupported = new File(["svg"], "character.svg", { type: "image/svg+xml" });
    Object.defineProperty(input, "files", { configurable: true, value: [unsupported] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(mounted.container.textContent).toContain("参考图仅支持 JPG、PNG、WEBP、BMP、TIFF 或 GIF");
    expect(client.uploadReference).not.toHaveBeenCalled();

    const oversized = new File(["png"], "oversized.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { configurable: true, value: CODEX_PET_REFERENCE_MAX_BYTES + 1 });
    Object.defineProperty(input, "files", { configurable: true, value: [oversized] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(mounted.container.textContent).toContain("参考图大小需在 10MB 以内");
    expect(client.uploadReference).not.toHaveBeenCalled();

    const validFiles = Array.from({ length: 4 }, (_, index) => new File(
      [`png-${index}`],
      `reference-${index + 1}.png`,
      { type: "image/png" },
    ));
    Object.defineProperty(input, "files", { configurable: true, value: validFiles });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(client.uploadReference).toHaveBeenCalledTimes(3));
    });
    await flushEffects();

    expect(client.uploadReference).toHaveBeenCalledTimes(3);
    expect(mounted.container.textContent).toContain("3/3 · 每张 10MB");
    expect(mounted.container.querySelector('input[type="file"]')).toBeNull();
    await act(async () => { mounted.root.unmount(); });
  });

  it("refreshes project detail after submitting a cancellation", async () => {
    const run = makeRun({ status: "standard_generating", progressStage: "standard_generating" });
    const project = makeProject({ status: "standard_generating", latestRunId: run.id });
    const detail: CodexPetProjectDetail = { project, latestRun: run, runs: [run], artifacts: [], jobs: [] };
    const client = makeClient({ project, detail });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const mounted = await mountStudio({ token: "token", client });
    const callsBeforeCancel = vi.mocked(client.getProject).mock.calls.length;

    await act(async () => { buttonByText(mounted.container, "取消运行").click(); });
    await flushEffects();
    expect(client.cancelRun).toHaveBeenCalledWith("token", "project-1", "run-1");
    expect(vi.mocked(client.getProject).mock.calls.length).toBeGreaterThan(callsBeforeCancel);
    await act(async () => { mounted.root.unmount(); });
  });

  it("deletes an unselected history item without changing the active workspace", async () => {
    const project = makeProject({ id: "project-current", name: "当前桌宠" });
    const historyProject = makeProject({ id: "project-history", name: "历史桌宠", status: "failed" });
    const client = makeClient({
      project,
      detail: { project, latestRun: null, runs: [], artifacts: [], jobs: [] },
    });
    vi.mocked(client.listProjects).mockResolvedValue([summary(project), summary(historyProject)]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const mounted = await mountStudio({ token: "token", client, initialProjectId: project.id });

    const deleteButton = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="删除项目 历史桌宠"]');
    if (!deleteButton) throw new Error("history delete button missing");
    await act(async () => { deleteButton.click(); });
    await flushEffects();

    expect(client.deleteProject).toHaveBeenCalledWith("token", historyProject.id);
    expect(mounted.container.textContent).not.toContain(historyProject.name);
    expect(mounted.container.querySelector<HTMLInputElement>('input[placeholder="例如：码仔"]')?.value).toBe(project.name);
    expect(mounted.container.textContent).toContain("项目已从历史中删除，数据和产物仍保留");
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("数据和产物仍会保留"));
    await act(async () => { mounted.root.unmount(); });
  });

  it("keeps the history item when soft deletion fails", async () => {
    const project = makeProject({ name: "保留桌宠" });
    const client = makeClient({
      project,
      detail: { project, latestRun: null, runs: [], artifacts: [], jobs: [] },
    });
    vi.mocked(client.deleteProject).mockRejectedValue(new Error("软删除失败，请重试"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const mounted = await mountStudio({ token: "token", client });

    await act(async () => { buttonByText(mounted.container, "从历史中删除").click(); });
    await flushEffects();

    expect(client.deleteProject).toHaveBeenCalledWith("token", project.id);
    expect(mounted.container.textContent).toContain(project.name);
    expect(mounted.container.textContent).toContain("软删除失败，请重试");
    await act(async () => { mounted.root.unmount(); });
  });

  it("allows installation while a packaged pet is still being archived", async () => {
    const run = makeRun({
      status: "archiving",
      progressPercent: 100,
      spritesheetArtifactId: "sheet-1",
      packageArtifactId: "zip-1",
      validationReport: { ok: true, spriteVersionNumber: 2 },
      knowledgeDocumentId: null,
    });
    const project = makeProject({ status: "archiving", latestRunId: run.id });
    const detail: CodexPetProjectDetail = {
      project,
      latestRun: run,
      runs: [run],
      artifacts: [artifact("sheet-1", "spritesheet", { width: 1536, height: 2288 })],
      jobs: [],
    };
    const client = makeClient({ project, detail });
    const onInstallUrl = vi.fn();
    const mounted = await mountStudio({ token: "token", client, onInstallUrl });

    expect(mounted.container.textContent).toContain("AI 产物正在后台归档，不影响安装和下载。");
    await act(async () => { buttonByText(mounted.container, "安装到 Codex").click(); });
    await flushEffects();
    expect(client.createInstallLink).toHaveBeenCalledWith("token", "project-1");
    expect(onInstallUrl).toHaveBeenCalledWith("codex://pets/install?name=%E7%A0%81%E4%BB%94");
    expect(Array.from(mounted.container.querySelectorAll("button")).some((button) => button.textContent?.includes("在 AI 产物中查看"))).toBe(false);
    await act(async () => { mounted.root.unmount(); });
  });

  it("installs and opens the archived document when it is available", async () => {
    const run = makeRun({
      status: "ready",
      progressPercent: 100,
      spritesheetArtifactId: "sheet-1",
      packageArtifactId: "zip-1",
      previewArtifactId: "preview-1",
      validationReport: { ok: true, spriteVersionNumber: 2, warnings: [] },
      knowledgeDocumentId: "document-1",
      completedAt: "2026-07-17T08:20:00.000Z",
    });
    const project = makeProject({ status: "ready", latestRunId: run.id });
    const detail: CodexPetProjectDetail = {
      project,
      latestRun: run,
      runs: [run],
      artifacts: [
        artifact("sheet-1", "spritesheet", { width: 1536, height: 2288 }),
        artifact("zip-1", "package", { mime: "application/zip" }),
        artifact("preview-1", "animation_preview"),
      ],
      jobs: [],
    };
    const client = makeClient({ project, detail });
    const onInstallUrl = vi.fn();
    const onOpenKnowledgeDocument = vi.fn();
    const mounted = await mountStudio({ token: "token", client, onInstallUrl, onOpenKnowledgeDocument });

    expect(mounted.container.textContent).toContain("9 组标准动画");
    expect(mounted.container.textContent).toContain("16 个观察方向");
    expect(mounted.container.textContent).toContain("AI 产物 · 已归档");

    await act(async () => { buttonByText(mounted.container, "安装到 Codex").click(); });
    await flushEffects();
    expect(client.createInstallLink).toHaveBeenCalledWith("token", "project-1");
    expect(onInstallUrl).toHaveBeenCalledWith("codex://pets/install?name=%E7%A0%81%E4%BB%94");

    await act(async () => { buttonByText(mounted.container, "在 AI 产物中查看").click(); });
    expect(onOpenKnowledgeDocument).toHaveBeenCalledWith("document-1");
    await act(async () => { mounted.root.unmount(); });
  });

  it("renders the nine current-run animation previews separately from the final contact sheet", async () => {
    const run = makeRun({
      status: "ready",
      progressPercent: 100,
      spritesheetArtifactId: "sheet-current",
      packageArtifactId: "zip-current",
      previewArtifactId: "contact-current",
      validationReport: { ok: true, spriteVersionNumber: 2, warnings: [] },
      knowledgeDocumentId: "document-current",
    });
    const project = makeProject({ status: "ready", latestRunId: run.id });
    const states = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"] as const;
    const animationArtifacts = states.map((state, index) => artifact(`animation-${state}`, "animation_preview", {
      runId: run.id,
      metadata: { jobKey: `row-${state}` },
      previewUrl: `https://example.test/${state}.webp`,
      createdAt: `2026-07-17T08:0${index + 1}:00.000Z`,
    }));
    const oldRunArtifact = artifact("animation-old", "animation_preview", {
      runId: "run-old",
      metadata: { jobKey: "row-idle" },
      previewUrl: "https://example.test/old.webp",
    });
    const contact = artifact("contact-current", "preview", {
      runId: run.id,
      previewUrl: "https://example.test/contact.png",
      width: 768,
      height: 1144,
    });
    const detail: CodexPetProjectDetail = {
      project,
      latestRun: run,
      runs: [run],
      artifacts: [oldRunArtifact, ...animationArtifacts, contact],
      jobs: [],
    };
    const mounted = await mountStudio({ token: "token", client: makeClient({ project, detail }) });

    const animationGrid = mounted.container.querySelector('[data-testid="codex-pet-standard-animations"]');
    expect(animationGrid?.querySelectorAll("figure")).toHaveLength(9);
    for (const state of states) {
      const image = animationGrid?.querySelector<HTMLImageElement>(`[data-testid="codex-pet-animation-${state}"] img`);
      expect(image?.src).toBe(`https://example.test/${state}.webp`);
    }
    const contactImage = mounted.container.querySelector<HTMLImageElement>('[data-testid="codex-pet-final-contact-sheet"] img');
    expect(contactImage?.src).toBe("https://example.test/contact.png");
    expect(mounted.container.querySelector('img[src="https://example.test/old.webp"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="codex-pet-animation-progress"]')?.textContent).toContain("已完成 9/9");
    // The grid is the only animation surface; there is no second unlabelled slot.
    expect(mounted.container.querySelectorAll('img[alt="桌宠状态动画预览"]')).toHaveLength(0);
    await act(async () => { mounted.root.unmount(); });
  });

  it("fills the nine labelled animation cells progressively mid-run and never shows a look-* row", async () => {
    const run = makeRun({ status: "standard_generating", progressPercent: 40 });
    const project = makeProject({ status: "standard_generating", latestRunId: run.id });
    // `animation_preview` also covers the two look-* direction rows, which are
    // produced after the standard rows and therefore win a newest-first pick.
    const lookRow = artifact("animation-look-b", "animation_preview", {
      runId: run.id,
      metadata: { jobKey: "look-b" },
      previewUrl: "https://example.test/look-b.webp",
      createdAt: "2026-07-17T09:00:00.000Z",
    });
    const detail: CodexPetProjectDetail = {
      project,
      latestRun: run,
      runs: [run],
      artifacts: [
        artifact("animation-idle", "animation_preview", {
          runId: run.id,
          metadata: { jobKey: "row-idle" },
          previewUrl: "https://example.test/idle.webp",
          createdAt: "2026-07-17T08:03:00.000Z",
        }),
        artifact("animation-waving", "animation_preview", {
          runId: run.id,
          metadata: { jobKey: "row-waving" },
          previewUrl: "https://example.test/waving.webp",
          createdAt: "2026-07-17T08:04:00.000Z",
        }),
        lookRow,
      ],
      jobs: [],
    };
    const mounted = await mountStudio({ token: "token", client: makeClient({ project, detail }) });

    const grid = mounted.container.querySelector('[data-testid="codex-pet-standard-animations"]');
    expect(grid?.querySelectorAll("figure")).toHaveLength(9);
    expect(grid?.querySelector<HTMLImageElement>('[data-testid="codex-pet-animation-idle"] img')?.src)
      .toBe("https://example.test/idle.webp");
    expect(grid?.querySelector<HTMLImageElement>('[data-testid="codex-pet-animation-waving"] img')?.src)
      .toBe("https://example.test/waving.webp");
    expect(grid?.querySelector('[data-testid="codex-pet-animation-jumping"] img')).toBeNull();
    expect(grid?.querySelector('[data-testid="codex-pet-animation-jumping"]')?.textContent).toContain("跳跃预览处理中");
    expect(mounted.container.querySelector('[data-testid="codex-pet-animation-progress"]')?.textContent).toContain("已完成 2/9");
    expect(mounted.container.querySelector('img[src="https://example.test/look-b.webp"]')).toBeNull();
    await act(async () => { mounted.root.unmount(); });
  });

  it("keeps pose boards and direction QA sheets in the diagnostics panel instead of the workbench", async () => {
    const run = makeRun({
      status: "ready",
      progressPercent: 100,
      spritesheetArtifactId: "sheet-current",
      previewArtifactId: "contact-current",
      validationReport: { ok: true, spriteVersionNumber: 2, warnings: [] },
    });
    const project = makeProject({ status: "ready", latestRunId: run.id });
    // The blind QA sheet is written in the later validation stage, so a
    // newest-first substring match used to surface it as "当前姿势板".
    const blindQa = artifact("blind-qa-1", "direction_blind_qa", {
      runId: run.id,
      previewUrl: "https://example.test/blind-qa.png",
      width: 408,
      height: 3668,
      createdAt: "2026-07-17T08:30:00.000Z",
    });
    const poseBoard = artifact("board-1", "pose_board", {
      runId: run.id,
      previewUrl: "https://example.test/board.png",
      createdAt: "2026-07-17T08:05:00.000Z",
    });
    const detail: CodexPetProjectDetail = {
      project,
      latestRun: run,
      runs: [run],
      artifacts: [blindQa, poseBoard],
      jobs: [],
    };
    const mounted = await mountStudio({ token: "token", client: makeClient({ project, detail }) });

    expect(mounted.container.querySelector('img[alt="当前桌宠姿势板"]')).toBeNull();
    const panel = mounted.container.querySelector('[data-testid="codex-pet-process-artifacts"]');
    expect(panel?.textContent).toContain("过程产物（内部诊断 · 2 项）");
    expect(panel?.querySelector<HTMLImageElement>('[data-testid="codex-pet-process-artifact-pose_board"] img')?.src)
      .toBe("https://example.test/board.png");
    expect(panel?.querySelector<HTMLImageElement>('[data-testid="codex-pet-process-artifact-direction_blind_qa"] img')?.src)
      .toBe("https://example.test/blind-qa.png");
    expect(panel?.textContent).toContain("方向盲测图");
    await act(async () => { mounted.root.unmount(); });
  });

  it("reports an expired intermediate set as a normal empty diagnostics panel", async () => {
    const run = makeRun({ status: "ready", progressPercent: 100, spritesheetArtifactId: "sheet-current" });
    const project = makeProject({ status: "ready", latestRunId: run.id });
    const detail: CodexPetProjectDetail = {
      project,
      latestRun: run,
      runs: [run],
      artifacts: [artifact("sheet-current", "spritesheet", { runId: run.id, width: 1536, height: 2288 })],
      jobs: [],
    };
    const mounted = await mountStudio({ token: "token", client: makeClient({ project, detail }) });

    const panel = mounted.container.querySelector('[data-testid="codex-pet-process-artifacts"]');
    expect(panel?.textContent).toContain("过程产物（内部诊断 · 0 项）");
    expect(panel?.textContent).toContain("本次运行没有仍在保留期内的过程产物。");
    await act(async () => { mounted.root.unmount(); });
  });
});
