export interface ChunkOpts {
  maxTokens: number;
  overlapTokens: number;
  maxChunks: number;
}

const APPROXIMATE_CHARS_PER_TOKEN = 3;

/** markdown 标题行：`#`~`######` 后跟空格（刻意不用 \s：TSV 数据行如 `#\tA` 不是标题）。 */
const HEADING_PATTERN = /^(#{1,6}) +(\S.*)$/;
/** 围栏起始：3 个及以上的反引号或波浪号（info string 允许，如 ```sh） */
const FENCE_PATTERN = /^(`{3,}|~{3,})/;

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
  // 代码围栏跟踪：围栏内的 `# 注释` 不是标题。记录围栏字符与长度，
  // 闭合须同字符、长度不小于 opening、且整行只有围栏字符（info string 不算闭合）。
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  // 表格上下文：当前节正文已出现含 tab 的行。置于表格中的 `# X\t`
  // （行尾 tab 的手写极端情况）应视为数据行而非标题。
  // 注：parse.ts 的 rowText 会 pop 掉末尾空单元格，真实解析输出的行尾不可能有 tab。
  let inTable = false;
  const flush = (): void => {
    // 只去掉首尾空行：行首/行尾的空格与制表符可能有意义（TSV 首列/末列为空），
    // 必须原样保留；用 trim() 仅做判空，不修改正文内容。
    const body = currentLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    if (body.trim() !== "" || currentHeading !== null) {
      sections.push({ heading: currentHeading, body });
    }
    currentLines = [];
    inTable = false;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = FENCE_PATTERN.exec(trimmed);
    if (fenceMatch) {
      const seq = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceChar = seq[0];
        fenceLen = seq.length;
      } else {
        // 闭合：整行必须全是同种围栏字符（长度不小于 opening）+ 空白；
        // 混合字符（如 ```~~~）不算闭合，避免提前退出围栏。
        let i = 0;
        while (i < trimmed.length && trimmed[i] === fenceChar) i++;
        if (i >= fenceLen && trimmed.slice(i).trim() === "") {
          inFence = false;
          fenceChar = "";
          fenceLen = 0;
        }
      }
      currentLines.push(line);
      continue;
    }
    // 含制表符的行是 TSV 数据行，不是标题：XLSX 单元格内容可能以 `#` 开头
    //（如 `# A\t1`），误判为标题会导致整节被当成空节丢弃。
    // 判定顺序：围栏 > 行内 tab（trimEnd 后仍有 tab）> 表格上下文中的带 tab 行。
    // 正常标题末尾的 tab 属空白，trimEnd 后不影响识别。
    const trimmedEnd = line.trimEnd();
    let isHeading = false;
    if (!inFence && HEADING_PATTERN.test(trimmedEnd)) {
      if (!trimmedEnd.includes("\t") && !(inTable && line.includes("\t"))) {
        isHeading = true;
      }
    }
    if (isHeading) {
      flush();
      currentHeading = line.trim();
    } else {
      currentLines.push(line);
      // 只统计围栏外的正文行：代码块里的 tab（如 TSV 示例）不能污染表格上下文
      if (!inFence && line.includes("\t")) inTable = true;
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
  if (text.trim() === "") return { headingCount: 0, tableSectionCount: 0, strategy: "plain" };
  const sections = splitSections(text);
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
 * 表格节按行切分：整行入块，表格行不被拦腰切断（ADR-015 的承诺）。
 * 单行本身超长时该行内按字符硬切（极少数情况）。
 */
function chunkTableLines(
  body: string,
  header: string,
  bodyBudgetChars: number,
  maxChunks: number,
): string[] {
  const chunks: string[] = [];
  let currentLines: string[] = [];
  const pushChunk = (): void => {
    if (currentLines.length === 0 || chunks.length >= maxChunks) return;
    chunks.push(`${header}${currentLines.join("\n")}`);
    currentLines = [];
  };
  for (const line of body.split("\n")) {
    // 表格内空行无意义，跳过（避免产生只有换行的块）
    if (line.trim() === "") continue;
    if (line.length > bodyBudgetChars) {
      pushChunk();
      // 行内硬切：行已确认非空，切片即使全是空白（列分隔符）也有意义，不再 trim 过滤
      for (let start = 0; start < line.length && chunks.length < maxChunks; start += bodyBudgetChars) {
        chunks.push(`${header}${line.slice(start, start + bodyBudgetChars)}`);
      }
      continue;
    }
    const trial = currentLines.length === 0 ? line : `${currentLines.join("\n")}\n${line}`;
    if (trial.length > bodyBudgetChars) {
      pushChunk();
      if (chunks.length >= maxChunks) return chunks;
    }
    currentLines.push(line);
  }
  pushChunk();
  return chunks;
}

/**
 * 标题感知切块：
 * - 按标题分节（代码围栏内的 `#` 不算标题，支持 ``` / ~~~ 及不同长度围栏）；
 * - 每块前缀所属节标题，给检索补上下文；标题计入块预算，避免拼接后超窗；
 * - 表格节按行切分，行不被拦腰切断；
 * - 无标题文档走 chunkPlain（trim 后），与旧边界完全一致；
 * - 纯标题文档返回空数组；标题路径保留原始空白（TSV 空列的制表符）。
 *
 * 边界策略：标题占满预算时正文保留最小 1 token 窗口，块可能超窗（极端情况，
 * 调用方应保证标题长度合理）；overlap 不超过正文窗口 - 1，避免步长退化。
 */
export function chunkText(text: string, options: ChunkOpts): string[] {
  if (text.trim() === "") return [];

  const allSections = splitSections(text);
  // 标题存在性按未过滤节判断：「导语 + 纯标题」这种组合过滤后只剩导语，
  // 若按过滤后判断会误回退到旧路径，把已丢弃的标题带回来。
  const hasHeadings = allSections.some((section) => section.heading !== null);
  // 无标题文档：trim 后走旧路径，字节级一致
  if (!hasHeadings) return chunkPlain(text.trim(), options);

  const sections = nonEmptySections(allSections);
  // 纯标题文档：空节已丢弃，无内容可切
  if (sections.length === 0) return [];

  const chunks: string[] = [];
  for (const section of sections) {
    if (chunks.length >= options.maxChunks) break;
    const header = section.heading ? `${section.heading}\n` : "";
    const headerTokens = Math.ceil(header.length / APPROXIMATE_CHARS_PER_TOKEN);
    const bodyTokens = Math.max(1, options.maxTokens - headerTokens);
    const bodyOptions: ChunkOpts = {
      maxTokens: bodyTokens,
      overlapTokens: Math.min(options.overlapTokens, Math.max(0, bodyTokens - 1)),
      maxChunks: options.maxChunks - chunks.length,
    };
    const pieces = isTableSection(section)
      ? chunkTableLines(section.body, header, bodyTokens * APPROXIMATE_CHARS_PER_TOKEN, bodyOptions.maxChunks)
      : chunkPlain(section.body, bodyOptions).map((piece) => `${header}${piece}`);
    for (const piece of pieces) {
      if (chunks.length >= options.maxChunks) break;
      chunks.push(piece);
    }
  }
  return chunks;
}
