// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_ATTACHMENT_ACCEPT,
  attachmentLabels,
  fileToChatAttachment,
  filesToChatAttachments,
  stripAttachmentForApi,
} from "./chatAttachments";

/** jsdom 没有 `URL.createObjectURL`，图片分支会直接炸 —— 桩一个能认出来的返回值。 */
beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (file: File) => `blob:${file.type}` }));
});

afterEach(() => vi.unstubAllGlobals());

function file(name: string, type: string, content = "内容"): File {
  return new File([content], name, { type });
}

/** 超限的那一个：不真造 10MB 数据，改写 size 就够（校验只看 `file.size`）。 */
function oversized(name: string): File {
  const big = file(name, "application/pdf");
  Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });

  return big;
}

describe("CHAT_ATTACHMENT_ACCEPT", () => {
  it("图片给 MIME、文档给扩展名，逗号分隔", () => {
    const entries = CHAT_ATTACHMENT_ACCEPT.split(",");

    expect(entries.filter((entry) => entry.startsWith("image/"))).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
    expect(entries.filter((entry) => entry.startsWith("."))).toContain(".docx");
    // 两类之外不该有第三种写法
    expect(entries.every((entry) => entry.startsWith("image/") || entry.startsWith("."))).toBe(true);
  });
});

describe("fileToChatAttachment", () => {
  it("图片：认成 image、带上预览 URL、base64 只留逗号后那截", async () => {
    const attachment = await fileToChatAttachment(file("猫.png", "image/png"));

    expect(attachment.kind).toBe("image");
    expect(attachment.name).toBe("猫.png");
    expect(attachment.previewUrl).toBe("blob:image/png");
    expect(attachment.dataBase64).not.toContain(",");
    expect(Buffer.from(attachment.dataBase64, "base64").toString("utf8")).toBe("内容");
  });

  it("文档：认成 file、不生成预览 URL", async () => {
    const attachment = await fileToChatAttachment(file("说明.md", "text/markdown"));

    expect(attachment.kind).toBe("file");
    expect(attachment.previewUrl).toBeUndefined();
  });

  it("没名字没 MIME 时各自兜底，图片与非图片的兜底名不同", async () => {
    const pasted = await fileToChatAttachment(file("", "image/png"));
    const unknown = await fileToChatAttachment(file("", ""));

    expect(pasted.name).toBe("粘贴图片");
    expect(unknown.name).toBe("附件");
    expect(unknown.mime).toBe("application/octet-stream");
  });

  it("id 带上文件名且每次都不同：同名文件连着传也不会撞 key", async () => {
    const [first, second] = await Promise.all([
      fileToChatAttachment(file("同名.txt", "text/plain")),
      fileToChatAttachment(file("同名.txt", "text/plain")),
    ]);

    expect(first.id).toContain("同名.txt");
    expect(first.id).not.toBe(second.id);
  });

  it("超过 10MB 的报错带上文件名与上限", async () => {
    await expect(fileToChatAttachment(oversized("大.pdf"))).rejects.toThrow("大.pdf 超过 10MB 限制");
  });
});

describe("filesToChatAttachments", () => {
  const three = [file("a.txt", "text/plain"), file("b.txt", "text/plain"), file("c.txt", "text/plain")];

  it("名额够就全收", async () => {
    const attachments = await filesToChatAttachments(three, 0);

    expect(attachments.map((item) => item.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("名额不够只收得下的那几个，剩下的静默丢掉", async () => {
    const attachments = await filesToChatAttachments(three, 6);

    expect(attachments.map((item) => item.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("名额已经用完才报错", async () => {
    await expect(filesToChatAttachments(three, 8)).rejects.toThrow("最多上传 8 个附件");
    await expect(filesToChatAttachments(three, 9)).rejects.toThrow("最多上传 8 个附件");
  });

  it("有一个超限就整批失败", async () => {
    await expect(filesToChatAttachments([three[0], oversized("大.pdf")], 0)).rejects.toThrow("超过 10MB 限制");
  });
});

describe("attachmentLabels", () => {
  const payload = (name: string) => ({ name, mime: "text/plain", sizeBytes: 1, kind: "file" as const, dataBase64: "" });

  it("没有附件就是空串（不能给正文平白多两个换行）", () => {
    expect(attachmentLabels([])).toBe("");
  });

  it("按顺序列成一段清单", () => {
    expect(attachmentLabels([payload("a.txt"), payload("b.txt")])).toBe("\n\n[附件]\n- a.txt\n- b.txt");
  });
});

describe("stripAttachmentForApi", () => {
  it("摘掉 id 与 previewUrl，其余原样留下", async () => {
    const attachment = await fileToChatAttachment(file("猫.png", "image/png"));
    const payload = stripAttachmentForApi(attachment);

    expect(Object.keys(payload).sort()).toEqual(["dataBase64", "kind", "mime", "name", "sizeBytes"]);
    expect(payload.name).toBe("猫.png");
    expect(payload.dataBase64).toBe(attachment.dataBase64);
  });
});
