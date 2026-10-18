// transcription 域门面：域外（server.ts / workers / 其他域）只从这里导入，
// 不直接 import 本目录内的实现文件。
export { transcriptionWorkflowRoutes } from "./transcription-routes.js";
export type { TranscriptionRouteDeps } from "./transcription-route-context.js";
