import { createInflateRaw } from "node:zlib";

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
 * 读前闸：中央目录里的未压缩大小只是攻击者可填的声明值（报小、实际大就能绕），
 * 所以这里对每个条目**真的解压一遍、只数输出字节**（流式计数不留存），并交叉
 * 校验「中央目录声明 = 本地头声明 = 实际解压大小」。校验通过后 XLSX.read 再
 * 解压时规模已被证明有界。非 zip（如老式 .xls 的 CFB 容器）不走此闸，交给
 * XLSX.read 自己处理/报错；以 zip 签名开头却结构残缺的一律 fail-closed。
 */
async function countInflatedBytes(data: Buffer, budget: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    let total = 0;
    let settled = false;
    inflater.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > budget && !settled) {
        settled = true;
        inflater.destroy();
        reject(new PermanentDocumentError(
          `工作簿解压后大小超过上限（${MAX_WORKBOOK_UNCOMPRESSED_BYTES / 1024 / 1024} MB）`,
        ));
      }
    });
    inflater.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(total);
      }
    });
    inflater.on("error", (cause) => {
      if (!settled) {
        settled = true;
        reject(new PermanentDocumentError("工作簿压缩流损坏", { cause }));
      }
    });
    inflater.end(data);
  });
}

async function assertWorkbookZipBudget(buffer: Buffer): Promise<void> {
  if (buffer.byteLength < 4 || buffer.readUInt32LE(0) !== 0x0403_4b50) return; // 非 zip
  // EOCD 记录在文件尾部（最长 64KB 注释 + 22 字节定长），从尾部往前找签名。
  const tailStart = Math.max(0, buffer.byteLength - (65_557 + 22));
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= tailStart; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new PermanentDocumentError("工作簿压缩包结构损坏（缺少中央目录）");
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
  interface ZipEntry {
    readonly method: number;
    readonly flags: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly localOffset: number;
  }
  const entries: ZipEntry[] = [];
  let declaredTotal = 0;
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let entry = 0; entry < totalEntries; entry += 1) {
    if (cursor + 46 > cdEnd || cursor + 46 > buffer.byteLength || buffer.readUInt32LE(cursor) !== 0x0201_4b50) {
      throw new PermanentDocumentError("工作簿压缩包中央目录损坏");
    }
    const item: ZipEntry = {
      flags: buffer.readUInt16LE(cursor + 8),
      method: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localOffset: buffer.readUInt32LE(cursor + 42),
    };
    declaredTotal += item.uncompressedSize;
    if (declaredTotal > MAX_WORKBOOK_UNCOMPRESSED_BYTES) {
      throw new PermanentDocumentError(
        `工作簿解压后大小超过上限（${MAX_WORKBOOK_UNCOMPRESSED_BYTES / 1024 / 1024} MB）`,
      );
    }
    entries.push(item);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (cursor !== cdEnd) throw new PermanentDocumentError("工作簿压缩包中央目录损坏");
  // 声明值只能当快速筛子，最终以实际解压计数为准，并要求三处大小严格一致。
  let actualTotal = 0;
  for (const entry of entries) {
    const at = entry.localOffset;
    if (at + 30 > buffer.byteLength || buffer.readUInt32LE(at) !== 0x0403_4b50) {
      throw new PermanentDocumentError("工作簿压缩包本地头损坏");
    }
    // bit3（数据描述符）置位时本地头的大小字段按规范为 0，跳过本地交叉校验
    if ((entry.flags & 0x08) === 0) {
      const localCompressed = buffer.readUInt32LE(at + 18);
      const localUncompressed = buffer.readUInt32LE(at + 22);
      if (localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize) {
        throw new PermanentDocumentError("工作簿压缩包声明大小不一致");
      }
    }
    const dataStart = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
    const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    if (data.byteLength < entry.compressedSize) {
      throw new PermanentDocumentError("工作簿压缩包数据不完整");
    }
    let actual: number;
    if (entry.method === 0) {
      actual = data.byteLength;
    } else if (entry.method === 8) {
      actual = await countInflatedBytes(data, MAX_WORKBOOK_UNCOMPRESSED_BYTES - actualTotal);
    } else {
      throw new PermanentDocumentError(`工作簿压缩包使用了不支持的压缩方法（${entry.method}）`);
    }
    if (actual !== entry.uncompressedSize) {
      throw new PermanentDocumentError("工作簿压缩包声明大小与实际解压不一致");
    }
    actualTotal += actual;
  }
}

async function parseWorkbook(buffer: Buffer): Promise<string> {
  if (buffer.byteLength > MAX_WORKBOOK_BYTES) {
    throw new PermanentDocumentError(`工作簿大小超过上限（${MAX_WORKBOOK_BYTES / 1024 / 1024} MB）`);
  }
  await assertWorkbookZipBudget(buffer);
  const XLSX = await import("xlsx");  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
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
