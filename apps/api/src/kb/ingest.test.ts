import { describe, expect, it } from "vitest";
import { sanitizeFilename, validateFileUpload } from "./ingest.js";

describe("sanitizeFilename", () => {
  it("保留中文标题和常见文件名字符", () => {
    expect(sanitizeFilename("ICP备案说明（终版）.docx")).toBe("ICP备案说明（终版）.docx");
    expect(sanitizeFilename("项目 2026-06-29.xlsx")).toBe("项目 2026-06-29.xlsx");
  });

  it("移除路径组件和危险控制字符", () => {
    expect(sanitizeFilename("../../中文文档\u0000?.docx")).toBe("中文文档__.docx");
  });
});

describe("validateFileUpload", () => {
  it("接受常见工作文档格式", () => {
    const files = [
      ["a.pdf", "application/pdf"],
      ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["a.xls", "application/vnd.ms-excel"],
      ["a.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["a.csv", "text/csv"],
      ["a.json", "application/json"],
      ["a.xml", "application/xml"],
    ] as const;

    for (const [filename, mime] of files) {
      expect(validateFileUpload(filename, mime, 1024)).toEqual({ ok: true });
    }
  });
});
