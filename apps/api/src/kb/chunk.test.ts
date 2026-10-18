import { describe, expect, it } from "vitest";
import { chunkText, describeTextStructure } from "./chunk.js";

const options = (overrides: Partial<Parameters<typeof chunkText>[1]> = {}) => ({
  maxTokens: 4,
  overlapTokens: 1,
  maxChunks: 20,
  ...overrides,
});

describe("chunkText", () => {
  it("trim 后的短文本原样成为单块", () => {
    expect(chunkText("  hello world  ", options())).toEqual(["hello world"]);
  });

  it("空串和纯空白没有块", () => {
    expect(chunkText("", options())).toEqual([]);
    expect(chunkText(" \n\t ", options())).toEqual([]);
  });

  it("窗口按每 token 三个 UTF-16 code unit 计算", () => {
    const chunks = chunkText("0123456789abcdefghijkl", options({ overlapTokens: 0 }));
    expect(chunks).toEqual(["0123456789ab", "cdefghijkl"]);
  });

  it("相邻窗口精确重叠 overlapTokens × 3", () => {
    const chunks = chunkText("0123456789abcdefghijklmnop", options());
    expect(chunks[0]).toBe("0123456789ab");
    expect(chunks[1]).toBe("9abcdefghijk");
    expect(chunks[0].slice(-3)).toBe(chunks[1].slice(0, 3));
  });

  it("到 maxChunks 就停止", () => {
    expect(chunkText("x".repeat(100), options({ maxChunks: 3 }))).toHaveLength(3);
  });

  it("overlap 不小于窗口时仍逐个 code unit 前进", () => {
    expect(chunkText("abcdef", options({ maxTokens: 1, overlapTokens: 1, maxChunks: 4 }))).toEqual([
      "abc",
      "bcd",
      "cde",
      "def",
    ]);
  });

  it("纯空白窗口被跳过，但游标继续前进", () => {
    expect(chunkText("a      b", options({ maxTokens: 1, overlapTokens: 0 }))).toEqual(["a  ", " b"]);
  });

  it("继续使用 UTF-16 slice，保持既有块边界", () => {
    const chunks = chunkText("a😀bc", options({ maxTokens: 1, overlapTokens: 0 }));
    expect(chunks).toEqual(["a😀", "bc"]);
    expect(chunks[0]).toHaveLength(3);
  });
});

describe("标题感知切块", () => {
  const headingOptions = () => options({ maxTokens: 100, overlapTokens: 0 });

  it("按标题分节，每块带上节标题", () => {
    const text = "# 第一章\n这是第一章的内容。\n# 第二章\n这是第二章的内容。";
    const chunks = chunkText(text, headingOptions());
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("# 第一章\n这是第一章的内容。");
    expect(chunks[1]).toBe("# 第二章\n这是第二章的内容。");
  });

  it("文档开头的导语（无标题）独立成块", () => {
    const text = "导语部分。\n# 第一章\n正文。";
    const chunks = chunkText(text, headingOptions());
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("导语部分。");
    expect(chunks[1]).toBe("# 第一章\n正文。");
  });

  it("节内超长时节内窗口切，每块都带标题", () => {
    const body = "x".repeat(500);
    const text = `# 长节\n${body}`;
    const chunks = chunkText(text, options({ maxTokens: 100, overlapTokens: 0, maxChunks: 20 }));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.startsWith("# 长节\n")).toBe(true);
  });

  it("表格节（# 表名 + TSV）不被拦腰切断", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `a${i}\tb${i}\tc${i}`).join("\n");
    const text = `# 销售表\n${rows}\n# 另一节\n正文。`;
    const chunks = chunkText(text, headingOptions());
    const tableChunk = chunks.find((chunk) => chunk.startsWith("# 销售表"));
    expect(tableChunk).toContain("a0\tb0\tc0");
    expect(tableChunk).toContain("a9\tb9\tc9");
  });

  it("#hashtag 这类行不算标题，走原路径", () => {
    const text = "谈 #AI 吧";
    expect(chunkText(text, options())).toEqual(["谈 #AI 吧"]);
    expect(describeTextStructure(text).strategy).toBe("plain");
  });

  it("空节（只有标题）被丢弃", () => {
    const text = "# 空节\n# 实节\n有内容。";
    const chunks = chunkText(text, headingOptions());
    expect(chunks).toEqual(["# 实节\n有内容。"]);
  });

  it("maxChunks 上限仍然生效", () => {
    const text = "# 一\n1\n# 二\n2\n# 三\n3\n# 四\n4";
    expect(chunkText(text, options({ maxTokens: 100, overlapTokens: 0, maxChunks: 2 }))).toHaveLength(2);
  });
});

describe("describeTextStructure", () => {
  it("空文本", () => {
    expect(describeTextStructure("  ")).toEqual({ headingCount: 0, tableSectionCount: 0, strategy: "plain" });
  });

  it("无标题文本走 plain", () => {
    const result = describeTextStructure("普通文本，没有标题。");
    expect(result.strategy).toBe("plain");
    expect(result.headingCount).toBe(0);
  });

  it("识别标题数与表格节数", () => {
    const text = "# 销售表\na\tb\n# 说明\n普通文本。";
    const result = describeTextStructure(text);
    expect(result.strategy).toBe("headings");
    expect(result.headingCount).toBe(2);
    expect(result.tableSectionCount).toBe(1);
  });
});

describe("review 修复回归", () => {
  it("TSV 首行行首制表符保留，不错列", () => {
    const text = "# 表\n\tQ1\tQ2\n产品A\t10\t20";
    const chunks = chunkText(text, options({ maxTokens: 100, overlapTokens: 0 }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("\tQ1\tQ2");
    expect(chunks[0].startsWith("# 表\n\tQ1")).toBe(true);
  });

  it("代码围栏内的 # 注释不算标题，内容不丢", () => {
    const text = "```sh\n# 注释 A\n# 注释 B\necho ok\n```";
    const chunks = chunkText(text, options({ maxTokens: 100, overlapTokens: 0 }));
    // 无真实标题：走原路径，字节级一致
    expect(chunks).toEqual([text]);
    expect(describeTextStructure(text).strategy).toBe("plain");
  });

  it("纯标题文档返回空数组，不回退到旧路径", () => {
    expect(chunkText("# A\n# B", options({ maxTokens: 100, overlapTokens: 0 }))).toEqual([]);
    const structure = describeTextStructure("# A\n# B");
    expect(structure.headingCount).toBe(2);
    expect(structure.strategy).toBe("headings");
  });

  it("标题计入块预算，拼接后不超窗", () => {
    const heading = "# 123456789012345"; // 16 chars + \n = 17
    const body = "x".repeat(20);
    const chunks = chunkText(`${heading}\n${body}`, options({ maxTokens: 10, overlapTokens: 0, maxChunks: 20 }));
    expect(chunks.length).toBeGreaterThan(1);
    const windowSize = 10 * 3;
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(windowSize);
  });
});

describe("第二轮 review 回归", () => {
  it("文档末尾 TSV 空列的制表符保留", () => {
    const text = "# 表\nQ1\tQ2\n1\t2\t";
    const chunks = chunkText(text, options({ maxTokens: 100, overlapTokens: 0 }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].endsWith("1\t2\t")).toBe(true);
  });

  it("波浪号围栏内的 # 注释不算标题", () => {
    const text = "~~~sh\n# A\n# B\necho ok\n~~~";
    const chunks = chunkText(text, options({ maxTokens: 100, overlapTokens: 0 }));
    expect(chunks).toEqual([text]);
    expect(describeTextStructure(text).strategy).toBe("plain");
  });

  it("四反引号围栏内的三反引号不提前闭合", () => {
    const text = "````\ncode ``` here\n# not a heading\n````";
    const chunks = chunkText(text, options({ maxTokens: 100, overlapTokens: 0 }));
    expect(chunks).toEqual([text]);
  });

  it("导语 + 纯标题：只保留导语，不回退旧路径", () => {
    const text = "导语。\n# A\n# B";
    expect(chunkText(text, options({ maxTokens: 100, overlapTokens: 0 }))).toEqual(["导语。"]);
    expect(describeTextStructure(text).strategy).toBe("headings");
  });

  it("标题占满预算时行为确定：正文保留最小窗口", () => {
    const heading = `# ${"h".repeat(27)}`; // + \n = 30 字符，占满 10 tokens 窗口
    const chunks = chunkText(`${heading}\nabc`, options({ maxTokens: 10, overlapTokens: 0, maxChunks: 20 }));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.startsWith(`${heading}\n`)).toBe(true);
  });

  it("overlap 不超过正文窗口，步长不退化", () => {
    const heading = `# ${"h".repeat(20)}`; // 24 字符（含换行）
    const body = "abcdefghijklmnopqrst";
    const chunks = chunkText(
      `${heading}\n${body}`,
      options({ maxTokens: 10, overlapTokens: 2, maxChunks: 10 }),
    );
    // 正文窗口 6 字符、overlap 钳制为 1 token：必须覆盖到末尾，不能截断
    expect(chunks.join("").replaceAll(`${heading}\n`, "")).toContain("pqrst");
  });

  it("表格节按行切分，行不被拦腰切断", () => {
    const rows = ["aa\tbb\tcc", "dd\tee\tff", "gg\thh\tii", "jj\tkk\tll"].join("\n");
    const text = `# 表\n${rows}`;
    const chunks = chunkText(text, options({ maxTokens: 10, overlapTokens: 0, maxChunks: 20 }));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const body = chunk.replace("# 表\n", "");
      for (const line of body.split("\n")) {
        // 每行都是完整的一行，不存在被切断的行片段
        expect(["aa\tbb\tcc", "dd\tee\tff", "gg\thh\tii", "jj\tkk\tll"]).toContain(line);
      }
    }
  });
});

describe("第三轮 review 回归", () => {
  it("混合围栏字符不提前闭合", () => {
    const text = "```\n# A\n```~~~\n# B\n```";
    const chunks = chunkText(text, options({ maxTokens: 100, overlapTokens: 0 }));
    expect(chunks).toEqual([text]);
  });

  it("超长表格行硬切时末尾制表符不丢", () => {
    const text = "# 表\nab\tcde\t";
    const chunks = chunkText(text, options({ maxTokens: 2, overlapTokens: 0, maxChunks: 20 }));
    expect(chunks.length).toBeGreaterThan(0);
    // 所有切片拼起来应还原原始行（含末尾制表符）
    const reassembled = chunks.map((chunk) => chunk.replace("# 表\n", "")).join("");
    expect(reassembled).toBe("ab\tcde\t");
  });

  it("TSV 数据行首列为 # 时不被当成标题", () => {
    const text = "# 表\n#\tA\n#\tB";
    const chunks = chunkText(text, options({ maxTokens: 100, overlapTokens: 0 }));
    expect(chunks).not.toEqual([]);
    expect(chunks[0]).toContain("#\tA");
    expect(chunks[0]).toContain("#\tB");
  });
});

describe("第四轮 review 回归", () => {
  it("首列为 # A 的 TSV 行不被当成标题", () => {
    const text = "# 表\n# A\t1\n# B\t2";
    const chunks = chunkText(text, options({ maxTokens: 100, overlapTokens: 0 }));
    expect(chunks).not.toEqual([]);
    expect(chunks[0]).toContain("# A\t1");
    expect(chunks[0]).toContain("# B\t2");
  });
});
