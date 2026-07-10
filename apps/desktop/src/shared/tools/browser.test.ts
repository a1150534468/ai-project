import { afterEach, describe, expect, it } from "vitest";
import {
  __setBrowserAutomationForTest,
  browserClose,
  escapeHtml,
  failurePageUrl,
  isIgnorableLoadFailure,
  shouldRecoverFromRenderExit,
} from "./browser.js";

afterEach(() => {
  __setBrowserAutomationForTest(null);
});

describe("browserClose", () => {
  it("无浏览器窗口时安全返回 closed，不加载 electron、不创建窗口", async () => {
    // 主进程退出/关主窗口时会调用 browserClose；此时若尚未开过工具窗口，
    // 必须安全返回而不去 import electron 或新建窗口（否则在退出路径上反而拉起窗口）。
    // node 测试环境没有 electron，一旦触发 loadElectron 就会抛错。
    await expect(browserClose()).resolves.toBe("closed");
  });
});

describe("isIgnorableLoadFailure", () => {
  it("子框架失败忽略，不覆盖主窗口", () => {
    expect(isIgnorableLoadFailure(-105, "https://a.com", false)).toBe(true);
  });
  it("ERR_ABORTED(-3) 忽略：新导航打断旧导航属正常", () => {
    expect(isIgnorableLoadFailure(-3, "https://a.com", true)).toBe(true);
  });
  it("data: 页失败忽略，避免兜底页自身失败造成死循环", () => {
    expect(isIgnorableLoadFailure(-6, "data:text/html,x", true)).toBe(true);
  });
  it("主框架真实网络失败不忽略，需渲染错误页", () => {
    expect(isIgnorableLoadFailure(-105, "https://a.com", true)).toBe(false);
  });
});

describe("shouldRecoverFromRenderExit", () => {
  it("干净退出不重建（关窗/换页正常路径）", () => {
    expect(shouldRecoverFromRenderExit("clean-exit")).toBe(false);
  });
  it("崩溃/被杀需要重建错误页", () => {
    expect(shouldRecoverFromRenderExit("crashed")).toBe(true);
    expect(shouldRecoverFromRenderExit("oom")).toBe(true);
  });
});

describe("escapeHtml", () => {
  it("转义 & < > \" 防止破坏兜底页标记/注入", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;"
    );
  });
});

describe("failurePageUrl", () => {
  it("返回可渲染的 data:text/html，内含转义后的原因与 URL", () => {
    const url = failurePageUrl("ERR_NAME_NOT_RESOLVED (-105)", "https://x.com/<b>");
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    const html = decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));
    expect(html).toContain("网页加载失败");
    expect(html).toContain("ERR_NAME_NOT_RESOLVED (-105)");
    expect(html).toContain("https://x.com/&lt;b&gt;"); // URL 已转义，不破坏标记
  });
});
