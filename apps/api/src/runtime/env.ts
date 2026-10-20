/**
 * 「读一个整数配置，非法值退化成默认值」的唯一实现。
 *
 * 这条不变量此前被判定了 15 次，口径漂移成四种（`Number.isSafeInteger` /
 * `Number.isInteger` / `Number.isFinite` / `parseInt`，有的 `>0` 有的 `>=0`），
 * 而且**自我繁殖**：`workflow/_shared/reservation-window.ts` 里那段「0 是合法取值，
 * 所以不能用 positiveNumber，于是又写了一份」的注释就是实证。分叉的根因只有两个：
 * 输入是 env 字符串还是数字、0 算不算合法 —— 所以把它们做成参数，而不是各写一份。
 *
 * 非法一律退默认，不抛：一个写错的环境变量应当退化成默认值，而不是让 KB 检索拿到
 * topK=0 静默返回空结果（chat/routes-runtime 里那句注释是同一个判断）。
 */

export interface IntegerOptions {
  /** 0 是否算合法取值。默认 false——绝大多数阈值里 0 意味着「关掉」，通常是配错了。 */
  readonly allowZero?: boolean;
}

/** 校验一个已经是数字（或数字字符串）的值。options 覆盖 env 时用这条。 */
export function intOr(value: unknown, fallback: number, options: IntegerOptions = {}): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return options.allowZero ? (parsed < 0 ? fallback : parsed) : parsed > 0 ? parsed : fallback;
}

/** 从 env 读一个整数配置。空串与没配同义（都退默认），不会在 allowZero 下被当成 0。 */
export function envInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: IntegerOptions = {},
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return intOr(raw, fallback, options);
}
