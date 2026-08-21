// ecom 域门面（P2.1）：域外（server.ts / workers / 其他域）只从这里导入，
// 不直接 import 本目录内的实现文件。
//
// 已知例外：`_shared/ecom-route-helpers.ts` 仍直接 import 本目录的
// ecom-route-types / ecom-route-mutation / ecom-prompts。那个文件名带 ecom- 前缀，
// 实际混装了通用路由基建（authUserId / serializeWorkflow / appendBillingOperationId，
// 被 article / image / report 三域共用）与 ecom 专属的入参解析，所以两边都拆不干净。
// 它由 P2.2「收敛重复工具函数」Step 4 拆分后，这处 _shared -> 域 的倒挂依赖即消失；
// 在那之前不通过本门面绕行，避免把 index.ts 塞进已有的模块环里（TDZ 风险）。
export { ecomWorkflowRoutes } from "./ecom-routes.js";
export { ecomMainImageRoutes } from "./ecom-main-routes.js";
export { ecomHelpWriteRoutes } from "./ecom-helpwrite-routes.js";
