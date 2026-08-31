/**
 * 钉住准入裁定表，以及「Prisma where 与规则表等价」。
 *
 * 第二件事是本文件的重点。`imageAdmissionWhere` 是把 `IMAGE_PREFIX_RULES` 机械翻成
 * 一坨嵌套 OR/AND/NOT 的产物，人眼很难核对；而它一旦与 `classifyImageRequestId` 不等价，
 * 症状是「素材库少了/多了一类素材」这种没人会立刻发现的错。所以这里自带一个只认那四种
 * 算子的求值器，拿一份覆盖全部前缀的 requestId 语料逐条比对两条路径的结论。
 *
 * 计划：`docs/superpowers/plans/2026-08-31-knowledge-vs-asset-library-split.md`
 */
import { describe, expect, it } from "vitest";
import {
  classifyImageRequestId,
  DEFAULT_IMAGE_RULE,
  IMAGE_PREFIX_RULES,
  imageAdmissionWhere,
  imageGroupKey,
} from "./asset-classify.js";
import type { AssetOrigin, AssetSourceModule } from "./asset-types.js";

/**
 * 只认本模块会生成的四种节点：`OR` / `AND` / `NOT` / `requestId.startsWith`。
 * 认不出的形状直接抛 —— 悄悄放过一个没实现的算子，等价性断言就变成了空转。
 */
function matches(node: unknown, requestId: string): boolean {
  if (typeof node !== "object" || node === null) throw new Error(`不认识的 where 节点：${JSON.stringify(node)}`);
  return Object.entries(node as Record<string, unknown>).every(([key, value]) => {
    if (key === "OR") return (value as readonly unknown[]).some((child) => matches(child, requestId));
    if (key === "AND") return (value as readonly unknown[]).every((child) => matches(child, requestId));
    if (key === "NOT") return !matches(value, requestId);
    if (key === "requestId") {
      const startsWith = (value as { readonly startsWith?: unknown }).startsWith;
      if (typeof startsWith !== "string") throw new Error(`requestId 只支持 startsWith：${JSON.stringify(value)}`);
      return requestId.startsWith(startsWith);
    }
    throw new Error(`不认识的 where 算子：${key}`);
  });
}

/** 覆盖全部 8 条前缀规则 + 兜底，外加几个边界（前缀本身、空串、未知 ecom）。 */
const CORPUS: readonly string[] = [
  "comic:ep-1:panel-2",
  "comic:",
  "article:wf-1:3",
  "article:",
  "ecom-reference:abc",
  "ecom-reference:",
  "ecom-stitch:wf-1:0",
  "ecom-master:wf-1:0",
  "ecom-segment:wf-1:2",
  "ecom-main:job-1:0",
  "ecom-unknown:x",
  "ecom-",
  "ecom",
  "req-123",
  "img-456",
  "pet-789",
  "",
  "randomthing",
];

describe("requestId 前缀准入裁定", () => {
  const cases: ReadonlyArray<
    readonly [string, boolean, AssetSourceModule, AssetOrigin, number | null]
  > = [
    ["comic:ep-1:panel-2", false, "comic", "ai", null],
    ["article:wf-1:3", true, "article", "ai", 1],
    ["ecom-reference:abc", true, "reference", "upload", null],
    ["ecom-stitch:wf-1:0", false, "ecom", "ai", null],
    ["ecom-master:wf-1:0", true, "ecom", "ai", 1],
    ["ecom-segment:wf-1:2", true, "ecom", "ai", 1],
    ["ecom-main:job-1:0", true, "ecom", "ai", 1],
    ["ecom-unknown:x", false, "ecom", "ai", null],
    ["req-123", true, "image", "ai", null],
    ["img-456", true, "image", "ai", null],
    ["pet-789", true, "image", "ai", null],
    ["", true, "image", "ai", null],
  ];

  it.each(cases)("%s → admit=%s module=%s origin=%s", (requestId, admit, sourceModule, origin, groupSegment) => {
    const rule = classifyImageRequestId(requestId);
    expect(rule.admit).toBe(admit);
    expect(rule.sourceModule).toBe(sourceModule);
    expect(rule.origin).toBe(origin);
    expect(rule.groupSegment).toBe(groupSegment);
  });

  it("`ecom-reference:` 排在 `ecom-` 兜底之前，否则参考图会被一起排掉", () => {
    const referenceIndex = IMAGE_PREFIX_RULES.findIndex((rule) => rule.prefix === "ecom-reference:");
    const catchAllIndex = IMAGE_PREFIX_RULES.findIndex((rule) => rule.prefix === "ecom-");
    expect(referenceIndex).toBeGreaterThanOrEqual(0);
    expect(referenceIndex).toBeLessThan(catchAllIndex);
  });

  it("`ecom-` 兜底是最后一条 ecom 规则：新增具体前缀必须插在它前面", () => {
    const ecomRules = IMAGE_PREFIX_RULES.filter((rule) => rule.prefix.startsWith("ecom-"));
    expect(ecomRules.at(-1)?.prefix).toBe("ecom-");
  });

  it("每条规则都写了 why：裁定理由不写下来，下一个人只能靠猜", () => {
    for (const rule of [...IMAGE_PREFIX_RULES, DEFAULT_IMAGE_RULE]) {
      expect(rule.why.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("imageGroupKey", () => {
  it("按 groupSegment 取归属项目 id", () => {
    expect(imageGroupKey("article:wf-1:3", classifyImageRequestId("article:wf-1:3"))).toBe("wf-1");
    expect(imageGroupKey("ecom-main:job-9:0", classifyImageRequestId("ecom-main:job-9:0"))).toBe("job-9");
  });

  it("groupSegment 为 null 的规则不折叠", () => {
    expect(imageGroupKey("req-123", classifyImageRequestId("req-123"))).toBeNull();
  });

  it("段数不够或该段为空白时返回 null，不返回空串", () => {
    expect(imageGroupKey("article:", classifyImageRequestId("article:"))).toBeNull();
    expect(imageGroupKey("article:   :3", classifyImageRequestId("article:   :3"))).toBeNull();
  });
});

describe("imageAdmissionWhere 与规则表等价", () => {
  it("不带过滤时，where 的判定与 classifyImageRequestId().admit 逐条一致", () => {
    const where = imageAdmissionWhere();
    for (const requestId of CORPUS) {
      expect({ requestId, admitted: matches(where, requestId) })
        .toEqual({ requestId, admitted: classifyImageRequestId(requestId).admit });
    }
  });

  const filters: ReadonlyArray<{ readonly sourceModule?: AssetSourceModule; readonly origin?: AssetOrigin }> = [
    { sourceModule: "image" },
    { sourceModule: "article" },
    { sourceModule: "ecom" },
    { sourceModule: "reference" },
    { origin: "ai" },
    { origin: "upload" },
    { sourceModule: "ecom", origin: "ai" },
    { sourceModule: "reference", origin: "upload" },
  ];

  it.each(filters)("带过滤 %o 时同样逐条一致", (filter) => {
    const where = imageAdmissionWhere(filter);
    for (const requestId of CORPUS) {
      const rule = classifyImageRequestId(requestId);
      const expected = rule.admit
        && (!filter.sourceModule || rule.sourceModule === filter.sourceModule)
        && (!filter.origin || rule.origin === filter.origin);
      expect({ requestId, admitted: matches(where, requestId) }).toEqual({ requestId, admitted: expected });
    }
  });

  it("过滤条件谁都不满足时给出空 OR（Prisma 语义：一行都不要）", () => {
    // comic 只有 deny 规则；reference 只有 upload。两个组合都该是空。
    expect(imageAdmissionWhere({ sourceModule: "comic" }).OR).toEqual([]);
    expect(imageAdmissionWhere({ sourceModule: "reference", origin: "ai" }).OR).toEqual([]);
    for (const requestId of CORPUS) {
      expect(matches(imageAdmissionWhere({ sourceModule: "comic" }), requestId)).toBe(false);
    }
  });

  it("`upload` 分区只放行 ecom-reference:，AI 分区不含它", () => {
    const upload = imageAdmissionWhere({ origin: "upload" });
    expect(matches(upload, "ecom-reference:abc")).toBe(true);
    expect(matches(upload, "req-123")).toBe(false);
    expect(matches(imageAdmissionWhere({ origin: "ai" }), "ecom-reference:abc")).toBe(false);
  });
});
