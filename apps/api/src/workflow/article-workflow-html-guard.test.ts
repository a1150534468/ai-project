import { describe, expect, it } from "vitest";
import {
  assertArticleWorkflowBodyNotDestroyed,
  assertArticleWorkflowHtmlFragment,
  repairArticleWorkflowHtmlFragment,
} from "./article-workflow-html-guard.js";

describe("article-workflow html guard", () => {
  it("accepts wechat-safe fragment html", () => {
    const html = [
      '<section style="width:100%;max-width:667px;margin:0 auto;box-sizing:border-box;">',
      '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">开头第一段。</p>',
      '<section data-ai-assistant-image-slot="cover"></section>',
      '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">第二段继续说明。</p>',
      "</section>",
    ].join("");

    expect(assertArticleWorkflowHtmlFragment({
      html,
      expectedVisibleText: "开头第一段。\n第二段继续说明。",
      requiredImageSlots: ["cover"],
    })).toContain('data-ai-assistant-image-slot="cover"');
  });

  it("允许把整段正文重新分段：排版改的是节奏不是字", () => {
    // 回归：纯正文素材是一坨不分段的长文，排版提示词要求 paragraph rhythm，
    // 模型必然拆段。此前逐字比对含换行的可见文字，一个字没改也判不一致，整单失败。
    const html = [
      '<section style="margin:0;">',
      '<p style="margin:0 0 16px 0;">今天正式确认，定档 7 月 30 日。</p>',
      '<section data-ai-assistant-image-slot="cover"></section>',
      '<p style="margin:0 0 16px 0;">官方介绍显示，本次主要介绍技术架构。</p>',
      "</section>",
    ].join("");

    expect(assertArticleWorkflowHtmlFragment({
      html,
      expectedVisibleText: "今天正式确认，定档 7 月 30 日。官方介绍显示，本次主要介绍技术架构。",
      requiredImageSlots: ["cover"],
    })).toContain("定档 7 月 30 日");
  });

  it("重新分段可以，动字不行", () => {
    expect(() => assertArticleWorkflowHtmlFragment({
      html: '<p style="margin:0;">第一段。</p><p style="margin:0;">第二段。</p><p style="margin:0;">硬塞的第三段。</p>',
      expectedVisibleText: "第一段。第二段。",
    })).toThrow("可见文字与预期内容不一致");

    // 重排段落顺序同样会改变字符序列，仍然拦得住
    expect(() => assertArticleWorkflowHtmlFragment({
      html: '<p style="margin:0;">第二段。</p><p style="margin:0;">第一段。</p>',
      expectedVisibleText: "第一段。\n第二段。",
    })).toThrow("可见文字与预期内容不一致");
  });

  it("rejects blacklisted tags and changed visible text", () => {
    expect(() => assertArticleWorkflowHtmlFragment({
      html: "<script>alert(1)</script>",
      expectedVisibleText: "",
    })).toThrow("不支持的标签");

    expect(() => assertArticleWorkflowHtmlFragment({
      html: '<p style="font-size:16px;">改写后的正文</p>',
      expectedVisibleText: "原始正文",
    })).toThrow("可见文字与预期内容不一致");
  });
});

describe("assertArticleWorkflowBodyNotDestroyed", () => {
  const intact = [
    '<section style="margin:0;">',
    '<p style="font-size:16px;">第一段正文。</p>',
    '<section data-ai-assistant-image-slot="cover" style="margin:0 0 28px 0;">',
    '<img data-ai-assistant-image-slot="cover" src="https://example.com/a.png" alt="配图" style="display:block;width:100%;" />',
    "</section>",
    '<p style="font-size:16px;">第二段正文。</p>',
    "</section>",
  ].join("");

  it("放行正常编辑：改字、增删段落、动样式都不算销毁", () => {
    const edited = intact
      .replace("第一段正文。", "第一段正文改了几个字。")
      .replace('<p style="font-size:16px;">第二段正文。</p>', '<p style="font-size:18px;">第二段正文。</p><p>新增一段。</p>');
    expect(() => assertArticleWorkflowBodyNotDestroyed({ nextHtml: edited, currentHtml: intact })).not.toThrow();
  });

  it("拦住正文文字被整体清空", () => {
    // 实测形态：wangEditor 规范化后只剩一串空段落，自动保存把它写回库里。
    const emptied = '<p><br/></p>'.repeat(17);
    expect(() => assertArticleWorkflowBodyNotDestroyed({ nextHtml: emptied, currentHtml: intact }))
      .toThrow("正文文字会被整体清空");
  });

  it("拦住图片槽位全部丢失", () => {
    // 实测形态：文字留下了，但 section 和 data-* 全被拍平，槽位锚点没了。
    const flattened = '<p>第一段正文。第二段正文。</p>';
    expect(() => assertArticleWorkflowBodyNotDestroyed({ nextHtml: flattened, currentHtml: intact }))
      .toThrow("图片位置会全部丢失");
  });

  it("本来没有图片的文章不被图片规则挡住", () => {
    const noImages = '<section style="margin:0;"><p>只有文字。</p></section>';
    const edited = '<section style="margin:0;"><p>只有文字，改过。</p></section>';
    expect(() => assertArticleWorkflowBodyNotDestroyed({ nextHtml: edited, currentHtml: noImages })).not.toThrow();
  });

  it("旧正文本来就是空的，不阻止写入新内容", () => {
    // 已经被损坏的行要能被修复流程覆盖，guard 不能把它锁死。
    expect(() => assertArticleWorkflowBodyNotDestroyed({ nextHtml: intact, currentHtml: "" })).not.toThrow();
  });

  it("少了一个槽位不算销毁，只有全丢才拦", () => {
    const twoSlots = intact.replace(
      "</section>",
      '<section data-ai-assistant-image-slot="inline-1"></section></section>',
    );
    expect(() => assertArticleWorkflowBodyNotDestroyed({ nextHtml: intact, currentHtml: twoSlots })).not.toThrow();
  });
});

describe("repairArticleWorkflowHtmlFragment", () => {
  it("Markdown 标题排出来的 h2 是合法的，不该被修掉", () => {
    // 线上实测：素材有 `##`，排版模型给了 <h2>，而当时白名单里没有它，整行 failed。
    const html = '<section style="margin:0"><h2 style="font-size:20px">小标题</h2><p>正文。</p></section>';

    expect(repairArticleWorkflowHtmlFragment(html)).toContain("<h2");
    expect(() => assertArticleWorkflowHtmlFragment({
      html: repairArticleWorkflowHtmlFragment(html),
      expectedVisibleText: "小标题\n正文。",
    })).not.toThrow();
  });

  it("词汇表外的标签脱壳，可见文字一个不少", () => {
    const html = '<article><header><h2>标题</h2></header><p>正文。</p></article>';
    const repaired = repairArticleWorkflowHtmlFragment(html);

    expect(repaired).not.toContain("<article");
    expect(repaired).not.toContain("<header");
    expect(repaired).toContain("<h2");
    // 脱壳不动可见文字，所以硬校验照样能过
    expect(() => assertArticleWorkflowHtmlFragment({
      html: repaired,
      expectedVisibleText: "标题\n正文。",
    })).not.toThrow();
  });

  it("危险标签整块删掉，注释也摘掉", () => {
    const repaired = repairArticleWorkflowHtmlFragment(
      '<p>前</p><!-- 说明 --><script>alert(1)</script><style>p{color:red}</style><p>后</p>',
    );

    expect(repaired).not.toContain("script");
    expect(repaired).not.toContain("<style");
    expect(repaired).not.toContain("<!--");
    expect(repaired).toContain("前");
    expect(repaired).toContain("后");
  });

  it("越界属性和越界样式只摘掉那一条，合法样式留着", () => {
    const repaired = repairArticleWorkflowHtmlFragment(
      '<p class="x" onclick="alert(1)" style="position:absolute;margin:0 0 16px;height:200px;color:#333">文字</p>',
    );

    expect(repaired).not.toContain("class");
    expect(repaired).not.toContain("onclick");
    expect(repaired).not.toContain("position");
    expect(repaired).not.toContain("height");
    expect(repaired).toContain("margin:0 0 16px");
    expect(repaired).toContain("color:#333");
  });

  it("图片槽位原样保留：修复不能动承重属性", () => {
    const repaired = repairArticleWorkflowHtmlFragment(
      '<article><section data-ai-assistant-image-slot="cover"></section></article>',
    );

    expect(repaired).toContain('data-ai-assistant-image-slot="cover"');
    expect(repaired).toContain("<section");
  });

  it("修不动真正的问题：改写正文仍然失败", () => {
    // 这一层只做形状修复，不给内容改写放水
    const repaired = repairArticleWorkflowHtmlFragment("<p>模型自己改了文字。</p>");

    expect(() => assertArticleWorkflowHtmlFragment({
      html: repaired,
      expectedVisibleText: "原文是另一句话。",
    })).toThrow("HTML 可见文字与预期内容不一致");
  });

  it("已经合规的 HTML 修完不变形", () => {
    const html = '<section style="margin:0"><p style="margin:0 0 16px">正文。</p><section data-ai-assistant-image-slot="cover"></section></section>';

    expect(repairArticleWorkflowHtmlFragment(repairArticleWorkflowHtmlFragment(html)))
      .toBe(repairArticleWorkflowHtmlFragment(html));
  });
});
