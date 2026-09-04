// novel 域门面（P2.1）：域外（server.ts / workers / src/novel 引擎）只从这里导入，
// 不直接 import 本目录内的实现文件。
//
// 导出顺序有意义，勿随手调：`workflow/novel` 与 `src/novel` 之间本来就存在模块环
// （novel-routes -> src/novel/outbox -> 本门面），而 outbox 在模块求值期就要用
// NOVEL_TARGET_KINDS.filter(...)。门面里叶子模块（类型/常量）必须排在 routes、
// task-runner 这些会绕回 src/novel 的模块之前，否则回边拿到的是未初始化的绑定
// （TypeError: Cannot read properties of undefined）。
export { NOVEL_TARGET_KINDS } from "./novel-types.js";
export type { NovelTargetKind } from "./novel-types.js";
export type { NovelEventCard, NovelForeshadowPayload } from "./novel-workbench-types.js";
export { buildNovelQualityDiagnostics, deriveNovelChapterAssets } from "./novel-text-analysis.js";
export { buildNovelChapterPostprocessPayload } from "./novel-postprocess.js";
export { createNovelGenerator } from "./novel-generation.js";
export {
  refreshNovelVectorMemoryBestEffort,
  reserveAndCreateTask,
  runNovelTask,
} from "./novel-task-runner.js";
export type { NovelTaskRow } from "./novel-task-runner.js";
export { novelWorkflowRoutes } from "./novel-routes.js";
