/**
 * 去掉 URL 末尾的斜杠，好让 `${base}/${path}` 拼接不出现 `//`。
 *
 * `\/+$` 而非 `\/$`：base 来自环境变量，`https://cdn.example.com//` 这种手误要一次削平。
 */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
