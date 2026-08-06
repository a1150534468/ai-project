// `FastifyRequest.userId` 的唯一声明处。
//
// 这句 `import "fastify"` 是必须的，别删：.d.ts 若没有任何顶层 import/export，
// TypeScript 会把 `declare module "fastify"` 当成「声明一个全新的 fastify 模块」
// 从而顶掉 fastify 自己的类型，而不是扩展它。有了这句才是 module augmentation。
import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * 由 `server.ts` 的全局 onRequest 钩子从 `Authorization: Bearer` 或 token cookie 解析而来。
     *
     * 类型是必有的 `string` 而不是 `string | undefined`，因为 `server.ts` 里
     * `app.decorateRequest("userId", "")` 给了默认值 —— 未登录时是空串，从来不是 undefined。
     * 判「有没有登录」用 `if (!req.userId)`，不要判 `=== undefined`。
     *
     * 注意类型系统表达不了「过了 requireUser 之后这里必非空」。挂了 `requireUser`
     * preHandler 的路由可以直接用，不必再判空。
     */
    userId: string;
  }
}
