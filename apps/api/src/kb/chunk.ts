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
  // 代码围栏内的 `# 注释` 不是标题：跟踪围栏状态，避免把代码当标题切分丢内容
  let inFence = false;
  const flush = (): void => {
    // 只去掉首尾空行：行首/行尾的空格与制表符可能有意义（TSV 首列为空），
    // 必须原样保留；用 trim() 仅做判空，不修改正文内容。
    const body = currentLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    if (body.trim() !== "" || currentHeading !== null) {
      sections.push({ heading: currentHeading, body });
    }
    currentLines = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      currentLines.push(line);
      continue;
    }
    const match = !inFence ? HEADING_PATTERN.exec(line.trimEnd()) : null;
    if (match) {
      flush();
      currentHeading = line.trim();
    } else {
      currentLines.push(line);
    }
  }
  flush();
  // 注意：这里不过滤空节，由调用方决定（计数需要保留空节，chunk 需要丢弃空节）
  return sections;
}

/** 去掉空节（只有标题没有正文），避免产生纯标题块。 */
function nonEmptySections(sections: readonly Section[]): Section[] {
  return sections.filter((section) => section.body.trim() !== "");
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
  const tableSectionCount = nonEmptySections(sections).filter(isTableSection).length;
  return {
    headingCount,
    tableSectionCount,
    strategy: headingCount > 0 ? "headings" : "plain",
  };
}

/**
 * 朴素字符窗口切分（UTF-16 code unit）。
 * 调用方保证输入已处理空白：整文档路径传入 trim 后的文本（与旧实现字节级一致）；
 * 节正文路径传入原始 body（内部有意义空白保留）。
 */
function chunkPlain(text: string, options: ChunkOpts): string[] {
  if (text === "") return [];

  const windowSize = options.maxTokens * APPROXIMATE_CHARS_PER_TOKEN;
  if (text.length <= windowSize) return [text];

  const overlap = options.overlapTokens * APPROXIMATE_CHARS_PER_TOKEN;
  const advance = Math.max(1, windowSize - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length && chunks.length < options.maxChunks; start += advance) {
    const candidate = text.slice(start, start + windowSize);
    if (candidate.trim() !== "") chunks.push(candidate);
  }
  return chunks;
}

/**
 * 标题感知切块：
 * - 按标题分节（代码围栏内的 `#` 不算标题），节内超长仍用字符窗口切；
 * - 每块前缀所属节标题，给检索补上下文；标题计入块预算，避免拼接后超窗；
 * - 无标题文档走 chunkPlain，与旧边界完全一致；纯标题文档返回空数组。
 *
 * 性能说明：describeTextStructure 与 chunkText 各做一次全量分节（O(n) 小常数，
 * 相对 embedding 网络耗时可忽略），刻意不做跨调用缓存以保持纯函数。
 */
export function chunkText(text: string, options: ChunkOpts): string[] {
  const input = text.trim();
  if (input === "") return [];

  const sections = nonEmptySections(splitSections(input));
  // 纯标题文档：空节已丢弃，无内容可切
  if (sections.length === 0) return [];
  const hasHeadings = sections.some((section) => section.heading !== null);
  // 无标题文档：input 已 trim，与旧实现逐字节一致
  if (!hasHeadings) return chunkPlain(input, options);

  const chunks: string[] = [];
  for (const section of sections) {
    const header = section.heading ? `${section.heading}\n` : "";
    // 标题计入预算：先按完整窗口切正文再拼标题会超窗
    const headerTokens = Math.ceil(header.length / APPROXIMATE_CHARS_PER_TOKEN);
    const bodyOptions: ChunkOpts = {
      ...options,
      maxTokens: Math.max(1, options.maxTokens - headerTokens),
    };
    const pieces = chunkPlain(section.body, bodyOptions);
    for (const piece of pieces) {
      if (chunks.length >= options.maxChunks) break;
      chunks.push(`${header}${piece}`);
    }
    if (chunks.length >= options.maxChunks) break;
  }
  return chunks;
}
