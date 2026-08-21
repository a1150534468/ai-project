// try-on 域门面（P2.1）：域外（server.ts）只从这里导入，
// 不直接 import 本目录内的实现文件。
export { tryOnWorkflowRoutes } from "./try-on-routes.js";
