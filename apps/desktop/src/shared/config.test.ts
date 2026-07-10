import { describe, it, expect } from "vitest";
import { defaultConfigForRuntime, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("无 env 给 dev 默认值", () => {
    const c = loadConfig({});
    expect(c.apiBase).toBe("http://localhost:8090");
    expect(c.wsUrl).toBe("ws://localhost:8090/ws/connector");
    expect(c.webUrl).toBe("http://localhost:5173");
  });
  it("env 覆盖且 https→wss", () => {
    const c = loadConfig({
      YC_API_BASE: "https://api.example.com",
      YC_WEB_URL: "https://app.example.com",
    });
    expect(c.apiBase).toBe("https://api.example.com");
    expect(c.wsUrl).toBe("wss://api.example.com/ws/connector");
    expect(c.webUrl).toBe("https://app.example.com");
  });
  it("打包态无 env 给生产默认值", () => {
    const c = loadConfig({}, defaultConfigForRuntime(true));
    expect(c.apiBase).toBe("https://api.example.com");
    expect(c.wsUrl).toBe("wss://api.example.com/ws/connector");
    expect(c.webUrl).toBe("https://app.example.com");
  });
  it("开发态无 env 保持本地默认值", () => {
    const c = loadConfig({}, defaultConfigForRuntime(false));
    expect(c.apiBase).toBe("http://localhost:8090");
    expect(c.wsUrl).toBe("ws://localhost:8090/ws/connector");
    expect(c.webUrl).toBe("http://localhost:5173");
  });
});
