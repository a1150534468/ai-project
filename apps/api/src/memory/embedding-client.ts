export interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_EMBEDDING_MODEL = "Qwen/Qwen3-VL-Embedding-8B";

export function loadEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const baseURL = env.EMBEDDING_BASE_URL ?? env.LLM_BASE_URL;
  const apiKey = env.EMBEDDING_API_KEY ?? env.LLM_API_KEY;
  const model = env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  if (!baseURL) throw new Error("EMBEDDING_BASE_URL/LLM_BASE_URL required");
  if (!apiKey) throw new Error("EMBEDDING_API_KEY/LLM_API_KEY required");
  return { baseURL, apiKey, model };
}

// NewAPI 走 OpenAI embeddings 协议：POST {baseURL}/v1/embeddings
export interface EmbedResult {
  vector: number[];
  tokens: number;
}

export async function embed(
  cfg: EmbeddingConfig,
  input: string,
  fetchFn: typeof fetch = fetch,
): Promise<EmbedResult> {
  const r = await fetchFn(`${cfg.baseURL}/v1/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, input }),
  });
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as {
    data: { embedding: number[] }[];
    usage?: { total_tokens?: number };
  };
  const v = j.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length === 0) throw new Error("embeddings: empty vector");
  const tokens = j.usage?.total_tokens ?? 0;
  return { vector: v, tokens };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
