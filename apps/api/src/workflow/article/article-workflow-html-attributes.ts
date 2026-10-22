import { parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";

/**
 * 按浏览器的 HTML 语义检查真实属性，防止引号内的伪 href 掩盖标签上的危险链接。
 * 解析器同时负责解码字符实体；超范围数字实体按 HTML 规则处理，不会抛 RangeError。
 * 只允许 http、https、mailto、tel 和相对地址，其余协议整条属性剥除。
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href"]);

function isAllowedAttributeValue(value: string): boolean {
  try {
    // 使用 WHATWG URL 解析处理控制字符与相对路径，避免再实现一份浏览器协议规则。
    return ALLOWED_PROTOCOLS.has(new URL(value, "https://article.invalid/").protocol);
  } catch {
    return false;
  }
}

export function sanitizeAttributeProtocols(html: string): string {
  const fragment = parseFragment(html);
  const pending: DefaultTreeAdapterTypes.ChildNode[] = [...fragment.childNodes];
  let changed = false;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!("attrs" in node)) continue;
    node.attrs = node.attrs.filter((attribute) => {
      const name = attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
      if (!URL_ATTRIBUTES.has(name) || isAllowedAttributeValue(attribute.value)) return true;
      changed = true;
      return false;
    });
    for (const child of node.childNodes) pending.push(child);
    if ("content" in node) {
      for (const child of node.content.childNodes) pending.push(child);
    }
  }
  // 无需清洗时保留安全正文的原始排版；有改动则序列化整个片段，连同重复属性一起规范化。
  // 不能只按源码位置删除首个属性，否则浏览器原本忽略的第二个危险 href 会重新生效。
  return changed ? serialize(fragment) : html;
}
