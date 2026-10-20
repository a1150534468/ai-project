/**
 * Prisma 唯一约束冲突判定（P2002）。
 *
 * 原先 image / transcription / codex-pet 各写一份，语义其实一致（都只看
 * `code === "P2002"`），只是在「怎么把 unknown 摆成对象」上写法不同。收在这里，
 * 让「什么叫唯一约束冲突」只有一处定义。
 *
 * 注意与 `auth/prisma-errors.ts` 不是一回事：那个返回 `meta.target`（冲突的是哪些字段），
 * 是更深的一层，注册流程要靠它区分「用户名被占用」和「uid 撞了」。这里只要 boolean——
 * 调用方是用来识别幂等重放的，不需要知道撞了哪个字段。**别顺手把两者合并**。
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}
