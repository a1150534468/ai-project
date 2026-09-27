// nail-try-on 域门面：域外（server-routes.ts）只从这里导入，
// 不直接 import 本目录内的实现文件。
export { nailTryOnWorkflowRoutes } from "./nail-try-on-routes.js";
