import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 配图的取图地址前缀。走 API 自己代理对象存储，而不是把图片字节塞进正文。
 *
 * 相对路径：web 端 dev 走 vite 的 `/api` 代理、线上同源，两边都直接可用。
 */
export const ARTICLE_WORKFLOW_IMAGE_BLOB_PREFIX = "/api/workflow/article-workflow/images";

/** 出参地址的有效期。只用于「这一次页面渲染」，不落库，所以可以短。 */
export const ARTICLE_WORKFLOW_IMAGE_BLOB_TTL_MS = 6 * 3600_000;

/**
 * 落库形态：稳定、不带签名。正文是要存进库的，存签名地址等于存一个会过期的死链。
 */
export function articleWorkflowImageBlobUrl(assetId: string): string {
  return `${ARTICLE_WORKFLOW_IMAGE_BLOB_PREFIX}/${encodeURIComponent(assetId)}/blob`;
}

/**
 * 落库用的图片地址：能不内嵌字节就不内嵌。
 *
 * 为什么必须有这一层：`storeWorkflowImage` 在对象存储端点是 localhost 且没配公网前缀时，
 * 会返回 base64 data URL。图文工作流又会把这个地址写进 `bodyHtml` 的 `<img src>` 和
 * `imageManifestJson`，于是一张 2.6MB 的图被存三份（正文 + manifest 的 imageUrl
 * 和 thumbnailUrl）。线上实测：4 张图的一篇稿子 `bodyHtml` 10.5MB、详情接口 31.6MB，
 * 编辑器每次自动保存都要把这 10.5MB 发回来、再过两遍 XML 解析。
 *
 * 换成代理地址的前提是**字节确实在对象存储里**（objectKey 非空）。
 * 没配对象存储时 data URL 是图片的唯一副本，这时换掉就是把图弄丢，所以必须原样保留。
 *
 * 已经是 http(s) 的地址一律原样保留——那是配了公网前缀的线上形态，也是
 * 「一键复制到公众号」唯一能用的形态（公众号编辑器会丢掉 data URL）。
 */
export function articleWorkflowStorableImageUrl(args: {
  readonly url: string;
  readonly assetId: string | null;
  readonly objectKey: string | null;
}): string {
  const url = args.url.trim();
  if (!url.startsWith("data:")) return url;
  if (!args.assetId || !args.objectKey) return url;
  return articleWorkflowImageBlobUrl(args.assetId);
}

function signingSecret(env: NodeJS.ProcessEnv): string | null {
  const secret = env.SESSION_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

function signaturePayload(assetId: string, expiresAtMs: number): string {
  return `article-image\n${assetId}\n${expiresAtMs}`;
}

/**
 * 出参形态：给稳定地址补上短期签名。
 *
 * 为什么非得签名不可：正文里的 `<img>` 是浏览器自己发的请求，带不上
 * `Authorization` 头，而 web 端的登录态存在 localStorage 里、并没有 cookie。
 * 所以只靠会话鉴权的取图地址在页面上必然是碎图。签名地址让 `<img>` 自己就能取到图。
 *
 * 签名只出现在**响应**里，不落库：库里存稳定地址，每次读的时候现签一份。
 */
export function articleWorkflowSignedImageBlobUrl(args: {
  readonly assetId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}): string {
  const stable = articleWorkflowImageBlobUrl(args.assetId);
  const secret = signingSecret(args.env);
  // 没有可用密钥时退回稳定地址：取图路由仍接受会话鉴权，不至于整篇打不开。
  if (!secret) return stable;
  const exp = (args.nowMs ?? Date.now()) + ARTICLE_WORKFLOW_IMAGE_BLOB_TTL_MS;
  const sig = createHmac("sha256", secret).update(signaturePayload(args.assetId, exp)).digest("base64url");
  return `${stable}?${new URLSearchParams({ exp: String(exp), sig }).toString()}`;
}

export function articleWorkflowImageBlobSignatureValid(args: {
  readonly assetId: string;
  readonly expiresAtMs: number;
  readonly signature: string;
  readonly env: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}): boolean {
  const secret = signingSecret(args.env);
  if (!secret) return false;
  if (args.expiresAtMs < (args.nowMs ?? Date.now())) return false;
  const expected = createHmac("sha256", secret)
    .update(signaturePayload(args.assetId, args.expiresAtMs))
    .digest("base64url");
  const actual = Buffer.from(args.signature);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** 从稳定地址里取回 assetId；不是本工作流的代理地址就返回 null。 */
export function articleWorkflowAssetIdFromBlobUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(`${ARTICLE_WORKFLOW_IMAGE_BLOB_PREFIX}/`)) return null;
  const rest = trimmed.slice(ARTICLE_WORKFLOW_IMAGE_BLOB_PREFIX.length + 1);
  const segment = rest.split("?")[0]?.split("/") ?? [];
  if (segment.length !== 2 || segment[1] !== "blob" || !segment[0]) return null;
  try {
    return decodeURIComponent(segment[0]);
  } catch {
    return null;
  }
}

/** 匹配正文里的代理地址，签名与否都算。assetId 是 cuid，再叠一层 encodeURIComponent 的转义字符。 */
const BLOB_URL_PATTERN = /\/api\/workflow\/article-workflow\/images\/([A-Za-z0-9%._~-]+)\/blob(?:\?[^\s"'<>]*)?/g;

/** 单个地址：稳定形态 → 签名形态。非代理地址原样返回。 */
export function articleWorkflowResponseImageUrl(args: {
  readonly url: string;
  readonly env: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}): string {
  const assetId = articleWorkflowAssetIdFromBlobUrl(args.url);
  if (!assetId) return args.url;
  return articleWorkflowSignedImageBlobUrl({ assetId, env: args.env, nowMs: args.nowMs });
}

/**
 * 出参正文：把代理地址换成签名地址，让页面里的 `<img>` 不带登录态也能取到图。
 *
 * 只改**响应**，库里那份始终是稳定地址（见 `articleWorkflowStableBodyHtml`）。
 * 地址写进 HTML 属性，所以 `&` 要转义成 `&amp;`：编辑器回传的正文要过一遍 XML 解析
 * （`assertArticleWorkflowHtmlFragment`），裸 `&` 会让整篇稿子解析失败、存不进去。
 */
export function articleWorkflowResponseBodyHtml(args: {
  readonly html: string;
  readonly env: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}): string {
  if (!args.html.includes(ARTICLE_WORKFLOW_IMAGE_BLOB_PREFIX)) return args.html;
  return args.html.replace(BLOB_URL_PATTERN, (_match, rawAssetId: string) => {
    let assetId: string;
    try {
      assetId = decodeURIComponent(rawAssetId);
    } catch {
      return _match;
    }
    const signed = articleWorkflowSignedImageBlobUrl({ assetId, env: args.env, nowMs: args.nowMs });
    return signed.replace(/&/g, "&amp;");
  });
}

/**
 * 落库正文：把签名地址还原成稳定地址。
 *
 * 编辑器保存时会把出参里的签名地址原样回传，直接存下去就是存了一批会过期的死链。
 * 兜底用：配图区通常会被 `applyArticleImageManifestToHtml` 按 manifest 整段重建，
 * 这里管的是重建没覆盖到的残留。
 */
export function articleWorkflowStableBodyHtml(html: string): string {
  if (!html.includes(ARTICLE_WORKFLOW_IMAGE_BLOB_PREFIX)) return html;
  return html.replace(BLOB_URL_PATTERN, (_match, rawAssetId: string) => {
    try {
      return articleWorkflowImageBlobUrl(decodeURIComponent(rawAssetId));
    } catch {
      return _match;
    }
  });
}
