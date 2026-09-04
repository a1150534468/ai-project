// codex-pet 域门面（P2.1）：域外（server.ts / workers / scripts / 其他域）只从这里导入，
// 不直接 import 本目录内的实现文件。
//
// 导出顺序按依赖从叶子到入口排列：runner / routes / cleanup 这些会拉起整域的模块放最后，
// 避免门面被塞进模块环时回边拿到未初始化的绑定（见 novel/index.ts 同类注释）。
export { appendCodexPetEvent, codexPetRunChannel, sanitizeCodexPetDiagnosticText } from "./codex-pet-events.js";
export { installCodexPetUpstreamDnsOverride } from "./codex-pet-network.js";
export { createCodexPetArtifactStore, deleteCodexPetArtifact } from "./codex-pet-storage.js";
export { assertCodexPetImageRoute } from "./codex-pet-model-contract.js";
export { assertCodexPetVisualQaRoute } from "./codex-pet-visual.js";
export { archiveCodexPetLegacyRuns } from "./codex-pet-read-only-archive.js";
export { closeCodexPetQueue, createCodexPetWorker, enqueueCodexPetRun } from "./codex-pet-queue.js";
export {
  closeCodexPetCleanupQueue,
  createCodexPetCleanupWorker,
  enqueueCodexPetProjectCleanup,
  executeCodexPetProjectCleanup,
} from "./codex-pet-cleanup.js";
export { CODEX_PET_ACTIVE_STATUSES, CodexPetLeaseLostError, executeCodexPetRun } from "./codex-pet-runner.js";
export { codexPetRoutes } from "./codex-pet-routes.js";
