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

describe("parseDocument 工作簿安全闸", () => {
  const sheetMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const buildWorkbook = async (sheets: unknown[][][], compression = false) => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    sheets.forEach((rows, index) => {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), `S${index + 1}`);
    });
    return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression }) as Buffer);
  };

  it("超过字节上限在解析前被拒", async () => {
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(parseDocument(oversized, sheetMime, "big.xlsx"))
      .rejects.toThrow("工作簿大小超过上限");
  });

  it("sheet 数超过上限被拒", async () => {
    const buffer = await buildWorkbook(Array.from({ length: 21 }, () => [["x"]]));
    await expect(parseDocument(buffer, sheetMime, "many.xlsx"))
      .rejects.toThrow("工作簿 sheet 数超过上限");
  });

  it("高压缩比工作簿（小文件、大展开）被单元格上限挡住，不展开成大对象", async () => {
    // 500 列 × 500 行 = 250_000 格重复短串：压缩后文件很小，展开后远超 200_000 上限
    const row = Array.from({ length: 500 }, () => "aaaaaaaaaaaaaaaaaaaa");
    const buffer = await buildWorkbook([Array.from({ length: 500 }, () => row)], true);
    expect(buffer.byteLength).toBeLessThan(2 * 1024 * 1024);
    await expect(parseDocument(buffer, sheetMime, "bomb.xlsx"))
      .rejects.toThrow("工作簿单元格数超过上限");
  });

  it("中央目录声明的解压后大小超限时在 XLSX.read 之前被拒（解压炸弹读前闸）", async () => {
    // 手工拼一个最小 zip：本地头 + 中央目录 + EOCD，中央目录把未压缩大小谎报为 150MB。
    // XLSX.read 若先跑会因结构不完整报别的错；断言命中读前闸的文案即证明闸在 read 之前。
    const name = Buffer.from("xl/worksheets/sheet1.xml");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x0201_4b50, 0);
    cd.writeUInt32LE(150 * 1024 * 1024, 24); // 未压缩大小
    cd.writeUInt16LE(name.length, 28);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x0605_4b50, 0);
    eocd.writeUInt16LE(1, 10); // 条目总数
    eocd.writeUInt32LE(cd.length + name.length, 12); // 中央目录大小
    eocd.writeUInt32LE(local.length + name.length, 16); // 中央目录偏移
    const bomb = Buffer.concat([local, name, cd, name, eocd]);
    await expect(parseDocument(bomb, sheetMime, "zipbomb.xlsx"))
      .rejects.toThrow("工作簿解压后大小超过上限");
  });

  it("声明大小造假（报小实际大）在读前闸被实际解压计数识破", async () => {
    // 本地头与中央目录一致地把未压缩大小谎报为 10，实际 deflate 流解开有 2MB：
    // 只信声明值的闸会放行，按实际输出计数并交叉校验的闸必须拒绝。
    const { deflateRawSync } = await import("node:zlib");
    const raw = Buffer.alloc(2 * 1024 * 1024, "a");
    const compressed = deflateRawSync(raw);
    const name = Buffer.from("xl/worksheets/sheet1.xml");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(8, 8); // 方法 deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(10, 22); // 谎报的未压缩大小
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x0201_4b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(10, 24); // 与本地头一致地谎报
    cd.writeUInt16LE(name.length, 28);
    const cdOffset = local.length + name.length + compressed.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x0605_4b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    const liar = Buffer.concat([local, name, compressed, cd, name, eocd]);
    await expect(parseDocument(liar, sheetMime, "liar.xlsx"))
      .rejects.toThrow("声明大小与实际解压不一致");
  });

  it("上限内的小工作簿仍能正常解析", async () => {
    const buffer = await buildWorkbook([[["名称", "值"], ["甲", "1"]]]);
    const out = await parseDocument(buffer, sheetMime, "ok.xlsx");
    expect(out).toContain("名称\t值");
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
