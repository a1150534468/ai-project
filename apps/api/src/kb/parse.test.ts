import { describe, expect, it } from "vitest";
import { EmptyTextError, PermanentDocumentError, parseDocument } from "./parse.js";

const parse = (text: string, mime = "text/plain", name = "a.txt") => parseDocument(Buffer.from(text), mime, name);

describe("parseDocument 文本边界", () => {
  it.each([
    ["text/plain", "a.txt"],
    ["TEXT/MARKDOWN; charset=UTF-8", "download"],
    ["application/json; charset=utf-8", "download"],
    ["application/xml", "a.xml"],
    ["application/octet-stream", "a.yaml"],
  ])("按 MIME/扩展名识别 UTF-8 文本：%s %s", async (mime, name) => {
    await expect(parse("  hello 世界  ", mime, name)).resolves.toBe("hello 世界");
  });

  it("空文本抛唯一的 EmptyTextError", async () => {
    await expect(parse("   ")).rejects.toBeInstanceOf(EmptyTextError);
  });

  it("畸形 UTF-8 和二进制扩展名/text MIME 冲突是永久输入错误", async () => {
    await expect(parseDocument(Buffer.from([0xc3, 0x28]), "text/plain", "a.txt"))
      .rejects.toBeInstanceOf(PermanentDocumentError);
    await expect(parse("%PDF", "text/plain", "a.pdf"))
      .rejects.toThrow("扩展名与 MIME 不匹配");
  });

  it("不支持类型保留既有错误消息", async () => {
    await expect(parse("data", "application/octet-stream", "a.bin"))
      .rejects.toThrow("不支持的文件类型：application/octet-stream (a.bin)");
  });
});

describe("parseDocument Office", () => {
  it("XLSX 保留稀疏列坐标与日期", async () => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["A", "", "C"],
      [new Date("2026-01-02T03:04:05.000Z"), "", ""],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "订单");
    const out = await parseDocument(
      Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "orders.xlsx",
    );
    expect(out).toContain("# 订单");
    expect(out).toContain("A\t\tC");
    expect(out).toContain("2026-01-02T03:04:05.000Z");
  });

  it("PPTX 按 presentation relationship 顺序而不是文件名顺序", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const slide = (text: string) => `<p:sld xmlns:p="p" xmlns:a="a"><a:t>${text}</a:t></p:sld>`;
    zip.file("ppt/slides/slide1.xml", slide("第一份文件"));
    zip.file("ppt/slides/slide2.xml", slide("先播放"));
    zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>`);
    zip.file("ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>`);
    const out = await parseDocument(
      await zip.generateAsync({ type: "nodebuffer" }),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "deck.pptx",
    );
    expect(out).toBe("# Slide 1\n先播放\n\n# Slide 2\n第一份文件");
  });

  it("PPTX 缺演示关系时回落到数字文件顺序", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("ppt/slides/slide2.xml", `<a:t xmlns:a="a">二</a:t>`);
    zip.file("ppt/slides/slide1.xml", `<a:t xmlns:a="a">一</a:t>`);
    const out = await parseDocument(
      await zip.generateAsync({ type: "nodebuffer" }),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "deck.pptx",
    );
    expect(out).toBe("# Slide 1\n一\n\n# Slide 2\n二");
  });
});
