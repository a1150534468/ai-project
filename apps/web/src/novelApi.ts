/**
 * 小说工作流的前端 API 客户端。P2.4 批次二 Step 2 从 `api.ts` 整块搬来：48 个函数、23 个类型
 * 逐字未动，只换了 import 头，所以调用方和测试文件一行都不用改 —— `api.ts` 仍是门面，
 * 用 `export *` 原样转发本文件的全部导出。
 *
 * 两处和同目录其它 API 文件不一样的地方：
 *  - `novelEngineRequest` 是本文件私有的薄封装（统一「小说引擎请求失败」fallback），不对外导出。
 *  - `exportNovelProject` / `streamNovelEngineEvents` 走 `requestResponse` 而不是 `request<T>()`：
 *    前者要的是 blob，后者要把 response.body 留给 SSE reader。
 */
import type { NovelRunEvent, NovelRunSnapshot } from "@ai-assistant/novel-workflow/contracts";
import { type HttpMethod, request, requestResponse } from "./http";

export interface NovelWorkflowResourcePrice {
  resourceKey: string;
  displayName: string;
  pricingType: "PER_CALL" | "PER_UNIT";
  rate: number;
  perUnits: number;
  enabled: boolean;
}

export interface NovelWorkflowPricing {
  novelText: NovelWorkflowResourcePrice;
  cover: NovelWorkflowResourcePrice;
}

export interface NovelProjectSummary {
  id: string;
  title: string;
  genre: string;
  premise: string;
  status: string;
  setupStage: number;
  setupCompleted: boolean;
  targetChapters: number;
  chapterCount: number;
  totalWords: number;
  updatedAt: string;
}

export interface NovelChapter {
  id: string;
  volumeIndex: number;
  chapterIndex: number;
  title: string;
  summary: string;
  outline?: string;
  generationHint?: string;
  content: string;
  rawContent?: string;
  openThreads?: string[];
  contextSnapshot?: unknown;
  generationMeta?: unknown;
  consistencyJson?: unknown;
  status: string;
  reviewStatus?: "pending" | "approved" | "revise";
  reviewNotes?: string;
  aiReview?: string;
  aiActionItems?: string[];
  modificationRate?: number;
  reviewedAt?: string | null;
  billableChars: number;
  tensionScore?: number;
  plotTension?: number;
  emotionalTension?: number;
  pacingTension?: number;
  qualityScore?: number;
  lastTaskId: string | null;
  updatedAt: string;
}

export interface NovelTask {
  id: string;
  projectId: string;
  targetKind: "setupBible" | "setupCharacters" | "setupLocations" | "setupPlot" | "chapter" | "chapterRewrite" | string;
  targetId: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progressPercent: number;
  progressStage: string;
  progressMessage: string | null;
  progressPreview: string;
  streamedChars: number;
  requestPayload: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface NovelProjectDetail {
  project: {
    id: string;
    title: string;
    genre: string;
    premise: string;
    settings: Record<string, unknown>;
    generationPrefs: Record<string, unknown>;
    targetChapters: number;
    targetCharsPerChapter: number;
    setupStage: number;
    setupCompleted: boolean;
    storyPhase: string;
    autopilotStatus: string;
    currentBranch: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  bible: null | {
    id: string;
    premiseLock: string;
    genreLock: string;
    worldPresetLock: string;
    version: number;
    worldDimensions: Array<Record<string, unknown>>;
    styleNotes: Array<Record<string, unknown>>;
    updatedAt: string;
  };
  chapters: NovelChapter[];
  tasks: NovelTask[];
}

export interface NovelWorkbenchStats {
  totalWords: number;
  finishedChapters: number;
  completionRate: number;
  averageWords: number;
  lastUpdate: string | null;
}

export interface NovelWorkbenchPayload {
  project: { id: string; title: string; genre: string; status: string; createdAt: string; updatedAt: string };
  stats: NovelWorkbenchStats;
  chapters: NovelChapter[];
  knowledgeFacts: Array<Record<string, unknown>>;
  foreshadowItems: Array<Record<string, unknown>>;
  workbenchHighlights: Record<string, unknown>;
}

export interface CreateNovelInitialSettings {
  channel?: string;
  coreRequirement?: string;
  platforms?: string[];
  topics?: string[];
  perspective?: string;
  styleMode?: string;
  era?: string;
  hasCheat?: boolean;
  styleTags?: string[];
  language?: string;
  chapterCount?: number;
  chapterChars?: number;
}

export interface CreateNovelProjectPayload {
  title: string;
  premise: string;
  genre: string;
  worldPreset?: string;
  storyStructure?: string;
  pacingControl?: string;
  writingStyle?: string;
  specialRequirements?: string;
  targetChapters: number;
  targetCharsPerChapter: number;
}

export async function getNovelWorkflowPricing(token: string): Promise<NovelWorkflowPricing> {
  return request<NovelWorkflowPricing>("/api/workflow/novels/pricing", { token, fallback: "获取小说计价失败" });
}

export async function listNovelProjects(token: string): Promise<NovelProjectSummary[]> {
  const rows = await request<NovelProjectSummary[]>("/api/workflow/novels/projects", {
    token,
    fallback: "获取小说项目失败",
  });
  return rows ?? [];
}

export async function createNovelProject(token: string, payload: CreateNovelProjectPayload): Promise<NovelProjectDetail> {
  return request<NovelProjectDetail>("/api/workflow/novels/projects", {
    method: "POST",
    token,
    body: payload,
    fallback: "创建小说项目失败",
  });
}

export type NovelSetupKind = "bible" | "characters" | "locations" | "plot";

export interface NovelSetupPayload {
  project: { id: string; setupStage: number; setupCompleted: boolean };
  bible: null | Record<string, unknown>;
  characters: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
  storylines: Array<Record<string, unknown>>;
  structure: NovelStructureNode[];
  chapters: NovelChapter[];
  activeTask: NovelTask | null;
  latestTask: NovelTask | null;
}

export async function getNovelSetup(token: string, projectId: string): Promise<NovelSetupPayload> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/setup`);
}

export async function generateNovelSetup(token: string, projectId: string, setupKind: NovelSetupKind, prompt = ""): Promise<NovelTask> {
  const data = await novelEngineRequest<{ task: NovelTask }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/setup/${setupKind}/generate`, { method: "POST", body: { prompt } });
  return data.task;
}

export async function saveNovelSetup(token: string, projectId: string, setupKind: NovelSetupKind, data: unknown): Promise<void> {
  await novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/setup/${setupKind}`, { method: "PUT", body: { data } });
}

export async function completeNovelSetup(token: string, projectId: string): Promise<{ id: string; setupStage: number; setupCompleted: boolean }> {
  const data = await novelEngineRequest<{ project: { id: string; setupStage: number; setupCompleted: boolean } }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/setup/complete`, { method: "POST" });
  return data.project;
}

export async function getNovelProject(token: string, projectId: string): Promise<NovelProjectDetail> {
  return request<NovelProjectDetail>(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}`, {
    token,
    fallback: "获取小说项目失败",
  });
}

export async function deleteNovelProject(token: string, projectId: string): Promise<void> {
  await request(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    token,
    fallback: "删除小说项目失败",
  });
}

export async function getNovelWorkbench(token: string, projectId: string): Promise<NovelWorkbenchPayload> {
  return request<NovelWorkbenchPayload>(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}/workbench`, {
    token,
    fallback: "获取小说工作台失败",
  });
}

export async function updateNovelProject(token: string, projectId: string, payload: { title?: string; genre?: string; writingModel?: string }): Promise<NovelProjectDetail> {
  return request<NovelProjectDetail>(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    token,
    body: payload,
    fallback: "保存小说项目失败",
  });
}

export async function generateNovelChapter(
  token: string,
  projectId: string,
  payload: { chapterIndex?: number; title: string; summary: string; targetChars: number },
): Promise<NovelTask> {
  const data = await request<{ task: NovelTask }>(
    `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/generate`,
    { method: "POST", token, body: payload, fallback: "创建章节任务失败" },
  );
  return data.task;
}

export async function saveNovelChapter(
  token: string,
  projectId: string,
  chapterIndex: number,
  payload: { title: string; summary: string; content: string; outline?: string; generationHint?: string },
): Promise<NovelChapter> {
  const data = await request<{ chapter: NovelChapter }>(
    `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}`,
    { method: "PUT", token, body: payload, fallback: "保存章节失败" },
  );
  return data.chapter;
}

export async function rewriteNovelChapterSelection(
  token: string,
  projectId: string,
  chapterIndex: number,
  payload: { selectedText: string; selectionStart: number; selectionEnd: number; instruction: string },
): Promise<NovelTask> {
  const data = await request<{ task: NovelTask }>(
    `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/rewrite`,
    { method: "POST", token, body: payload, fallback: "创建局部改写任务失败" },
  );
  return data.task;
}

export async function saveNovelChapterReview(
  token: string,
  projectId: string,
  chapterIndex: number,
  payload: { status?: "pending" | "approved" | "revise"; reviewNotes?: string; regenerateAi?: boolean },
): Promise<NovelChapter> {
  const data = await request<{ chapter: NovelChapter }>(
    `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/review`,
    { method: "POST", token, body: payload, fallback: "保存章节审阅失败" },
  );
  return data.chapter;
}

export async function analyzeNovelChapter(token: string, projectId: string, chapterIndex: number): Promise<NovelChapter> {
  const data = await request<{ chapter: NovelChapter }>(
    `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/analyze`,
    { method: "POST", token, fallback: "分析章节失败" },
  );
  return data.chapter;
}

export async function cancelNovelTask(token: string, taskId: string): Promise<NovelTask> {
  const data = await request<{ task: NovelTask }>(
    `/api/workflow/novels/tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: "POST", token, fallback: "取消小说任务失败" },
  );
  return data.task;
}

export type NovelEngineRun = NovelRunSnapshot;
export type NovelEngineEvent = NovelRunEvent;

export interface NovelEngineStep {
  id: string;
  runId: string;
  sequence: number;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  chapterNumber: number | null;
  attempt: number;
  progress: number;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  taskProgress: {
    status: string;
    percent: number;
    stage: string;
    message: string | null;
    streamedChars: number;
    updatedAt: string;
  } | null;
}

async function novelEngineRequest<T>(
  token: string,
  path: string,
  init: { readonly method?: HttpMethod; readonly body?: unknown } = {},
): Promise<T> {
  return request<T>(path, { method: init.method, token, body: init.body, fallback: "小说引擎请求失败" });
}

export async function startNovelAssistedRun(token: string, projectId: string, payload: {
  chapterIndex: number;
  title?: string;
  summary?: string;
  targetChars: number;
}): Promise<NovelEngineRun> {
  const data = await novelEngineRequest<{ run: NovelEngineRun }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/assisted`, { method: "POST", body: payload });
  return data.run;
}

export async function startNovelAutopilotRun(token: string, projectId: string, payload: {
  targetChapters: number;
  targetCharsPerChapter: number;
  startChapter?: number;
  autoReview?: boolean;
}): Promise<NovelEngineRun> {
  const data = await novelEngineRequest<{ run: NovelEngineRun }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/autopilot`, { method: "POST", body: payload });
  return data.run;
}

export async function listNovelEngineRuns(token: string, projectId: string): Promise<NovelEngineRun[]> {
  const data = await novelEngineRequest<{ runs: NovelEngineRun[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs`);
  return data.runs;
}

export async function getNovelEngineRun(token: string, projectId: string, runId: string): Promise<{ run: NovelEngineRun; steps: NovelEngineStep[] }> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`);
}

export async function controlNovelEngineRun(token: string, projectId: string, runId: string, action: "pause" | "resume" | "cancel" | "revise"): Promise<NovelEngineRun> {
  const data = await novelEngineRequest<{ run: NovelEngineRun }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" });
  return data.run;
}

export async function listNovelEngineEvents(token: string, projectId: string, runId: string, after = 0): Promise<{ events: NovelEngineEvent[]; cursor: number }> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`);
}

export async function streamNovelEngineEvents(args: {
  token: string;
  projectId: string;
  runId: string;
  after?: number;
  signal?: AbortSignal;
  onEvent: (event: NovelEngineEvent) => void;
}): Promise<void> {
  // 不走 request<T>()：SSE 流的 body 要留给下面的 reader。
  const response = await requestResponse(
    `/api/workflow/novels/projects/${encodeURIComponent(args.projectId)}/runs/${encodeURIComponent(args.runId)}/events/stream?after=${args.after ?? 0}`,
    { token: args.token, signal: args.signal, fallback: "连接小说运行流失败" },
  );
  if (!response.body) throw new Error("小说运行流不可用");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:"));
      if (data.length) {
        try {
          args.onEvent(JSON.parse(data.map((line) => line.slice(5).trimStart()).join("\n")) as NovelEngineEvent);
        } catch {
          // Ignore malformed or partial server events and continue the stream.
        }
      }
      split = buffer.indexOf("\n\n");
    }
  }
}

export interface NovelNarrativeDashboard {
  project: { storyPhase: string; autopilotStatus: string; currentBranch: string };
  stats: { chapters: number; totalChars: number; openForeshadows: number; storylines: number; debts: number; facts: number; characters: number };
  tensionCurve: Array<{ chapterIndex: number; title: string; tensionScore: number; plotTension: number; emotionalTension: number; pacingTension: number; qualityScore: number; billableChars: number }>;
}

export async function getNovelNarrativeDashboard(token: string, projectId: string): Promise<NovelNarrativeDashboard> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/narrative-dashboard`);
}

export interface NovelStructureNode {
  id: string;
  projectId: string;
  parentId: string | null;
  nodeType: "book" | "volume" | "act" | "chapter";
  title: string;
  description: string;
  number: number;
  startChapter: number | null;
  endChapter: number | null;
  outline: string;
  metadata: Record<string, unknown>;
}

export async function getNovelStructure(token: string, projectId: string): Promise<NovelStructureNode[]> {
  const data = await novelEngineRequest<{ nodes: NovelStructureNode[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/structure`);
  return data.nodes;
}

export type NovelEditableResource = "structure" | "characters" | "locations" | "storylines" | "storyline-milestones" | "props" | "timeline" | "foreshadows" | "narrative-debts";

export async function createNovelResource<T extends Record<string, unknown>>(token: string, projectId: string, resource: NovelEditableResource, payload: Record<string, unknown>): Promise<T> {
  const data = await novelEngineRequest<Record<string, T>>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/${resource}`, { method: "POST", body: payload });
  return Object.values(data)[0]!;
}

export async function updateNovelResource<T extends Record<string, unknown>>(token: string, projectId: string, resource: NovelEditableResource, entityId: string, payload: Record<string, unknown>): Promise<T> {
  const data = await novelEngineRequest<Record<string, T>>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/${resource}/${encodeURIComponent(entityId)}`, { method: "PATCH", body: payload });
  return Object.values(data)[0]!;
}

export async function deleteNovelResource(token: string, projectId: string, resource: NovelEditableResource | "character-relations", entityId: string): Promise<void> {
  await novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/${resource}/${encodeURIComponent(entityId)}`, { method: "DELETE" });
}

export async function createNovelStorylineMilestone(token: string, projectId: string, storylineId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = await novelEngineRequest<{ milestone: Record<string, unknown> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/storylines/${encodeURIComponent(storylineId)}/milestones`, { method: "POST", body: payload });
  return data.milestone;
}

export async function createNovelCharacterRelation(token: string, projectId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = await novelEngineRequest<{ relation: Record<string, unknown> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/character-relations`, { method: "POST", body: payload });
  return data.relation;
}

export interface NovelNarrativeAssets {
  timeline: Array<Record<string, unknown>>;
  foreshadows: Array<Record<string, unknown>>;
  debts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  causalEdges: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  foreshadowEvents: Array<Record<string, unknown>>;
}

export async function getNovelNarrativeAssets(token: string, projectId: string): Promise<NovelNarrativeAssets> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/narrative-assets`);
}

export interface NovelContinuityBackfillResult {
  chapters: number;
  timelineEvents: number;
  props: number;
  propEvents: number;
  foreshadows: number;
  foreshadowEvents: number;
  debts: number;
  reinforced: number;
  resolved: number;
  rescoredChapters: number;
}

export async function backfillNovelNarrativeAssets(token: string, projectId: string): Promise<NovelContinuityBackfillResult> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/narrative-assets/backfill`, { method: "POST" });
}

export interface NovelChapterVersion {
  id: string;
  chapterId: string;
  title: string;
  content: string;
  billableChars: number;
  operationId: string | null;
  createdAt: string;
}

export interface NovelGenerationRequest {
  id: string;
  projectId: string;
  chapterId: string | null;
  chapterIndex: number | null;
  taskId: string;
  runId: string | null;
  stepId: string | null;
  targetKind: string;
  attempt: number;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number | null;
  maxTokens: number;
  templateId: string | null;
  templateVersion: number | null;
  requestHash: string;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listNovelGenerationRequests(token: string, projectId: string, chapterIndex: number): Promise<NovelGenerationRequest[]> {
  const data = await novelEngineRequest<{ requests: NovelGenerationRequest[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/generation-requests`);
  return data.requests;
}

export async function listNovelChapterVersions(token: string, projectId: string, chapterIndex: number): Promise<NovelChapterVersion[]> {
  const data = await novelEngineRequest<{ versions: NovelChapterVersion[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/versions`);
  return data.versions;
}

export async function restoreNovelChapterVersion(token: string, projectId: string, chapterIndex: number, versionId: string): Promise<NovelChapter> {
  const data = await novelEngineRequest<{ chapter: NovelChapter }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
  return data.chapter;
}

export async function listNovelCharacters(token: string, projectId: string): Promise<{ characters: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>> }> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/characters`);
}

export async function listNovelStorylines(token: string, projectId: string): Promise<Array<Record<string, unknown>>> {
  const data = await novelEngineRequest<{ storylines: Array<Record<string, unknown>> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/storylines`);
  return data.storylines;
}

export async function listNovelProps(token: string, projectId: string): Promise<Array<Record<string, unknown>>> {
  const data = await novelEngineRequest<{ props: Array<Record<string, unknown>> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/props`);
  return data.props;
}

export async function listNovelCheckpoints(token: string, projectId: string): Promise<Array<Record<string, unknown>>> {
  const data = await novelEngineRequest<{ checkpoints: Array<Record<string, unknown>> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/checkpoints`);
  return data.checkpoints;
}

export async function createNovelCheckpoint(token: string, projectId: string, label: string): Promise<Record<string, unknown>> {
  const data = await novelEngineRequest<{ checkpoint: Record<string, unknown> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/checkpoints`, { method: "POST", body: { label, branchName: "main" } });
  return data.checkpoint;
}

export async function rollbackNovelCheckpoint(token: string, projectId: string, checkpointId: string): Promise<void> {
  await novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/rollback`, { method: "POST" });
}

export async function createNovelBranch(token: string, projectId: string, checkpointId: string, branchName: string): Promise<Record<string, unknown>> {
  const data = await novelEngineRequest<{ checkpoint: Record<string, unknown> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/branch`, { method: "POST", body: { branchName } });
  return data.checkpoint;
}

export interface NovelPromptTemplate {
  id: string;
  nodeKey: string;
  name: string;
  category: string;
  content: string;
  variables: string[];
  model: string;
  temperature: number;
  activeVersion: number;
  versions: Array<{ id: string; version: number; content: string; changeNote: string; createdAt: string }>;
}

export async function listNovelPrompts(token: string, projectId: string): Promise<NovelPromptTemplate[]> {
  const data = await novelEngineRequest<{ templates: NovelPromptTemplate[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/prompts`);
  return data.templates;
}

export async function saveNovelPrompt(token: string, projectId: string, payload: {
  nodeKey: string;
  name: string;
  category: string;
  content: string;
  variables?: string[];
  model?: string;
  temperature?: number;
  changeNote?: string;
}): Promise<NovelPromptTemplate> {
  const data = await novelEngineRequest<{ template: NovelPromptTemplate }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/prompts`, { method: "POST", body: payload });
  return data.template;
}

export async function rollbackNovelPrompt(token: string, projectId: string, templateId: string, version: number): Promise<NovelPromptTemplate> {
  const data = await novelEngineRequest<{ template: NovelPromptTemplate }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/prompts/${encodeURIComponent(templateId)}/rollback`, { method: "POST", body: { version } });
  return data.template;
}

export async function exportNovelProject(token: string, projectId: string, format: "markdown" | "docx" | "epub" | "pdf"): Promise<Blob> {
  // 不走 request<T>()：要的是 blob，不是 JSON。
  const response = await requestResponse(
    `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/export?format=${format}`,
    { token, fallback: "导出小说失败" },
  );
  return response.blob();
}

export async function importNovelProject(token: string, projectId: string, payload: { format: "markdown" | "text"; content: string; mode: "replace" | "append"; filename?: string }): Promise<{ importedChapters: number; mode: string; title: string }> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/import`, { method: "POST", body: payload });
}
