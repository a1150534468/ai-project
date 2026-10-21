export class EmptyTextError extends Error {
  constructor(message = "未能提取文本（疑似扫描件，暂不支持 OCR）") {
    super(message);
    this.name = "EmptyTextError";
  }
}

export class PermanentDocumentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentDocumentError";
  }
}

type DocumentKind = "text" | "pdf" | "docx" | "sheet" | "slides";

const KIND_BY_EXTENSION = new Map<string, DocumentKind>([
  [".txt", "text"], [".md", "text"], [".markdown", "text"], [".json", "text"],
  [".xml", "text"], [".yaml", "text"], [".yml", "text"], [".csv", "text"], [".log", "text"],
  [".pdf", "pdf"], [".docx", "docx"], [".xlsx", "sheet"], [".xls", "sheet"], [".pptx", "slides"],
]);
const KIND_BY_MIME = new Map<string, DocumentKind>([
  ["text/plain", "text"], ["text/markdown", "text"], ["application/json", "text"],
  ["application/xml", "text"], ["text/xml", "text"], ["application/x-yaml", "text"],
  ["application/yaml", "text"], ["text/yaml", "text"], ["text/x-yaml", "text"], ["text/csv", "text"], ["text/x-log", "text"],
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet"],
  ["application/vnd.ms-excel", "sheet"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "slides"],
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

function mediaType(mime: string): string {
  return mime.split(";", 1)[0].trim().toLowerCase();
}

function documentKind(mime: string, filename: string): DocumentKind {
  const byExtension = KIND_BY_EXTENSION.get(extensionOf(filename));
  const normalized = mediaType(mime);
  const byMime = KIND_BY_MIME.get(normalized);
  if (byExtension && byMime && byExtension !== byMime) {
    throw new PermanentDocumentError(`文件扩展名与 MIME 不匹配：${mime} (${filename})`);
  }
  const kind = byExtension ?? byMime;
  if (!kind) throw new PermanentDocumentError(`不支持的文件类型：${mime} (${filename})`);
  return kind;
}

function nonEmpty(text: string): string {
  const result = text.trim();
  if (!result) throw new EmptyTextError();
  return result;
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (cause) {
    throw new PermanentDocumentError("文本不是合法的 UTF-8", { cause });
  }
}

function cellText(cell: unknown): string {
  return cell instanceof Date ? cell.toISOString() : String(cell ?? "").trim();
}

function rowText(row: readonly unknown[]): string {
  const cells = row.map(cellText);
  while (cells.at(-1) === "") cells.pop();
  return cells.join("\t");
}

/** 工作簿解析的安全闸：xlsx 是 zip 容器，解压比不受限，必须先卡住展开规模。 */
export const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;
export const MAX_WORKBOOK_SHEETS = 20;
export const MAX_WORKBOOK_CELLS = 200_000;
export const MAX_WORKBOOK_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_WORKBOOK_ZIP_ENTRIES = 2000;

/**
 * 读前闸：只看 zip 中央目录里声明的条目数与未压缩总大小，不解压、不展开。
 * XLSX.read 本身就会把整个工作簿物化成 JS 对象，sheet/单元格检查都在它之后，
 * 挡不住高压缩比的解压炸弹 —— 必须在 read 之前先按中央目录把规模卡死。
 * 不是 zip（老式 .xls 等）时返回 false，交给 XLSX.read 自己处理/报错。
 */
function assertWorkbookZipBudget(buffer: Buffer): void {
  // EOCD 记录在文件尾部（最长 64KB 注释 + 22 字节定长），从尾部往前找签名。
  const tailStart = Math.max(0, buffer.byteLength - (65_557 + 22));
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= tailStart; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return;
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64 哨兵值：规模已超出普通字段表达范围，直接按超限处理（fail-closed）。
  if (totalEntries === 0xffff || cdSize === 0xffff_ffff || cdOffset === 0xffff_ffff) {
    throw new PermanentDocumentError("工作簿压缩包规模超过上限（ZIP64）");
  }
  if (totalEntries > MAX_WORKBOOK_ZIP_ENTRIES) {
    throw new PermanentDocumentError(`工作簿压缩包条目数超过上限（${MAX_WORKBOOK_ZIP_ENTRIES}）`);
  }
  let totalUncompressed = 0;
  let cursor = cdOffset;
  for (let entry = 0; entry < totalEntries; entry += 1) {
    if (cursor + 46 > buffer.byteLength || buffer.readUInt32LE(cursor) !== 0x0201_4b50) {
      throw new PermanentDocumentError("工作簿压缩包中央目录损坏");
    }
    totalUncompressed += buffer.readUInt32LE(cursor + 24);
    if (totalUncompressed > MAX_WORKBOOK_UNCOMPRESSED_BYTES) {
      throw new PermanentDocumentError(
        `工作簿解压后大小超过上限（${MAX_WORKBOOK_UNCOMPRESSED_BYTES / 1024 / 1024} MB）`,
      );
    }
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
}

async function parseWorkbook(buffer: Buffer): Promise<string> {
  if (buffer.byteLength > MAX_WORKBOOK_BYTES) {
    throw new PermanentDocumentError(`工作簿大小超过上限（${MAX_WORKBOOK_BYTES / 1024 / 1024} MB）`);
  }
  assertWorkbookZipBudget(buffer);
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  if (workbook.SheetNames.length > MAX_WORKBOOK_SHEETS) {
    throw new PermanentDocumentError(`工作簿 sheet 数超过上限（${MAX_WORKBOOK_SHEETS}）`);
  }
  // 先按 !ref 包围盒估算总单元格数再展开：sheet_to_json 的内存占用大致随包围盒走，
  // 超限时在转换前就拒绝，高压缩比工作簿（小文件、大展开）也走这条路被挡住。
  let totalCells = 0;
  for (const name of workbook.SheetNames) {
    const ref = workbook.Sheets[name]?.["!ref"];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    totalCells += (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    if (totalCells > MAX_WORKBOOK_CELLS) {
      throw new PermanentDocumentError(`工作簿单元格数超过上限（${MAX_WORKBOOK_CELLS}）`);
    }
  }
  const sections: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" });
    const lines = rows.map(rowText).filter((line) => line.replace(/\t/g, "") !== "");
    if (lines.length > 0) sections.push([`# ${name}`, ...lines].join("\n"));
  }
  return nonEmpty(sections.join("\n\n"));
}

type RelationshipMap = Map<string, string>;

function slideNumber(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

async function presentationOrder(zip: import("jszip")): Promise<string[]> {
  const presentation = zip.file("ppt/presentation.xml");
  const relationships = zip.file("ppt/_rels/presentation.xml.rels");
  if (!presentation || !relationships) {
    return Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      .sort((left, right) => slideNumber(left) - slideNumber(right));
  }

  const { DOMParser } = await import("@xmldom/xmldom");
  const parser = new DOMParser();
  const relDoc = parser.parseFromString(await relationships.async("text"), "application/xml");
  const targets: RelationshipMap = new Map();
  const relationshipNodes = Array.from(relDoc.getElementsByTagNameNS("*", "Relationship"));
  for (const node of relationshipNodes) {
    const id = node.getAttribute("Id");
    const target = node.getAttribute("Target");
    if (id && target) targets.set(id, target.replace(/^\.\.\//, "ppt/").replace(/^(?!ppt\/)/, "ppt/"));
  }
  const presentationDoc = parser.parseFromString(await presentation.async("text"), "application/xml");
  const slideIds = Array.from(presentationDoc.getElementsByTagNameNS("*", "sldId"));
  const ordered = slideIds
    .map((node) => targets.get(node.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
      ?? node.getAttribute("r:id")
      ?? ""))
    .filter((path): path is string => Boolean(path && zip.file(path)));
  return ordered.length === slideIds.length && ordered.length > 0
    ? ordered
    : Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      .sort((left, right) => slideNumber(left) - slideNumber(right));
}

async function parseSlides(buffer: Buffer): Promise<string> {
  const [{ default: JSZip }, { DOMParser }] = await Promise.all([import("jszip"), import("@xmldom/xmldom")]);
  const zip = await JSZip.loadAsync(buffer);
  const parser = new DOMParser();
  const paths = await presentationOrder(zip);
  const slides = await Promise.all(paths.map(async (path, index) => {
    const xml = await zip.file(path)?.async("text");
    if (!xml) return "";
    const document = parser.parseFromString(xml, "application/xml");
    const lines = Array.from(document.getElementsByTagName("a:t"))
      .map((node) => node.textContent?.trim() ?? "").filter(Boolean);
    return lines.length === 0 ? "" : [`# Slide ${index + 1}`, ...lines].join("\n");
  }));
  return nonEmpty(slides.filter(Boolean).join("\n\n"));
}

/** 所有解析结果统一 trim；动态模块加载故障保持原异常，不伪装成用户文件错误。 */
export async function parseDocument(buffer: Buffer, mime: string, filename: string): Promise<string> {
  const kind = documentKind(mime, filename);
  if (kind === "text") return nonEmpty(decodeUtf8(buffer));

  if (kind === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      return nonEmpty((await parser.getText()).text ?? "");
    } finally {
      await parser.destroy();
    }
  }

  if (kind === "docx") {
    const mammoth = (await import("mammoth")).default;
    return nonEmpty((await mammoth.extractRawText({ buffer })).value ?? "");
  }

  if (kind === "sheet") return parseWorkbook(buffer);
  return parseSlides(buffer);
}
