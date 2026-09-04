import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * 「必须登录」的 Fastify preHandler。
 *
 * 行为与它替换掉的内联守卫逐字节一致：同样的 401、同样的 `{ error: "未登录" }`，
 * 所以前端看不出任何差异。别改文案 —— 前端有按这个字符串判分支的地方。
 *
 * userId 由 `server.ts` 的全局 onRequest 钩子从 `Authorization: Bearer` 或 token cookie
 * 解析后写入（见 `server.ts:140` 的 `decorateRequest("userId", "")`）。这里只做判空，
 * 不重新验签 —— 验签是那个钩子的职责，两处都验等于把同一件事写两遍。
 *
 * 用 `.trim()` 是跟随原有 helper 里最严的那版（`codex-pet-routes.ts` 与 dub 的 `uid()`
 * 都 trim）。真实 userId 来自签名 token，不会带空白，所以 trim 只是把「全空白」也判成
 * 未登录，是原有行为的超集，不会放过任何原本能过的请求。
 *
 * ## 挂插件级还是逐路由
 *
 * 挂插件级（`app.addHook("preHandler", requireUser)`）的前提是**该 Fastify 作用域里每个
 * 路由都必须登录**。作用域按 `app.register()` 封装，但注意 `novel/routes.ts:370` 是直接
 * 调用而非 register，所以它和 `resource-routes.ts`、`export.ts` 共享一个作用域 —— 在那儿
 * 挂一个钩子会同时覆盖三个文件的 60 个路由。
 *
 * 作用域里只要有一个公开路由就不能挂插件级，得逐路由挂。已知的公开路由：
 * 签名 URL 取文件（image / codex-pet 的 blob）、`GET /api/models`、`GET /api/client-menu`、
 * `GET /api/announcements`、登录注册本身。
 *
 * 还有一类**看着像守卫其实不是**的，同样不能换：签名访问那几条 blob 路由虽然也返回
 * 401 未登录，但条件是 `!isOwner && !hasSignedAccess` —— 带合法签名、不带 token 的请求
 * 本来就该放行，挂上去会把签名访问打死。
 */
// 不标返回类型，跟 `admin/guard.ts:29` 的 requireAdmin 一致：标了 `Promise<void>` 的话
// `return reply.send()` 会因为 FastifyReply 不能赋给 void 而编译报错。
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  // `?.` 不是多余的。类型上 userId 是必有的 string（靠 server.ts 的 decorateRequest 兜底），
  // 但单测里直接 new 一个裸 Fastify app 时没有那层 decorate，运行时会是 undefined，
  // 不用 `?.` 会抛 TypeError 而不是干净地返回 401。
  if (!req.userId?.trim()) {
    // 在 hook 里 send 就终止请求生命周期，handler 不会执行。
    return reply.code(401).send({ error: "未登录" });
  }
}
