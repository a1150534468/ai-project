import { describe, expect, it } from "vitest";
import { chatModelErrorMessage, providerModelId } from "./routes.js";

describe("chatModelErrorMessage", () => {
  it("returns actionable Bailian credential and workspace errors", () => {
    expect(chatModelErrorMessage({ status: 401, code: "invalid_api_key" }, "bailian"))
      .toBe("百炼 API Key 无效或已失效");
    expect(chatModelErrorMessage({ code: "Model.AccessDenied" }, "bailian"))
      .toContain("Workspace ID、API Key 与模型权限");
  });

  it("distinguishes model catalog and connectivity failures", () => {
    expect(chatModelErrorMessage({ status: 404, message: "model not found" }, "bailian"))
      .toBe("百炼中不存在该模型或当前地域不可用");
    expect(chatModelErrorMessage({ cause: { code: "ECONNREFUSED" } }, "bailian"))
      .toBe("无法连接百炼，请检查接入地址与网络");
  });
});

describe("providerModelId", () => {
  it("maps legacy model casing only for Bailian", () => {
    expect(providerModelId("GLM-5.2", "bailian")).toBe("glm-5.2");
    expect(providerModelId("GLM-5.2", "anthropic")).toBe("GLM-5.2");
    expect(providerModelId("qwen3.7-plus", "bailian")).toBe("qwen3.7-plus");
  });
});
