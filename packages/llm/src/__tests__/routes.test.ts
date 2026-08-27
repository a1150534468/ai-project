import { describe, expect, it } from "vitest";
import { CHATGPT_MODELS } from "../client.js";
import {
  LlmRouteError,
  parseChatgptModelList,
  resolveBailianCredentials,
  resolveChatgptCredentials,
} from "../routes.js";

describe("parseChatgptModelList", () => {
  it("解析 env 列表并去空白", () => {
    expect(parseChatgptModelList({ CHATGPT_MODELS: " gpt-5.6-sol , gpt-5.5 ,, " } as NodeJS.ProcessEnv))
      .toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("未配置时回退内置名单", () => {
    expect(parseChatgptModelList({} as NodeJS.ProcessEnv)).toContain("gpt-5.6-sol");
    expect(parseChatgptModelList({} as NodeJS.ProcessEnv)).toEqual([...CHATGPT_MODELS]);
  });

  it("配置存在但全是空项时同样回退内置名单", () => {
    expect(parseChatgptModelList({ CHATGPT_MODELS: " , ,, " } as NodeJS.ProcessEnv)).toEqual([...CHATGPT_MODELS]);
  });
});

describe("resolveChatgptCredentials", () => {
  it("CHATGPT_API_KEY 优先，缺省 baseURL 用默认端点", () => {
    expect(resolveChatgptCredentials({ CHATGPT_API_KEY: "k1", GPT_IMAGE_API_KEY: "k2" } as NodeJS.ProcessEnv))
      .toEqual({ baseURL: "https://api.ai-pixel.online", apiKey: "k1" });
  });

  it("CHATGPT_API_KEY 为空白时回退 GPT_IMAGE_API_KEY，并接受 CHATGPT_BASE_URL 覆盖", () => {
    expect(resolveChatgptCredentials({
      CHATGPT_API_KEY: "   ",
      GPT_IMAGE_API_KEY: " k2 ",
      CHATGPT_BASE_URL: " https://pixel.test ",
    } as NodeJS.ProcessEnv)).toEqual({ baseURL: "https://pixel.test", apiKey: "k2" });
  });

  it("两个 key 都缺时抛 LlmRouteError，并带可映射的 code", () => {
    expect(() => resolveChatgptCredentials({} as NodeJS.ProcessEnv)).toThrow(LlmRouteError);
    // codex-pet 的合同错误消息断言了这个短语，收敛后必须仍然包含。
    expect(() => resolveChatgptCredentials({} as NodeJS.ProcessEnv)).toThrow("CHATGPT_API_KEY or GPT_IMAGE_API_KEY");
    try {
      resolveChatgptCredentials({ CHATGPT_API_KEY: " " } as NodeJS.ProcessEnv);
      expect.unreachable("应当抛出 LlmRouteError");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmRouteError);
      expect((error as LlmRouteError).code).toBe("chatgpt_api_key_missing");
    }
  });
});

describe("resolveBailianCredentials", () => {
  it("BAILIAN_BASE_URL 缺省时由 workspace 拼接", () => {
    expect(resolveBailianCredentials({ BAILIAN_API_KEY: "bk", BAILIAN_WORKSPACE_ID: "ws1" } as NodeJS.ProcessEnv))
      .toEqual({ baseURL: "https://ws1.cn-beijing.maas.aliyuncs.com/apps/anthropic", apiKey: "bk" });
  });

  it("显式 BAILIAN_BASE_URL 优先于 workspace 拼接，DASHSCOPE_API_KEY 作为 key 回退", () => {
    expect(resolveBailianCredentials({
      BAILIAN_BASE_URL: " https://bailian.test/apps/anthropic ",
      BAILIAN_WORKSPACE_ID: "ws1",
      DASHSCOPE_API_KEY: " dk ",
    } as NodeJS.ProcessEnv)).toEqual({ baseURL: "https://bailian.test/apps/anthropic", apiKey: "dk" });
  });

  it("支持显式 region", () => {
    expect(resolveBailianCredentials({
      BAILIAN_API_KEY: "bk",
      BAILIAN_WORKSPACE_ID: "ws1",
      BAILIAN_REGION: "ap-southeast-1",
    } as NodeJS.ProcessEnv).baseURL).toBe("https://ws1.ap-southeast-1.maas.aliyuncs.com/apps/anthropic");
  });

  it("key 缺失抛 LlmRouteError", () => {
    expect(() => resolveBailianCredentials({ BAILIAN_WORKSPACE_ID: "ws1" } as NodeJS.ProcessEnv)).toThrow(LlmRouteError);
    expect(() => resolveBailianCredentials({ BAILIAN_WORKSPACE_ID: "ws1" } as NodeJS.ProcessEnv))
      .toThrow("BAILIAN_API_KEY or DASHSCOPE_API_KEY");
  });

  it("端点与 key 都缺时先报端点——与两个现存调用点的判定顺序一致", () => {
    try {
      resolveBailianCredentials({} as NodeJS.ProcessEnv);
      expect.unreachable("应当抛出 LlmRouteError");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmRouteError);
      expect((error as LlmRouteError).code).toBe("bailian_base_url_missing");
      expect((error as Error).message).toContain("BAILIAN_WORKSPACE_ID or BAILIAN_BASE_URL");
    }
    // 只有空白的 workspace 等同于没配。
    expect(() => resolveBailianCredentials({ BAILIAN_WORKSPACE_ID: "   ", BAILIAN_API_KEY: "bk" } as NodeJS.ProcessEnv))
      .toThrow("BAILIAN_WORKSPACE_ID or BAILIAN_BASE_URL");
  });

  it("显式空 region 沿用 buildBailianBaseURL 的普通 Error，不伪装成路由错误", () => {
    expect(() => resolveBailianCredentials({
      BAILIAN_API_KEY: "bk",
      BAILIAN_WORKSPACE_ID: "ws1",
      BAILIAN_REGION: "",
    } as NodeJS.ProcessEnv)).toThrow("BAILIAN_REGION is required");
    expect(() => resolveBailianCredentials({
      BAILIAN_API_KEY: "bk",
      BAILIAN_WORKSPACE_ID: "ws1",
      BAILIAN_REGION: "",
    } as NodeJS.ProcessEnv)).not.toThrow(LlmRouteError);
  });
});
