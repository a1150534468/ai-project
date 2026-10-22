// novel 域门面（P2.1）：域外（server.ts / workers）只从这里导入，
// 不直接 import 本目录内的实现文件。
//
// 2026-10-20：`src/novel` 那 6 处回边已改为直连叶子文件，本门面不再靠「谁排在谁前面」
// 维持正确性——原来那段注释讲的是 outbox 在模块求值期要取 NOVEL_TARGET_KINDS 而踩到
// 环的事故，现在 outbox 直连 novel-types，环已断。
// 门面仍然保留：它是域外唯一入口，只是里面的排列顺序不再是不变量。
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
