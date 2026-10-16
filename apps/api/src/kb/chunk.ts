export interface ChunkOpts {
  maxTokens: number;
  overlapTokens: number;
  maxChunks: number;
}

const APPROXIMATE_CHARS_PER_TOKEN = 3;

/** markdown 标题行：`#`~`######` 后跟空格。`#hashtag` 这类不算标题。 */
const HEADING_PATTERN = /^(#{1,6})\s+(\S.*)$/;

export type ChunkStrategy = "headings" | "plain";

export interface TextStructure {
  readonly headingCount: number;
  /** 以 `# ` 开头且后跟制表符分隔行的节（XLSX sheet / 表格）的数量 */
  readonly tableSectionCount: number;
  readonly strategy: ChunkStrategy;
}

interface Section {
  /** 标题行原文（如 `# 财务报表`），文档开头无标题的导语节为 null */
  readonly heading: string | null;
  readonly body: string;
}

function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];
  const flush = (): void => {
    const body = currentLines.join("\n").trim();
    if (body !== "" || currentHeading !== null) {
      sections.push({ heading: currentHeading, body });
    }
    currentLines = [];
  };
  for (const line of lines) {
    const match = HEADING_PATTERN.exec(line.trimEnd());
    if (match) {
      flush();
      currentHeading = line.trim();
    } else {
      currentLines.push(line);
    }
  }
  flush();
  // 空节（只有标题没有正文）丢弃，避免产生纯标题块
  return sections.filter((section) => section.body !== "");
}

function isTableSection(section: Section): boolean {
  if (!section.heading) return false;
  return section.body.split("\n").some((line) => line.includes("\t"));
}

/** 纯函数：描述文本结构，供质量追踪与策略选择。 */
export function describeTextStructure(text: string): TextStructure {
  const input = text.trim();
  if (input === "") return { headingCount: 0, tableSectionCount: 0, strategy: "plain" };
  const sections = splitSections(input);
  const headingCount = sections.filter((section) => section.heading !== null).length;
  const tableSectionCount = sections.filter(isTableSection).length;
  return {
    headingCount,
    tableSectionCount,
    strategy: headingCount > 0 ? "headings" : "plain",
  };
}

/**
 * 朴素字符窗口切分（UTF-16 code unit）。
 * 无标题文档的唯一路径：与旧实现字节级一致，保证这类文档的块边界不漂移。
 */
function chunkPlain(text: string, options: ChunkOpts): string[] {
  const input = text.trim();
  if (input === "") return [];

  const windowSize = options.maxTokens * APPROXIMATE_CHARS_PER_TOKEN;
  if (input.length <= windowSize) return [input];

  const overlap = options.overlapTokens * APPROXIMATE_CHARS_PER_TOKEN;
  const advance = Math.max(1, windowSize - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < input.length && chunks.length < options.maxChunks; start += advance) {
    const candidate = input.slice(start, start + windowSize);
    if (candidate.trim() !== "") chunks.push(candidate);
  }
  return chunks;
}

/**
 * 标题感知切块：
 * - 按标题分节，节内超长仍用字符窗口切（表格节/幻灯片节不再被拦腰切断）；
 * - 每块前缀所属节标题，给检索补上下文；
 * - 无标题文档走 chunkPlain，与旧边界完全一致。
 */
export function chunkText(text: string, options: ChunkOpts): string[] {
  const input = text.trim();
  if (input === "") return [];

  const sections = splitSections(input);
  const hasHeadings = sections.some((section) => section.heading !== null);
  if (!hasHeadings) return chunkPlain(input, options);

  const chunks: string[] = [];
  for (const section of sections) {
    const header = section.heading ? `${section.heading}\n` : "";
    const pieces = chunkPlain(section.body, options);
    for (const piece of pieces) {
      if (chunks.length >= options.maxChunks) break;
      chunks.push(`${header}${piece}`);
    }
    if (chunks.length >= options.maxChunks) break;
  }
  return chunks;
}
