// image 域门面（P2.1）：域外（server.ts / workers / 其他域）只从这里导入，
// 不直接 import 本目录内的实现文件。
export { imageWorkflowRoutes } from "./image-routes.js";
