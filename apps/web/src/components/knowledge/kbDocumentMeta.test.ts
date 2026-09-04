/**
 * 状态表与体积文案。原来这两件事分散在页面里，坏法各有一种：
 * 名单外的状态没有文案，超过 1 TB 的体积会跳出单位表。
 */
import { describe, expect, it } from "vitest";
import type { KbDocument } from "../../kbApi";
import { formatBytes, isIndexing, kbStatusMeta } from "./kbDocumentMeta";

function doc(status: string): KbDocument {
  return {
    id: "d",
    name: "d.md",
    status: status as KbDocument["status"],
    sizeBytes: 1,
    chunkCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("kbStatusMeta", () => {
  it("四个状态各有文案、配色和图标", () => {
    expect(kbStatusMeta("pending").label).toBe("待处理");
    expect(kbStatusMeta("indexing").tone).toBe("warning");
    expect(kbStatusMeta("indexed").label).toBe("已建立知识晶格链接");
    expect(kbStatusMeta("failed").tone).toBe("danger");
  });

  it("认不出来的值退回「待处理」，不是退回一个没有文案的空徽标", () => {
    expect(kbStatusMeta("INDEXED")).toEqual(kbStatusMeta("pending"));
    expect(kbStatusMeta("").label).toBe("待处理");
  });

  it("「还没落地」和「图标要转」是两件事：排队中的那只钟不转", () => {
    expect(isIndexing(doc("pending"))).toBe(true);
    expect(kbStatusMeta("pending").spin).toBe(false);

    expect(isIndexing(doc("indexing"))).toBe(true);
    expect(kbStatusMeta("indexing").spin).toBe(true);

    expect(isIndexing(doc("indexed"))).toBe(false);
    expect(isIndexing(doc("failed"))).toBe(false);
  });
});

describe("formatBytes", () => {
  it("按 1024 进位，B 取整、往上留一位小数", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 3)).toBe("3 MB");
  });

  it("再大也停在 TB —— 原来这里会索引到单位表外面去", () => {
    expect(formatBytes(1024 ** 4)).toBe("1 TB");
    expect(formatBytes(1024 ** 5)).toBe("1024 TB");
    expect(formatBytes(1024 ** 6)).toBe("1048576 TB");
  });

  it("0 和脏数据都说 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
