export interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  dimension?: number;
}

export const BAILIAN_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-v4";
export const DEFAULT_EMBEDDING_DIMENSION = 1024;

function positiveDimension(raw: string | undefined): number {
  const dimension = Number(raw ?? DEFAULT_EMBEDDING_DIMENSION);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`EMBEDDING_DIM must be a positive integer, got ${raw}`);
  }
  return dimension;
}

export function loadEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const provider = env.LLM_PROVIDER?.trim().toLowerCase();
  const bailianLlm = provider === "bailian" || provider === "aliyun"
    || Boolean(env.BAILIAN_WORKSPACE_ID || env.BAILIAN_API_KEY || env.DASHSCOPE_API_KEY);
  const baseURL = env.EMBEDDING_BASE_URL?.trim()
    || (bailianLlm ? BAILIAN_EMBEDDING_BASE_URL : env.LLM_BASE_URL?.trim());
  const apiKey = env.EMBEDDING_API_KEY?.trim()
    || (bailianLlm
      ? (env.BAILIAN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim())
      : env.LLM_API_KEY?.trim());
  const model = env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const dimension = positiveDimension(env.EMBEDDING_DIM);
  if (!baseURL) {
    throw new Error("EMBEDDING_BASE_URL/LLM_BASE_URL required");
  }
  if (!apiKey) {
    throw new Error(bailianLlm
      ? "BAILIAN_API_KEY, DASHSCOPE_API_KEY or EMBEDDING_API_KEY required for Bailian embeddings"
      : "EMBEDDING_API_KEY/LLM_API_KEY required");
  }
  return { baseURL, apiKey, model, dimension };
}

export function embeddingEndpoint(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/embeddings` : `${normalized}/v1/embeddings`;
}

// OpenAI-compatible embeddings protocol.
export interface EmbedResult {
  vector: number[];
  tokens: number;
}

export async function embed(
  cfg: EmbeddingConfig,
  input: string,
  fetchFn: typeof fetch = fetch,
): Promise<EmbedResult> {
  const r = await fetchFn(embeddingEndpoint(cfg.baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      input,
      dimensions: cfg.dimension ?? DEFAULT_EMBEDDING_DIMENSION,
      encoding_format: "float",
    }),
  });
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as {
    data: { embedding: number[] }[];
    usage?: { total_tokens?: number };
  };
  const v = j.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length === 0) throw new Error("embeddings: empty vector");
  const expectedDimension = cfg.dimension ?? DEFAULT_EMBEDDING_DIMENSION;
  if (v.length !== expectedDimension) {
    throw new Error(`embeddings: expected ${expectedDimension} dimensions, got ${v.length}`);
  }
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
