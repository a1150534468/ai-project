import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { novelExportBuilders, parseNovelMarkdownImport } from "./export.js";

const chapters = [{ chapterIndex: 1, title: "初见", content: "第一段。\n\n第二段。" }];

describe("novel exports", () => {
  it("round-trips exported markdown into ordered chapters", () => {
    const source = novelExportBuilders.markdown("长夜", [
      ...chapters,
      { chapterIndex: 2, title: "追踪", content: "第三段。" },
    ]).toString("utf8");
    const parsed = parseNovelMarkdownImport(source);
    expect(parsed.title).toBe("长夜");
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(["初见", "追踪"]);
    expect(parsed.chapters[1]?.content).toBe("第三段。");
  });
  it("builds markdown with book and chapter headings", () => {
    const output = novelExportBuilders.markdown("长夜", chapters).toString("utf8");
    expect(output).toContain("# 长夜");
    expect(output).toContain("## 第 1 章 初见");
    expect(output).toContain("第一段。");
  });

  it("builds a valid DOCX archive", async () => {
    const output = await novelExportBuilders.docx("长夜", chapters);
    expect(output.subarray(0, 2).toString()).toBe("PK");
    const zip = await JSZip.loadAsync(output);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain("长夜");
    expect(documentXml).toContain("第一段。");
  });

  it("builds an EPUB 3 archive with navigation", async () => {
    const output = await novelExportBuilders.epub("长夜", chapters);
    const zip = await JSZip.loadAsync(output);
    expect(await zip.file("mimetype")!.async("string")).toBe("application/epub+zip");
    expect(await zip.file("OEBPS/toc.xhtml")!.async("string")).toContain("chapter-1.xhtml");
    expect(await zip.file("OEBPS/chapter-1.xhtml")!.async("string")).toContain("第一段。");
  });

  it("builds a PDF document", async () => {
    const output = await novelExportBuilders.pdf("Novel", [{ chapterIndex: 1, title: "Opening", content: "First paragraph." }]);
    expect(output.subarray(0, 5).toString()).toBe("%PDF-");
    expect(output.length).toBeGreaterThan(500);
  });
});
