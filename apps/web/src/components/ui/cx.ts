/**
 * 拼 className 的唯一小工具：过滤掉 false / undefined / 空串再用空格连接。
 *
 * 故意不做 tailwind-merge 式的冲突消解。className 里出现同一 CSS 属性的第二个
 * utility（比如工厂给了 `p-4`、调用方又传 `p-6`）谁生效取决于两条规则在构建产物里的
 * 先后，而那个顺序是 Tailwind 自己排的、跟字符串顺序无关 —— 所以本目录的约定是：
 * **能用工厂参数表达的就用参数，className 只加工厂没碰过的属性**（布局、间距、动画等）。
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
