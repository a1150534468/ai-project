import { existsSync } from "node:fs";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { captureNovelStructuredSnapshot } from "./checkpoint-snapshot.js";

type ExportChapter = { readonly chapterIndex: number; readonly title: string; readonly content: string };
type ImportedChapter = ExportChapter;

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function paragraphLines(content: string): string[] {
  return content.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
}

export function parseNovelMarkdownImport(content: string): { title: string; chapters: ImportedChapter[] } {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const chapters: ImportedChapter[] = [];
  let title = "";
  let current: { chapterIndex: number; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    if (body) chapters.push({ chapterIndex: current.chapterIndex, title: current.title, content: body });
    current = null;
  };
  for (const line of lines) {
    const chapterHeading = line.match(/^#{1,4}\s*第\s*(\d+)\s*章\s*(.*)$/u) ?? line.match(/^#{1,4}\s*Chapter\s+(\d+)\s*[:：-]?\s*(.*)$/iu);
    if (chapterHeading) {
      flush();
      current = { chapterIndex: Number(chapterHeading[1]), title: chapterHeading[2]?.trim() || `第 ${chapterHeading[1]} 章`, lines: [] };
      continue;
    }
    const bookHeading = line.match(/^#\s+(.+)$/u);
    if (!current && !title && bookHeading) {
      title = bookHeading[1]!.trim();
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  if (!chapters.length) {
    const body = content.trim();
    if (body) chapters.push({ chapterIndex: 1, title: "导入章节", content: body });
  }
  return { title, chapters };
}

function markdown(title: string, chapters: readonly ExportChapter[]): Buffer {
  const body = [`# ${title}`, ...chapters.flatMap((chapter) => [`## 第 ${chapter.chapterIndex} 章 ${chapter.title}`, chapter.content.trim()])].join("\n\n");
  return Buffer.from(body, "utf8");
}

async function docx(title: string, chapters: readonly ExportChapter[]): Promise<Buffer> {
  const document = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
        ...chapters.flatMap((chapter) => [
          new Paragraph({ text: `第 ${chapter.chapterIndex} 章 ${chapter.title}`, heading: HeadingLevel.HEADING_1 }),
          ...paragraphLines(chapter.content).map((line) => new Paragraph({ text: line })),
        ]),
      ],
    }],
  });
  return Packer.toBuffer(document);
}

async function epub(title: string, chapters: readonly ExportChapter[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("OEBPS/style.css", "body{font-family:serif;line-height:1.8;margin:5%;}h1{page-break-before:always;}p{text-indent:2em;margin:.5em 0;}");
  const manifest: string[] = ["<item id=\"toc\" href=\"toc.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>", "<item id=\"style\" href=\"style.css\" media-type=\"text/css\"/>"];
  const spine: string[] = [];
  const nav: string[] = [];
  chapters.forEach((chapter, index) => {
    const id = `chapter-${index + 1}`;
    const file = `${id}.xhtml`;
    const heading = `第 ${chapter.chapterIndex} 章 ${chapter.title}`;
    manifest.push(`<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    nav.push(`<li><a href="${file}">${escapeXml(heading)}</a></li>`);
    zip.file(`OEBPS/${file}`, `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(heading)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h1>${escapeXml(heading)}</h1>${paragraphLines(chapter.content).map((line) => `<p>${escapeXml(line)}</p>`).join("")}</body></html>`);
  });
  zip.file("OEBPS/toc.xhtml", `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>目录</title></head><body><nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><h1>${escapeXml(title)}</h1><ol>${nav.join("")}</ol></nav></body></html>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">novel-${Date.now()}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>zh-CN</dc:language></metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

function cjkFontPath(): string | null {
  const candidates = [
    process.env.NOVEL_EXPORT_CJK_FONT,
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:\\Windows\\Fonts\\msyh.ttc",
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function pdf(title: string, chapters: readonly ExportChapter[]): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margins: { top: 54, bottom: 54, left: 58, right: 58 }, info: { Title: title } });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const font = cjkFontPath();
  if (font) document.font(font);
  document.fontSize(24).text(title, { align: "center" });
  for (const chapter of chapters) {
    document.addPage();
    document.fontSize(17).text(`第 ${chapter.chapterIndex} 章 ${chapter.title}`, { align: "center" });
    document.moveDown();
    document.fontSize(11);
    for (const line of paragraphLines(chapter.content)) {
      document.text(line, { lineGap: 7, paragraphGap: 6, indent: 22, align: "justify" });
    }
  }
  document.end();
  return new Promise((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
}

export const novelExportBuilders = {
  markdown,
  docx,
  epub,
  pdf,
};

const paramsSchema = z.object({ projectId: z.string().min(1) });
const querySchema = z.object({ format: z.enum(["markdown", "docx", "epub", "pdf"]).default("markdown") });
const importSchema = z.object({
  format: z.enum(["markdown", "text"]).default("markdown"),
  content: z.string().min(1).max(5_000_000),
  mode: z.enum(["replace", "append"]).default("replace"),
  filename: z.string().max(255).optional(),
});

export async function registerNovelExportRoutes(app: FastifyInstance, options: { prisma: PrismaClient }) {
  app.post("/api/workflow/novels/projects/:projectId/import", { bodyLimit: 6_000_000 }, async (req, reply) => {
    const userId = (req as { userId?: string }).userId ?? "";
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = paramsSchema.safeParse(req.params);
    const body = importSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await options.prisma.novelProject.findFirst({ where: { id: params.data.projectId, userId } });
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const activeRun = await options.prisma.novelRun.findFirst({ where: { projectId: project.id, status: { in: ["queued", "planning", "writing", "validating", "postprocessing", "awaitingReview", "paused", "failed"] } }, select: { id: true } });
    if (activeRun) return reply.code(409).send({ error: "请先停止当前小说运行，再导入章节" });
    const parsed = body.data.format === "markdown"
      ? parseNovelMarkdownImport(body.data.content)
      : { title: "", chapters: [{ chapterIndex: 1, title: body.data.filename?.replace(/\.[^.]+$/u, "") || "导入章节", content: body.data.content.trim() }] };
    if (!parsed.chapters.length) return reply.code(400).send({ error: "没有识别到可导入的章节" });
    const [existing, structured] = await Promise.all([
      options.prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" }, select: { chapterIndex: true, volumeIndex: true, title: true, summary: true, outline: true, generationHint: true, executionPlan: true, microBeats: true, content: true, rawContent: true, openThreads: true, contextSnapshot: true, generationMeta: true, consistencyJson: true, status: true, reviewStatus: true, reviewNotes: true, aiReview: true, aiActionItems: true, modificationRate: true, billableChars: true, tensionScore: true, plotTension: true, emotionalTension: true, pacingTension: true, qualityScore: true } }),
      captureNovelStructuredSnapshot(options.prisma, project.id),
    ]);
    const startIndex = body.data.mode === "append" ? (existing.at(-1)?.chapterIndex ?? 0) + 1 : 1;
    await options.prisma.$transaction(async (tx) => {
      const branchName = project.currentBranch || "main";
      await tx.novelCheckpoint.updateMany({ where: { projectId: project.id, branchName, isHead: true }, data: { isHead: false } });
      const parent = await tx.novelCheckpoint.findFirst({ where: { projectId: project.id, branchName }, orderBy: { createdAt: "desc" } });
      await tx.novelCheckpoint.create({
        data: {
          projectId: project.id,
          branchName,
          parentId: parent?.id ?? null,
          chapterNumber: existing.at(-1)?.chapterIndex ?? null,
          label: body.data.mode === "replace" ? "导入替换前" : "导入追加前",
          snapshot: { project: { title: project.title, genre: project.genre, premise: project.premise, settings: project.settings, generationPrefs: project.generationPrefs, narrativeContract: project.narrativeContract, storyPhase: project.storyPhase }, chapters: existing, structured },
          isHead: true,
        },
      });
      if (body.data.mode === "replace") await tx.novelChapter.deleteMany({ where: { projectId: project.id } });
      for (const [index, chapter] of parsed.chapters.entries()) {
        const chapterIndex = startIndex + index;
        const billableChars = Array.from(chapter.content.replace(/\s+/gu, "")).length;
        const saved = await tx.novelChapter.create({
          data: { projectId: project.id, chapterIndex, title: chapter.title || `第 ${chapterIndex} 章`, summary: "", outline: "", content: chapter.content, rawContent: chapter.content, status: "ready", reviewStatus: "pending", billableChars },
        });
        await tx.novelChapterVersion.create({ data: { chapterId: saved.id, title: saved.title, content: saved.content, billableChars } });
      }
      if (body.data.mode === "replace" && parsed.title) await tx.novelProject.update({ where: { id: project.id }, data: { title: parsed.title } });
    });
    return reply.code(201).send({ success: true, data: { importedChapters: parsed.chapters.length, mode: body.data.mode, title: parsed.title || project.title } });
  });

  app.get("/api/workflow/novels/projects/:projectId/export", async (req, reply) => {
    const userId = (req as { userId?: string }).userId ?? "";
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = paramsSchema.safeParse(req.params);
    const query = querySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await options.prisma.novelProject.findFirst({ where: { id: params.data.projectId, userId } });
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const chapters = await options.prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" }, select: { chapterIndex: true, title: true, content: true } });
    if (!chapters.length) return reply.code(400).send({ error: "当前作品还没有可导出的章节" });
    const format = query.data.format;
    const buffer = format === "markdown" ? markdown(project.title, chapters) : format === "docx" ? await docx(project.title, chapters) : format === "epub" ? await epub(project.title, chapters) : await pdf(project.title, chapters);
    const mime = { markdown: "text/markdown; charset=utf-8", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", epub: "application/epub+zip", pdf: "application/pdf" }[format];
    const filename = encodeURIComponent(`${project.title}.${format === "markdown" ? "md" : format}`);
    return reply.header("Content-Type", mime).header("Content-Disposition", `attachment; filename*=UTF-8''${filename}`).send(buffer);
  });
}
