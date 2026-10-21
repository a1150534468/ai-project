/**
 * 属性协议白名单：标签白名单（article-workflow-html-policy）只管「允许哪些标签」，
 * 不管属性值里写的是什么协议 —— `<a href="javascript:...">` 与
 * `<img src="data:text/html,...">` 都能通过。这里补上协议这一层：
 * 遍历 href / src / xlink:href，只放行 http: / https: / mailto: / tel:
 * 与相对路径（含 # 锚点、// 协议相对地址），其余整条属性剥掉（保留标签本身）。
 *
 * 纯函数、无 DOM 依赖：正则以属性边界为锚，不跨标签匹配。
 */

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** 属性边界：前面必须是空白，引号值 / 单引号值 / 无引号值三种形状都收。 */
const ATTRIBUTE_PATTERN = /(\s)(href|src|xlink:href)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi;

/** 浏览器会先解码属性值里的字符引用再判协议，`&#106;avascript:` 这类混淆要按解码后判。 */
function decodeCharRefs(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);?/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/gi, "&");
}

function isAllowedAttributeValue(rawValue: string): boolean {
  const unquoted = rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue.slice(1, -1) : rawValue;
  // 浏览器判协议前会剥掉值首的空白与控制字符，`  javascript:` / `\x01javascript:` 同样生效
  const decoded = decodeCharRefs(unquoted).replace(/^[\s\u0000-\u0020]+/, "");
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(decoded);
  if (!schemeMatch) return true; // 无协议：相对路径 / #锚点 / //协议相对地址
  return ALLOWED_SCHEMES.has(schemeMatch[1].toLowerCase());
}

export function sanitizeAttributeProtocols(html: string): string {
  // 剥除时连同属性前面的空白一起去掉，否则会留下双空格
  return html.replace(ATTRIBUTE_PATTERN, (match, _leading: string, _name: string, _eq: string, value: string) =>
    isAllowedAttributeValue(value) ? match : "",
  );
}
