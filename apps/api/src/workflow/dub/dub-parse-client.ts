export interface ParseConfig {
  baseUrl: string;
  clientId: string;
  secretKey: string;
}

export interface ParsedShare {
  kind: "video" | "image";
  desc: string;
  cover: string;
  playAddr: string;
}

export function loadParseConfig(env: NodeJS.ProcessEnv = process.env): ParseConfig {
  const clientId = env.DUB_PARSE_CLIENT_ID?.trim();
  const secretKey = env.DUB_PARSE_SECRET_KEY?.trim();
  if (!clientId || !secretKey) throw new Error("DUB_PARSE_CLIENT_ID/DUB_PARSE_SECRET_KEY required");
  const baseUrl = (env.DUB_PARSE_BASE_URL?.trim() || "http://apis.ppt6.top").replace(/\/+$/u, "");
  return { baseUrl, clientId, secretKey };
}

export async function parseShareUrl(
  cfg: ParseConfig,
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<ParsedShare> {
  const q = new URLSearchParams({ clientId: cfg.clientId, clientSecretKey: cfg.secretKey, url });
  const res = await fetchFn(`${cfg.baseUrl}?${q.toString()}`, { method: "GET" });
  if (!res.ok) throw new Error(`解析服务响应异常：HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string | number; msg?: string; data?: Record<string, unknown> };
  // ppt6 直连成功信封：code=200（数字）/ msg="解析成功"；data 里 video_url 为无水印直链。
  if (String(body.code) !== "200" || !body.data) throw new Error(body.msg?.trim() || "解析失败，不支持该链接");
  const d = body.data;
  const kind = String(d.type) === "2" ? "image" : "video";
  return {
    kind,
    desc: String(d.desc ?? ""),
    cover: String(d.cover ?? ""),
    // 优先无水印 video_url，兜底 video（带水印播放地址）
    playAddr: String(d.video_url ?? d.video ?? d.playAddr ?? ""),
  };
}
