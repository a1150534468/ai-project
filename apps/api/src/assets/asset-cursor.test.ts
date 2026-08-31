/**
 * 钉住排序键、游标编解码，以及 `keysetWhere` 三个分支。
 *
 * 最要紧的是两条**性质**，而不是某个具体返回值：
 *   1. 任意两个源前缀之间谁都不是谁的前缀 —— 跨源分支只比前缀就敢整段收/整段丢，全靠它；
 *   2. 因此「前缀比全局 id」与「拼出全 id 再比」结论一致，这里对全部前缀两两验证。
 * 哪天有人加一个叫 `image-hd:` 的源（`image:` 不是它的前缀，但 `image` 是），第 1 条依然成立；
 * 真正会踩的是加一个 `dub` 或 `image` 这种不带 `:` 的前缀，第 1 条会立刻红。
 */
import { describe, expect, it } from "vitest";
import {
  ASSET_SOURCE_ID_PREFIXES,
  compareAssetKeysDesc,
  decodeAssetCursor,
  encodeAssetCursor,
  isBelowCursor,
  keysetWhere,
} from "./asset-cursor.js";

const PREFIXES = Object.values(ASSET_SOURCE_ID_PREFIXES);
const T1 = "2026-08-31T10:00:00.000Z";
const T2 = "2026-08-31T09:00:00.000Z";

describe("源前缀的前缀性质", () => {
  it("任意两个前缀之间，谁都不是谁的前缀", () => {
    for (const a of PREFIXES) {
      for (const b of PREFIXES) {
        if (a === b) continue;
        expect({ a, b, isPrefix: b.startsWith(a) }).toEqual({ a, b, isPrefix: false });
      }
    }
  });

  it("前缀两两不同（否则两个源会共用一段 id 空间）", () => {
    expect(new Set(PREFIXES).size).toBe(PREFIXES.length);
  });

  it("「前缀 < 游标全 id」与「本源全 id < 游标全 id」结论一致", () => {
    const rowKeys = ["", "0", "a", "zzzzzz", "ffffffff-1111-2222-3333-444444444444"];
    for (const prefix of PREFIXES) {
      for (const other of PREFIXES) {
        if (other === prefix) continue;
        for (const cursorRowKey of rowKeys) {
          const cursorId = `${other}${cursorRowKey}`;
          for (const rowKey of rowKeys) {
            expect({ prefix, cursorId, rowKey, same: (prefix < cursorId) === (`${prefix}${rowKey}` < cursorId) })
              .toEqual({ prefix, cursorId, rowKey, same: true });
          }
        }
      }
    }
  });
});

describe("compareAssetKeysDesc", () => {
  it("先按 createdAt 降序，再按 id 降序", () => {
    const sorted = [
      { createdAt: T2, id: "image:b" },
      { createdAt: T1, id: "image:a" },
      { createdAt: T1, id: "image:b" },
      { createdAt: T2, id: "image:a" },
    ].sort(compareAssetKeysDesc);
    expect(sorted.map((item) => `${item.createdAt}|${item.id}`)).toEqual([
      `${T1}|image:b`,
      `${T1}|image:a`,
      `${T2}|image:b`,
      `${T2}|image:a`,
    ]);
  });

  it("同键返回 0", () => {
    expect(compareAssetKeysDesc({ createdAt: T1, id: "image:a" }, { createdAt: T1, id: "image:a" })).toBe(0);
  });
});

describe("isBelowCursor", () => {
  const cursor = { createdAt: new Date(T1), id: "dub:p1:result" };

  it("没有游标时一律通过", () => {
    expect(isBelowCursor({ createdAt: T1, id: "image:z" }, null)).toBe(true);
  });

  it("时间更早的通过，更晚的不通过", () => {
    expect(isBelowCursor({ createdAt: T2, id: "image:z" }, cursor)).toBe(true);
    expect(isBelowCursor({ createdAt: "2026-08-31T11:00:00.000Z", id: "image:a" }, cursor)).toBe(false);
  });

  it("同一时间上严格按 id 比：游标那一条自己不通过", () => {
    expect(isBelowCursor({ createdAt: T1, id: "dub:p1:result" }, cursor)).toBe(false);
    // 同一行的三个槽位在降序里是 result > final > audio：停在 result 时后两条都还没给过。
    expect(isBelowCursor({ createdAt: T1, id: "dub:p1:final" }, cursor)).toBe(true);
    expect(isBelowCursor({ createdAt: T1, id: "dub:p1:audio" }, cursor)).toBe(true);
    // 已经给过的那条（id 更大）不会再来一次。
    expect(isBelowCursor({ createdAt: T1, id: "dub:p1:z" }, cursor)).toBe(false);
  });
});

describe("游标编解码", () => {
  it("毫秒精度原样往返（Prisma DateTime 是 timestamp(3)）", () => {
    const createdAt = new Date("2026-08-31T10:00:00.123Z");
    const decoded = decodeAssetCursor(encodeAssetCursor({ createdAt, id: "image:abc" }));
    expect(decoded?.createdAt.toISOString()).toBe("2026-08-31T10:00:00.123Z");
    expect(decoded?.id).toBe("image:abc");
  });

  it("id 里带 `:`（口播的 `dub:<id>:<槽位>`）也原样往返", () => {
    const cursor = { createdAt: new Date(T1), id: "dub:proj-1:final" };
    expect(decodeAssetCursor(encodeAssetCursor(cursor))?.id).toBe("dub:proj-1:final");
  });

  it("编出来的是 URL 安全的（能直接进 query string）", () => {
    const raw = encodeAssetCursor({ createdAt: new Date(T1), id: "image:+/=abc" });
    expect(raw).toBe(encodeURIComponent(raw));
  });

  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["空串", ""],
    ["没有分隔符", Buffer.from("1234567890", "utf8").toString("base64url")],
    ["时间不是数字", Buffer.from("abc:image:x", "utf8").toString("base64url")],
    ["时间为负", Buffer.from("-1:image:x", "utf8").toString("base64url")],
    ["时间不是整数", Buffer.from("1.5:image:x", "utf8").toString("base64url")],
    ["id 为空", Buffer.from("1756633200000:", "utf8").toString("base64url")],
    ["id 超长", Buffer.from(`1756633200000:${"a".repeat(201)}`, "utf8").toString("base64url")],
    ["分隔符在开头", Buffer.from(":image:x", "utf8").toString("base64url")],
    ["不是 base64", "!!!!"],
  ];

  it.each(malformed)("解不出来就返回 null：%s", (_label, raw) => {
    expect(decodeAssetCursor(raw)).toBeNull();
  });

  it("id 刚好 200 字符是合法的（上限是含等号的边界）", () => {
    const id = "a".repeat(200);
    const raw = Buffer.from(`1756633200000:${id}`, "utf8").toString("base64url");
    expect(decodeAssetCursor(raw)?.id).toBe(id);
  });
});

describe("keysetWhere", () => {
  const createdAt = new Date(T1);

  it("没有游标时不加任何条件", () => {
    expect(keysetWhere(null, "image:")).toEqual({});
  });

  it("同源：游标那一行连着捞回来（lte），因为一行可能产出多条素材", () => {
    expect(keysetWhere({ createdAt, id: "dub:proj-1:final" }, "dub:")).toEqual({
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lte: "proj-1:final" } },
      ],
    });
  });

  it("同源：只剥掉自己的前缀，行 id 原样进 SQL", () => {
    const where = keysetWhere({ createdAt, id: "codex-pet:art-1" }, "codex-pet:") as {
      readonly OR: ReadonlyArray<{ readonly id?: { readonly lte: string } }>;
    };
    expect(where.OR[1]?.id).toEqual({ lte: "art-1" });
  });

  it("跨源：本源前缀更小 ⇒ 同一时间的行整段都在游标之后（lte）", () => {
    // "image:" < "portrait:..."
    expect(keysetWhere({ createdAt, id: "portrait:x" }, "image:")).toEqual({ createdAt: { lte: createdAt } });
  });

  it("跨源：本源前缀更大 ⇒ 同一时间的行整段都在游标之前（lt）", () => {
    // "portrait:" > "image:..."
    expect(keysetWhere({ createdAt, id: "image:x" }, "portrait:")).toEqual({ createdAt: { lt: createdAt } });
  });

  it("游标 id 是别人手改的、认不出前缀时也不炸（退化成纯字典序比较）", () => {
    expect(keysetWhere({ createdAt, id: "zzz" }, "image:")).toEqual({ createdAt: { lte: createdAt } });
    expect(keysetWhere({ createdAt, id: "aaa" }, "image:")).toEqual({ createdAt: { lt: createdAt } });
  });
});
