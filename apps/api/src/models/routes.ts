/**
 * 可用模型目录。**数据源是配置，不是数据库。**
 *
 * 原来的模型目录整张表在 `ai_assistant_billing` 库里（每行带价格、VIP 等级、
 * 上架开关），`admin/model-routes.ts` 的八个 handler 全是代理那个 Go 服务。计费下线后
 * 那张表连库一起没了，所以模型列表改成从 env 读 —— 你已确认（2026-09-04）走这条，
 * 代价是「改模型要改配置 + 重启，不能在后台点」。
 *
 * 两条不能想当然的地方：
 *  - **`GET /api/models` 是公开端点**，未登录也要能拿到（登录页之后的首屏就要渲染模型下拉）。
 *    所以这里不做任何鉴权，也不要往返回值里放价格之类的东西。
 *  - **不配 `LLM_MODELS` 时必须仍然回一个非空列表**，否则前端下拉是空的、用户看起来像坏了。
 *    回落规则：默认模型（`loadLlmConfig().defaultModel`，即 `LLM_DEFAULT_MODEL` 或各 provider
 *    的内置默认）永远在第一位，后面接 ChatGPT 旁路那批 —— 但**只有旁路真的配了凭据时才接**，
 *    没配就是列出来也调不通。判据用 `cfg.modelRoutes`：`loadLlmConfig` 只在解析出凭据时才填它。
 */
import type { FastifyInstance } from "fastify";
import { loadLlmConfig, type LlmConfig } from "@ai-assistant/llm";

export interface ModelCatalogEntry {
  readonly model: string;
  readonly displayName: string;
}

/**
 * 解析 `LLM_MODELS`：逗号分隔，每项 `模型 id` 或 `模型 id:展示名`。
 * 展示名省略时就用模型 id 本身，不猜中文名。
 *
 * 模型 id 里可能带冒号（例如某些自建网关的 `ns:model` 形态），所以按**第一个**冒号切，
 * 不是 `split(":")` 取两段。
 */
export function parseModelCatalogEnv(raw: string | undefined): ModelCatalogEntry[] {
  if (!raw) return [];
  const entries: ModelCatalogEntry[] = [];
  for (const chunk of raw.split(",")) {
    const item = chunk.trim();
    if (!item) continue;
    const separator = item.lastIndexOf(":");
    const model = (separator > 0 ? item.slice(0, separator) : item).trim();
    const displayName = (separator > 0 ? item.slice(separator + 1) : "").trim();
    if (!model) continue;
    entries.push({ model, displayName: displayName || model });
  }
  return entries;
}

/** 按模型 id 去重，保留首次出现的位置与展示名。 */
function dedupeByModel(entries: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const out: ModelCatalogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.model)) continue;
    seen.add(entry.model);
    out.push(entry);
  }
  return out;
}

export function resolveModelCatalog(
  env: NodeJS.ProcessEnv = process.env,
  cfg: LlmConfig = loadLlmConfig(env),
): ModelCatalogEntry[] {
  const configured = parseModelCatalogEnv(env.LLM_MODELS);
  if (configured.length > 0) return dedupeByModel(configured);
  const fallback: ModelCatalogEntry[] = [{ model: cfg.defaultModel, displayName: cfg.defaultModel }];
  for (const route of cfg.modelRoutes ?? []) {
    fallback.push({ model: route.model, displayName: route.model });
  }
  return dedupeByModel(fallback);
}

export async function modelRoutes(app: FastifyInstance) {
  app.get("/api/models", async (_req, reply) => {
    return reply.send({ success: true, data: resolveModelCatalog() });
  });
}
