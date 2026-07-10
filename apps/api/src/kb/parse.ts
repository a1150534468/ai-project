export class EmptyTextError extends Error {
  constructor(message: string = '未能提取文本（疑似扫描件，暂不支持 OCR）') {
    super(message);
    this.name = 'EmptyTextError';
  }
}

/** MIME 类型到文件扩展名的映射（用于双重验证） */
const MIME_TO_EXT: Record<string, string> = {
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'application/x-yaml': '.yaml',
  'text/yaml': '.yaml',
  'text/csv': '.csv',
  'text/x-log': '.log',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

/**
 * 获取文件扩展名（小写）。
 */
function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i).toLowerCase() : '';
}

/**
 * 根据 MIME 类型或文件扩展名判断是否为纯文本文件。
 */
function isTextFile(mime: string, filename: string): boolean {
  const ext = extOf(filename);

  // 白名单：支持的纯文本类型
  const textMimes = new Set([
    'text/plain',
    'text/markdown',
    'application/json',
    'application/xml',
    'text/xml',
    'application/x-yaml',
    'text/yaml',
    'text/csv',
    'text/x-log',
  ]);

  const textExts = new Set(['.txt', '.md', '.markdown', '.json', '.xml', '.yaml', '.yml', '.csv', '.log']);

  return textMimes.has(mime) || textExts.has(ext);
}

/**
 * 解析文档到纯文本。
 * 支持：txt、md、json、xml、yaml、csv、log（UTF-8）、pdf、docx、xlsx、xls、pptx。
 * 解析结果为空 => EmptyTextError。
 * 不支持的类型 => Error。
 */
export async function parseDocument(
  buf: Buffer,
  mime: string,
  filename: string,
): Promise<string> {
  const ext = extOf(filename);

  // 纯文本文件：直接 UTF-8 解码
  if (isTextFile(mime, filename)) {
    const text = buf.toString('utf8').trim();
    if (!text) {
      throw new EmptyTextError();
    }
    return text;
  }

  // PDF
  if (ext === '.pdf' || mime === 'application/pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      const text = (result.text ?? '').trim();
      if (!text) {
        throw new EmptyTextError();
      }
      return text;
    } finally {
      await parser.destroy();
    }
  }

  // DOCX
  if (ext === '.docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer: buf });
    const text = (result.value ?? '').trim();
    if (!text) {
      throw new EmptyTextError();
    }
    return text;
  }

  // Excel
  if (
    ext === '.xlsx' ||
    ext === '.xls' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel'
  ) {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const sheets = workbook.SheetNames.map((sheetName) => {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) return '';
      const rows = XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(worksheet, {
        header: 1,
        blankrows: false,
        defval: '',
      });
      const lines = rows
        .map((row) =>
          row
            .map((cell) => (cell instanceof Date ? cell.toISOString() : String(cell ?? '').trim()))
            .filter(Boolean)
            .join('\t'),
        )
        .filter(Boolean);
      return lines.length > 0 ? [`# ${sheetName}`, ...lines].join('\n') : '';
    }).filter(Boolean);
    const text = sheets.join('\n\n').trim();
    if (!text) {
      throw new EmptyTextError();
    }
    return text;
  }

  // PPTX
  if (
    ext === '.pptx' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    const [{ default: JSZip }, { DOMParser }] = await Promise.all([
      import('jszip'),
      import('@xmldom/xmldom'),
    ]);
    const zip = await JSZip.loadAsync(buf);
    const slideEntries = Object.values(zip.files)
      .filter((file) => /^ppt\/slides\/slide\d+\.xml$/.test(file.name))
      .sort((a, b) => {
        const an = Number(a.name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
        const bn = Number(b.name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
        return an - bn;
      });
    const parser = new DOMParser();
    const slides = await Promise.all(
      slideEntries.map(async (entry, index) => {
        const xml = await entry.async('text');
        const doc = parser.parseFromString(xml, 'application/xml');
        const nodes = Array.from(doc.getElementsByTagName('a:t'));
        const lines = nodes
          .map((node) => node.textContent?.trim() ?? '')
          .filter(Boolean);
        return lines.length > 0 ? [`# Slide ${index + 1}`, ...lines].join('\n') : '';
      }),
    );
    const text = slides.filter(Boolean).join('\n\n').trim();
    if (!text) {
      throw new EmptyTextError();
    }
    return text;
  }

  // 不支持的类型
  throw new Error(`不支持的文件类型：${mime} (${filename})`);
}
