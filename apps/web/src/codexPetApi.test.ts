import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexPetInstallLink,
  createCodexPetProject,
  approveCodexPetNextImage,
  deleteCodexPetProject,
  downloadCodexPetPackage,
  getCodexPetProject,
  listCodexPetEvents,
  startCodexPetRun,
  streamCodexPetEvents,
  type CodexPetProject,
  type CodexPetRun,
} from "./codexPetApi";

const project: CodexPetProject = {
  id: "project / 1",
  name: "码仔",
  description: "薄荷机器人",
  prompt: "一只薄荷色机器人",
  stylePreset: "pixel",
  styleNotes: "圆润",
  referenceAssetIds: [],
  autoContinue: false,
  status: "draft",
  latestRunId: null,
  createdAt: "2026-07-17T08:00:00.000Z",
  updatedAt: "2026-07-17T08:00:00.000Z",
};

const run: CodexPetRun = {
  id: "run / 1",
  projectId: project.id,
  status: "queued",
  progressStage: "queued",
  progressPercent: 1,
  progressMessage: "排队中",
  autoContinue: false,
  colorKey: null,
  billingPoints: 200,
  billingRefundedAt: null,
  cancelRequested: false,
  hasSuccessfulImage: false,
  selectedBaseArtifactId: null,
  spritesheetArtifactId: null,
  packageArtifactId: null,
  previewArtifactId: null,
  validationReport: null,
  requestedModel: "gpt-image-2",
  modelContractVersion: "gpt-only-v1",
  visualQaModel: "gpt-5.6-sol",
  visualQaActualModels: [],
  visualQaRoutes: [],
  actualModels: [],
  usage: null,
  knowledgeDocumentId: null,
  lastEventSequence: 1,
  error: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-07-17T08:00:00.000Z",
  updatedAt: "2026-07-17T08:00:00.000Z",
};

describe("codex pet API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the project idempotency key in both the header and payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { project } }), { status: 201 }));

    await expect(createCodexPetProject("token", {
      name: "码仔",
      prompt: "一只薄荷色机器人",
      idempotencyKey: "codex-pet-project-key",
    })).resolves.toEqual(project);

    expect(fetchMock).toHaveBeenCalledWith("/api/workflow/codex-pets/projects", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer token",
        "idempotency-key": "codex-pet-project-key",
      }),
      body: JSON.stringify({ name: "码仔", prompt: "一只薄荷色机器人", idempotencyKey: "codex-pet-project-key" }),
    }));
  });

  it("uses encoded project paths and the same idempotency key when starting a paid run", async () => {
    const startedProject = { ...project, latestRunId: run.id, status: "queued" as const };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { project: startedProject, run } }), { status: 202 }));

    await expect(startCodexPetRun("token", project.id, "codex-pet-run-key")).resolves.toEqual({ project: startedProject, run });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/codex-pets/projects/project%20%2F%201/start",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "idempotency-key": "codex-pet-run-key" }),
        body: JSON.stringify({ idempotencyKey: "codex-pet-run-key" }),
      }),
    );
  });

  it("soft-deletes a project through the encoded history endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: { projectId: project.id, softDeleted: true },
    }), { status: 202 }));

    await expect(deleteCodexPetProject("token", project.id)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/codex-pets/projects/project%20%2F%201",
      expect.objectContaining({
        method: "DELETE",
        headers: { authorization: "Bearer token" },
      }),
    );
  });

  it("approves one image call through encoded project and run paths", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { run } }), { status: 202 }));

    await expect(approveCodexPetNextImage("token", project.id, run.id)).resolves.toEqual(run);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/codex-pets/projects/project%20%2F%201/runs/run%20%2F%201/approve-next-image",
      expect.objectContaining({ method: "POST", headers: { authorization: "Bearer token" } }),
    );
  });

  it("parses the persisted event envelope and cursor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: {
      events: [{
        sequence: 7,
        type: "stage.started",
        stage: "base_generating",
        jobKey: null,
        message: "生成主形象",
        progress: 5,
        payload: {},
        createdAt: "2026-07-17T08:01:00.000Z",
      }],
      cursor: 7,
    } }), { status: 200 }));

    await expect(listCodexPetEvents("token", project.id, run.id, 5)).resolves.toMatchObject({ cursor: 7, events: [{ sequence: 7 }] });
  });

  it("opens a bearer-token SSE stream from Last-Event-ID and ignores heartbeat blocks", async () => {
    const encoded = new TextEncoder().encode([
      "event: heartbeat",
      "data: {\"ts\":\"2026-07-17T08:01:00.000Z\"}",
      "",
      "id: 7",
      "event: preview.ready",
      "data: {\"sequence\":7,\"type\":\"preview.ready\",\"stage\":\"standard_generating\",\"jobKey\":\"idle\",\"message\":\"预览可用\",\"progress\":32,\"payload\":{\"artifactId\":\"preview-1\"},\"createdAt\":\"2026-07-17T08:02:00.000Z\"}",
      "",
    ].join("\n"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(encoded, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const onEvent = vi.fn();

    await streamCodexPetEvents({ token: "bearer", projectId: project.id, runId: run.id, after: 6, onEvent });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/codex-pets/projects/project%20%2F%201/runs/run%20%2F%201/events/stream?after=6",
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "text/event-stream",
          authorization: "Bearer bearer",
          "last-event-id": "6",
        }),
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ sequence: 7, type: "preview.ready", jobKey: "idle" }));
  });

  it("parses CRLF SSE boundaries even when a network chunk splits the CR and LF", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "id: 8\r",
      "\nevent: stage.completed\r\ndata: {\"sequence\":8,\"type\":\"stage.completed\",\"stage\":\"validating\",\"jobKey\":null,\"message\":\"动作制作完成\",\"progress\":80,\"payload\":{},\"createdAt\":\"2026-07-17T08:03:00.000Z\"}\r",
      "\n\r",
      "\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const onEvent = vi.fn();

    await streamCodexPetEvents({ token: "bearer", projectId: project.id, runId: run.id, after: 7, onEvent });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      sequence: 8,
      type: "stage.completed",
      stage: "validating",
      progress: 80,
    }));
  });

  it("keeps ZIP download authenticated and honors the UTF-8 filename", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["zip"]), {
      status: 200,
      headers: { "content-disposition": "attachment; filename*=UTF-8''%E7%A0%81%E4%BB%94.zip" },
    }));

    const downloaded = await downloadCodexPetPackage("token", project.id);
    expect(downloaded.filename).toBe("码仔.zip");
    expect(await downloaded.blob.text()).toBe("zip");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/codex-pets/projects/project%20%2F%201/download",
      { headers: { authorization: "Bearer token" } },
    );
  });

  it("targets a specific archived run for knowledge-base install and download actions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { installUrl: "codex://pets/install?name=archived" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob(["zip"]), { status: 200 }));

    await expect(createCodexPetInstallLink("token", project.id, run.id)).resolves.toMatchObject({
      installUrl: "codex://pets/install?name=archived",
    });
    await expect(downloadCodexPetPackage("token", project.id, run.id)).resolves.toMatchObject({ filename: "codex-pet.zip" });

    const expectedBase = "/api/workflow/codex-pets/projects/project%20%2F%201";
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${expectedBase}/install-link?runId=run%20%2F%201`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${expectedBase}/download?runId=run%20%2F%201`);
  });

  it("normalizes install links and project details used by knowledge-base actions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { url: "codex://pets/install?name=pet", expiresAt: "2026-07-17T08:30:00.000Z" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { detail: { project, latestRun: run } } }), { status: 200 }));

    await expect(createCodexPetInstallLink("token", project.id)).resolves.toEqual({
      installUrl: "codex://pets/install?name=pet",
      expiresAt: "2026-07-17T08:30:00.000Z",
    });
    await expect(getCodexPetProject("token", project.id)).resolves.toEqual({
      project,
      latestRun: run,
      runs: [run],
      artifacts: [],
      jobs: [],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workflow/codex-pets/projects/project%20%2F%201/install-link");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer token" }),
    }));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/workflow/codex-pets/projects/project%20%2F%201");
  });
});
