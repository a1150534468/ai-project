/**
 * 「这个值能不能当对象读属性」的两个守卫。
 *
 * 两个函数只差 `Array.isArray` 一句，但**不能**合成一个 —— 数组也是 `typeof "object"`，
 * 于是「数组算不算对象」这件事在各调用点是有语义的：
 *
 * - `isPlainObject`：排除数组。用于解析结构化载荷（LLM 返回的 step / task / 章节 JSON），
 *   数组走到对象分支就是格式错误，得让它落到 else 去报错或返回兜底值。
 * - `isObjectLike`：不排除数组。用于探查任意上游响应 / error 对象的属性
 *   （`error.cause`、`payload.usage`、`event.error`），此处数组顶多是「取不到那个 key」，
 *   多一层 `Array.isArray` 只会白白改掉现有分支走向。
 *
 * 新代码默认选 `isPlainObject`；只有确实要沿用「数组也放过」的旧行为时才用 `isObjectLike`。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 见上：只判 `typeof "object"` 且非 null，**数组也会通过**。 */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
