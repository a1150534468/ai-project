/**
 * 全仓统一的输入 token 估算口径：字符数 / 3，下限 1 个 token。
 *
 * 除数与下限**必须**只有这一处 —— 各域自己实现一份的话，除数漂移就等于不同域
 * 按不同标准扣费。域与域之间允许不同的只有「喂进来的文本怎么拼」，那部分留在调用方。
 *
 * 例外：`chat/attachments.ts` 的同名函数还要按图片张数加 `imageCount * 1000`，
 * 是聊天域独有的口径，故意不并进来。
 */
export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}

/** system 与 user 之间空行分隔的通用提示词形状（video / dub / ecom 助写 / 本地推广共用）。 */
export function estimateInputTokens(system: string, user: string): number {
  return estimateTextTokens(`${system}\n\n${user}`);
}
