// local-business-promo 域门面（P2.1）：域外（server.ts / workers）只从这里导入，
// 不直接 import 本目录内的实现文件。
//
// audio-probe.ts / audio-service.ts 也在本目录：它们导出的全是 LOCAL_BUSINESS_PROMO_*
// 前缀的 BGM/配音能力，且只被本域文件引用，不是独立域，也不该进 _shared/。
//
// 导出顺序按依赖从叶子到入口排列（queue/refund → runner → routes），避免门面被塞进
// 模块环时回边拿到未初始化的绑定（见 novel/index.ts 同类注释）。
export { closeLocalBusinessPromoQueue, createLocalBusinessPromoWorker } from "./local-business-promo-queue.js";
export { startLocalBusinessPromoRefundReaper } from "./local-business-promo-refund.js";
export { executeLocalBusinessPromoRun } from "./local-business-promo-runner.js";
export { localBusinessPromoRoutes } from "./local-business-promo-routes.js";
