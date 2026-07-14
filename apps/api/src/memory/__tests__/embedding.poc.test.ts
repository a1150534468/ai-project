import { describe, it, expect } from "vitest";
import { embed, cosine, loadEmbeddingConfig } from "../embedding-client.js";

const hasEmbeddingEnv = !!(
  process.env.EMBEDDING_API_KEY
  || process.env.BAILIAN_API_KEY
  || process.env.DASHSCOPE_API_KEY
  || process.env.LLM_API_KEY
);
const shouldRunPoc = process.env.RUN_EMBEDDING_POC === "1" && hasEmbeddingEnv;

describe.runIf(shouldRunPoc)("P0 记忆命门: 当前配置的 embeddings provider", () => {
  it(
    "返回非空向量，维度与 EMBEDDING_DIM 一致，相关句相似度高于无关句",
    async () => {
      const cfg = loadEmbeddingConfig();
      const resA = await embed(cfg, "我喜欢用 TypeScript 写后端");
      const resB = await embed(cfg, "我偏好用 TS 做服务端开发"); // 相关
      const resC = await embed(cfg, "今天的天气很适合爬山"); // 无关
      const a = resA.vector;
      const b = resB.vector;
      const c = resC.vector;
      expect(a.length).toBeGreaterThan(0);
      if (process.env.EMBEDDING_DIM) {
        expect(a.length).toBe(Number(process.env.EMBEDDING_DIM));
      }
      console.log("EMBEDDING_DIM =", a.length);
      expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    },
    60_000,
  );
});
