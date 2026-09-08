export interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  dimension?: number;
}

export const BAILIAN_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-v4";
export const DEFAULT_EMBEDDING_DIMENSION = 1024;

const MAX_ERROR_BODY = 1000;

function configuredDimension(raw: string | undefined): number {
  const dimension = Number(raw ?? DEFAULT_EMBEDDING_DIMENSION);
  if (dimension !== DEFAULT_EMBEDDING_DIMENSION) {
    throw new Error(`EMBEDDING_DIM must be ${DEFAULT_EMBEDDING_DIMENSION}, got ${raw}`);
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
  const model = env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const dimension = configuredDimension(env.EMBEDDING_DIM);
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

export function validateEmbeddingVector(
  value: unknown,
  expectedDimension = DEFAULT_EMBEDDING_DIMENSION,
): number[] {
  if (
    !Array.isArray(value)
    || value.length !== expectedDimension
    || !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    const actual = Array.isArray(value) ? value.length : 0;
    throw new Error(`embeddings: expected ${expectedDimension} finite dimensions, got ${actual}`);
  }
  return value;
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
  signal?: AbortSignal,
): Promise<EmbedResult> {
  const expectedDimension = cfg.dimension ?? DEFAULT_EMBEDDING_DIMENSION;
  if (expectedDimension !== DEFAULT_EMBEDDING_DIMENSION) {
    throw new Error(`embeddings: dimension must be ${DEFAULT_EMBEDDING_DIMENSION}`);
  }

  const response = await fetchFn(embeddingEndpoint(cfg.baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      input,
      dimensions: expectedDimension,
      encoding_format: "float",
    }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, MAX_ERROR_BODY);
    throw new Error(`embeddings ${response.status}: ${detail}`);
  }

  const payload: unknown = await response.json();
  const first = typeof payload === "object" && payload !== null && "data" in payload
    && Array.isArray(payload.data)
    ? payload.data[0]
    : null;
  const vector = validateEmbeddingVector(
    typeof first === "object" && first !== null && "embedding" in first ? first.embedding : null,
    expectedDimension,
  );

  const usage = typeof payload === "object" && payload !== null && "usage" in payload
    && typeof payload.usage === "object" && payload.usage !== null
    ? payload.usage
    : null;
  const tokens = usage && "total_tokens" in usage && typeof usage.total_tokens === "number"
    && Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : 0;
  return { vector, tokens };
}

/** 只给等长的有限向量定义余弦；零向量仍按旧契约返回 0。 */
export function cosine(a: number[], b: number[]): number {
  if (
    a.length !== b.length
    || a.length === 0
    || !a.every(Number.isFinite)
    || !b.every(Number.isFinite)
  ) {
    throw new Error("cosine requires equal non-empty finite vectors");
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}
