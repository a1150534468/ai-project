import { describe, it, expect } from "vitest";
import { wrapReportHtml, BASE_CSS, SAFETY_SCRIPT, assembleSectionedBody } from "./report-shell.js";

describe("wrapReportHtml", () => {
  const fakeEcharts = "/*ECHARTS*/window.echarts={};";
  const fakeGsap = "/*GSAP*/window.gsap={};";

  it("产出完整 HTML 文档且以 doctype 开头", () => {
    const html = wrapReportHtml("<h1>报告</h1>", { echarts: fakeEcharts, gsap: fakeGsap });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  it("body 原样注入不被改写", () => {
    const body = `<div id="c1"></div><script>echarts.init(document.getElementById('c1')).setOption({})</script>`;
    const html = wrapReportHtml(body, { echarts: fakeEcharts, gsap: fakeGsap });
    expect(html).toContain(body);
  });

  it("内联 ECharts 与 GSAP 源", () => {
    const html = wrapReportHtml("<p>x</p>", { echarts: fakeEcharts, gsap: fakeGsap });
    expect(html).toContain(fakeEcharts);
    expect(html).toContain(fakeGsap);
  });

  it("含基础样式与动画工具类", () => {
    expect(BASE_CSS).toContain("@keyframes");
  });

  it("assembleSectionedBody 生成目录锚点+各分节，段内容原样、标题转义", () => {
    const out = assembleSectionedBody([
      { title: "转化数据", html: "<p>A</p>" },
      { title: "留存<b>", html: "<div>echarts</div>" },
    ]);
    expect(out).toContain('href="#rpt-sec-1"');
    expect(out).toContain('id="rpt-sec-1"');
    expect(out).toContain('id="rpt-sec-2"');
    expect(out).toContain("<p>A</p>"); // 段内容原样
    expect(out).toContain("转化数据");
    expect(out).toContain("留存&lt;b&gt;"); // 标题转义
    expect(BASE_CSS).toContain(".rpt-toc"); // 目录样式已就位
  });

  it("目录去碎片：同表 (1/N)…(N/N) 分段在目录只出现一次", () => {
    const out = assembleSectionedBody([
      { title: "ROI报表 (1/2)", html: "<p>1</p>" },
      { title: "ROI报表 (2/2)", html: "<p>2</p>" },
      { title: "留存报表", html: "<p>3</p>" },
    ]);
    // 目录只两个入口：ROI报表、留存报表（不是 3 个）
    expect((out.match(/rpt-toc-link/g) || []).length).toBe(2);
    expect(out).toContain(">ROI报表</a>"); // 合并后不带 (1/2) 后缀
    expect(out).not.toContain("ROI报表 (1/2)</a>");
    // 但三个 section 都在
    expect((out.match(/class="rpt-section/g) || []).length).toBe(3);
  });

  it("注入安全网脚本，兜住被摁成透明的内容不再空白", () => {
    const html = wrapReportHtml("<div class='reveal'>x</div>", { echarts: fakeEcharts, gsap: fakeGsap });
    expect(html).toContain(SAFETY_SCRIPT);
    // 安全网针对 .reveal 且强制 opacity important
    expect(SAFETY_SCRIPT).toContain(".reveal");
    expect(SAFETY_SCRIPT).toContain("important");
  });
});
