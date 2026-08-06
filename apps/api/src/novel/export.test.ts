import Fastify from "fastify";
import JSZip from "jszip";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { novelExportBuilders, parseNovelMarkdownImport, registerNovelExportRoutes } from "./export.js";

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

/**
 * P1.1 把导入/导出两个路由的内联 401 守卫换成了插件级 requireUser preHandler。
 * 本文件原先只测 builder，两个路由一次都没被测过 —— 守卫删掉没人知道。
 */
describe("novel export routes 鉴权", () => {
  async function appFor(userId: string) {
    const findFirst = vi.fn(async () => ({ id: "project-1", userId: "user-1" }));
    const prisma = { novelProject: { findFirst } } as unknown as PrismaClient;
    const app = Fastify();
    app.decorateRequest("userId", "");
    app.addHook("preHandler", async (request) => { request.userId = userId; });
    await registerNovelExportRoutes(app, { prisma });
    return { app, findFirst };
  }

  it("未登录时返回 401，且不碰数据库", async () => {
    const { app, findFirst } = await appFor("");
    for (const one of [
      { method: "GET" as const, url: "/api/workflow/novels/projects/project-1/export?format=markdown" },
      { method: "POST" as const, url: "/api/workflow/novels/projects/project-1/import" },
    ]) {
      const response = await app.inject(one);
      expect(response.statusCode, `${one.method} ${one.url}`).toBe(401);
      expect(response.json(), `${one.method} ${one.url}`).toEqual({ error: "未登录" });
    }
    expect(findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("已登录时放行到查库，不再被 401 挡住", async () => {
    const { app, findFirst } = await appFor("user-1");
    const response = await app.inject({ method: "GET", url: "/api/workflow/novels/projects/project-1/export?format=markdown" });
    expect(response.statusCode).not.toBe(401);
    expect(findFirst).toHaveBeenCalled();
    await app.close();
  });
});
