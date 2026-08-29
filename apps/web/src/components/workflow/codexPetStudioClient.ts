/**
 * 桌宠工坊的可注入 API 客户端。从 `CodexPetStudio.tsx` 原样搬出。
 *
 * **这 18 个方法名是测试契约的一部分**:`CodexPetStudio.test.tsx` 靠 `makeClient()` 整体替换
 * 这个对象来驱动编排,任何改名都会同时改掉测试的桩,等于把护栏一起挪走。所以此文件只搬不改。
 */
import * as codexPetApi from "../../codexPetApi";
import type {
  CodexPetBaseSelection,
  CodexPetCreatePayload,
  CodexPetEvent,
  CodexPetInstallLink,
  CodexPetModelOptions,
  CodexPetPricing,
  CodexPetProject,
  CodexPetProjectDetail,
  CodexPetProjectSummary,
  CodexPetRun,
  CodexPetStartResult,
  CodexPetUpdatePayload,
} from "../../codexPetApi";

export interface CodexPetStudioClient {
  readonly getPricing: (token: string) => Promise<CodexPetPricing>;
  readonly getModelOptions?: (token: string) => Promise<CodexPetModelOptions>;
  readonly listProjects: (token: string) => Promise<readonly CodexPetProjectSummary[]>;
  readonly createProject: (token: string, payload: CodexPetCreatePayload) => Promise<CodexPetProject>;
  readonly getProject: (token: string, projectId: string, signal?: AbortSignal) => Promise<CodexPetProjectDetail>;
  readonly updateProject: (token: string, projectId: string, payload: CodexPetUpdatePayload) => Promise<CodexPetProject>;
  readonly deleteProject: (token: string, projectId: string) => Promise<void>;
  readonly startRun: (token: string, projectId: string, idempotencyKey: string) => Promise<CodexPetStartResult>;
  readonly continueFailedRun: (token: string, projectId: string, runId: string, idempotencyKey: string) => Promise<CodexPetStartResult>;
  readonly resumeGateFailure: (token: string, projectId: string, runId: string, reason?: string) => Promise<CodexPetStartResult>;
  readonly selectBase: (
    token: string,
    projectId: string,
    runId: string,
    selection: CodexPetBaseSelection,
  ) => Promise<CodexPetRun>;
  readonly approveNextImage: (token: string, projectId: string, runId: string, idempotencyKey: string) => Promise<CodexPetRun>;
  readonly cancelRun: (token: string, projectId: string, runId: string) => Promise<CodexPetRun>;
  readonly listEvents: (
    token: string,
    projectId: string,
    runId: string,
    after?: number,
    signal?: AbortSignal,
  ) => Promise<{ readonly events: readonly CodexPetEvent[]; readonly cursor: number }>;
  readonly streamEvents: typeof codexPetApi.streamCodexPetEvents;
  readonly createInstallLink: (token: string, projectId: string) => Promise<CodexPetInstallLink>;
  readonly downloadPackage: typeof codexPetApi.downloadCodexPetPackage;
  readonly uploadReference: typeof codexPetApi.uploadCodexPetReferenceAsset;
}

export const DEFAULT_CODEX_PET_STUDIO_CLIENT: CodexPetStudioClient = {
  getPricing: codexPetApi.getCodexPetPricing,
  getModelOptions: codexPetApi.getCodexPetModelOptions,
  listProjects: codexPetApi.listCodexPetProjects,
  createProject: codexPetApi.createCodexPetProject,
  getProject: codexPetApi.getCodexPetProject,
  updateProject: codexPetApi.updateCodexPetProject,
  deleteProject: codexPetApi.deleteCodexPetProject,
  startRun: codexPetApi.startCodexPetRun,
  continueFailedRun: codexPetApi.continueFailedCodexPetRun,
  resumeGateFailure: codexPetApi.resumeCodexPetGateFailure,
  selectBase: codexPetApi.selectCodexPetBase,
  approveNextImage: codexPetApi.approveCodexPetNextImage,
  cancelRun: codexPetApi.cancelCodexPetRun,
  listEvents: codexPetApi.listCodexPetEvents,
  streamEvents: codexPetApi.streamCodexPetEvents,
  createInstallLink: codexPetApi.createCodexPetInstallLink,
  downloadPackage: codexPetApi.downloadCodexPetPackage,
  uploadReference: codexPetApi.uploadCodexPetReferenceAsset,
};
