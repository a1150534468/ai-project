/**
 * 小说任务运行器门面。原文件 935 行,按依赖方向拆成 5 个同域文件,这里只做重新导出。
 * 对外导出的 7 个名字与拆分前逐字一致,`novel-task-runner.test.ts` / `novel-routes.ts` /
 * `novel/index.ts` 零改动。
 *
 * 分工:
 *  - novel-task-shared.ts   任务行形状、四个共用叶子工具
 *  - novel-task-read.ts     对外 JSON 形状、项目详情聚合读、下一章序号
 *  - novel-task-context.ts  结构化资料读齐 + 压成上下文文本(含向量记忆降级)
 *  - novel-task-persist.ts  建单 与 结果写回,同一条任务的两端
 *  - novel-task-run.ts      runNovelTask 主流程、取消检查、进度心跳
 *
 * 依赖方向是单向的:shared → read;shared/context → persist;shared/context/persist → run。
 * 新增功能请挑一层落地,不要在本文件里写实现 —— 这里一旦有实现,拆分就白做了。
 */

export type { NovelTaskRow } from "./novel-task-shared.js";
export { getProjectDetail, nextChapterIndex, serializeTask } from "./novel-task-read.js";
export { refreshNovelVectorMemoryBestEffort } from "./novel-task-context.js";
export { reserveAndCreateTask } from "./novel-task-persist.js";
export { runNovelTask } from "./novel-task-run.js";
