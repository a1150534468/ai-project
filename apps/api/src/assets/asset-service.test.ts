/**
 * 钉住多路归并 + 键集分页：**全量走一遍，不重不漏，且顺序等于全局降序**。
 *
 * 假源不是随便返几条就算：它按真源的方式工作 —— 用 `keysetWhere` 真实返回的 where 形状
 * 在**行**粒度上筛，排序取前 `take` **行**，再把每行摊成 1..n 条素材。这样「一行多素材」
 * （口播的三个媒体列）和「窗口浪费一行」这两件事在测试里是真的发生的，而不是被绕过。
 *
 * where 形状由本文件的 `rowPasses` 解释，认不出的算子直接抛：`keysetWhere` 改了形状而
 * 这里没跟上时，测试必须红，不能悄悄退化成「全放行」。
 */
import { describe, expect, it, vi } from "vitest";
import { decodeAssetCursor, keysetWhere } from "./asset-cursor.js";
import { ASSET_PAGE_SIZE_DEFAULT, ASSET_PAGE_SIZE_MAX, clampAssetPageSize, listAssets } from "./asset-service.js";
import type { AssetSource, AssetSourceDeps } from "./asset-sources.js";
import type { AssetCursor, AssetItem, AssetOrigin, AssetSourceModule } from "./asset-types.js";

/** 一行 → 1..n 条素材，跟真源一样。 */
interface FakeRow {
  readonly createdAt: string;
  /** 权威表里的行 id（不带源前缀）。 */
  readonly rowKey: string;
  readonly slots: readonly string[];
}

const DEPS = {} as AssetSourceDeps;

function item(prefix: string, row: FakeRow, slot: string, module: AssetSourceModule, origin: AssetOrigin): AssetItem {
  return {
    id: slot ? `${prefix}${row.rowKey}:${slot}` : `${prefix}${row.rowKey}`,
    sourceModule: module,
    origin,
    mediaType: "image",
    title: `${prefix}${row.rowKey}`,
    url: null,
    thumbnailUrl: null,
    mime: "image/png",
    width: null,
    height: null,
    sizeBytes: null,
    durationSec: null,
    createdAt: row.createdAt,
    groupKey: null,
    groupLabel: null,
  };
}

/** 解释 `keysetWhere` 的返回值。只认它真的会生成的四种形状，其余抛。 */
function rowPasses(where: Record<string, unknown>, row: FakeRow): boolean {
  const entries = Object.entries(where);
  if (entries.length === 0) return true;
  return entries.every(([key, value]) => {
    if (key === "OR") {
      return (value as ReadonlyArray<Record<string, unknown>>).some((child) => rowPasses(child, row));
    }
    if (key === "createdAt") {
      if (value instanceof Date) return Date.parse(row.createdAt) === value.getTime();
      const bound = value as { readonly lt?: Date; readonly lte?: Date };
      if (bound.lt) return Date.parse(row.createdAt) < bound.lt.getTime();
      if (bound.lte) return Date.parse(row.createdAt) <= bound.lte.getTime();
      throw new Error(`createdAt 上只支持 lt/lte：${JSON.stringify(value)}`);
    }
    if (key === "id") {
      const bound = value as { readonly lte?: string };
      if (typeof bound.lte !== "string") throw new Error(`id 上只支持 lte：${JSON.stringify(value)}`);
      return row.rowKey <= bound.lte;
    }
    throw new Error(`不认识的 where 算子：${key}`);
  });
}

function fakeSource(config: {
  readonly prefix: string;
  readonly modules: readonly AssetSourceModule[];
  readonly origins: readonly AssetOrigin[];
  readonly rows: readonly FakeRow[];
}): AssetSource & { readonly takes: number[]; readonly rows: readonly FakeRow[] } {
  const takes: number[] = [];
  return {
    key: config.prefix,
    modules: config.modules,
    origins: config.origins,
    takes,
    rows: config.rows,
    fetch: async (_deps, query) => {
      takes.push(query.take);
      const where = keysetWhere(query.cursor, config.prefix);
      return config.rows
        .filter((row) => rowPasses(where, row))
        .sort((a, b) => {
          const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
          if (byTime !== 0) return byTime;
          return a.rowKey < b.rowKey ? 1 : a.rowKey > b.rowKey ? -1 : 0;
        })
        .slice(0, query.take)
        .flatMap((row) =>
          row.slots.map((slot) => item(config.prefix, row, slot, config.modules[0]!, config.origins[0]!)),
        );
    },
  };
}

const TIMES = [
  "2026-08-31T12:00:00.000Z",
  "2026-08-31T11:00:00.000Z",
  // 同一毫秒上堆一簇，且这一簇比大多数 limit 都大：只用 lte 的写法会在这里卡死或漏行。
  "2026-08-31T10:00:00.000Z",
];

function rowsAt(times: readonly string[], count: number, slots: readonly string[]): FakeRow[] {
  const rows: FakeRow[] = [];
  for (const [timeIndex, createdAt] of times.entries()) {
    for (let n = 0; n < count; n += 1) {
      rows.push({ createdAt, rowKey: `r${timeIndex}-${String(n).padStart(2, "0")}`, slots });
    }
  }
  return rows;
}

function makeSources() {
  return [
    fakeSource({ prefix: "image:", modules: ["image"], origins: ["ai"], rows: rowsAt(TIMES, 3, [""]) }),
    fakeSource({ prefix: "reference:", modules: ["reference"], origins: ["ai"], rows: rowsAt(TIMES, 2, [""]) }),
    // 一行三条：键集分页对「一行多素材」的处理，用一个假源钉住（真源现在都是一行一条）。
    fakeSource({
      prefix: "video:",
      modules: ["video"],
      origins: ["ai"],
      rows: rowsAt([TIMES[2]!], 2, ["final", "result", "audio"]),
    }),
    fakeSource({ prefix: "audio:", modules: ["audio"], origins: ["upload"], rows: rowsAt(TIMES, 1, [""]) }),
  ];
}

function expectedOrder(sources: ReturnType<typeof makeSources>): string[] {
  return sources
    .flatMap((source) =>
      source.rows.flatMap((row) => row.slots.map((slot) => item(source.key, row, slot, "image", "ai"))),
    )
    .sort((a, b) => {
      const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (byTime !== 0) return byTime;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    })
    .map((entry) => entry.id);
}

/** 一路翻到底，返回每页的 id。页数设上限：游标不前进的 bug 会表现成死循环。 */
async function walkAll(
  sources: readonly AssetSource[],
  limit: number,
  query: { readonly sourceModule?: AssetSourceModule; readonly origin?: AssetOrigin } = {},
): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: AssetCursor | null = null;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await listAssets(
      DEPS,
      { userId: "u1", limit, cursor, sourceModule: query.sourceModule, origin: query.origin },
      sources,
    );
    pages.push(page.items.map((entry) => entry.id));
    expect(page.items.length).toBeLessThanOrEqual(limit);
    if (!page.nextCursor) return pages;
    cursor = decodeAssetCursor(page.nextCursor);
    expect(cursor).not.toBeNull();
  }
  throw new Error("翻页没有收敛：nextCursor 一直不为 null");
}

describe("clampAssetPageSize", () => {
  it("缺省、越界、非整数都收敛到合法区间", () => {
    expect(clampAssetPageSize(undefined)).toBe(ASSET_PAGE_SIZE_DEFAULT);
    expect(clampAssetPageSize(Number.NaN)).toBe(ASSET_PAGE_SIZE_DEFAULT);
    expect(clampAssetPageSize(0)).toBe(1);
    expect(clampAssetPageSize(-5)).toBe(1);
    expect(clampAssetPageSize(1000)).toBe(ASSET_PAGE_SIZE_MAX);
    expect(clampAssetPageSize(7.9)).toBe(7);
  });
});

describe("多路归并 + 键集分页", () => {
  it("单页就装得下时，顺序等于全局降序", async () => {
    const sources = makeSources();
    const page = await listAssets(DEPS, { userId: "u1", limit: 100 }, sources);
    expect(page.items.map((entry) => entry.id)).toEqual(expectedOrder(sources));
    expect(page.nextCursor).toBeNull();
  });

  // 3 是关键：同一毫秒上有 3+2+2*3+1 = 12 条，远大于窗口，只用 lte 的写法会在这一簇里卡死。
  it.each([1, 2, 3, 5, 7, 11, 30])("limit=%i 全量翻一遍：不重、不漏、顺序不变", async (limit) => {
    const sources = makeSources();
    const expected = expectedOrder(sources);
    const pages = await walkAll(sources, limit);
    const flat = pages.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toEqual(expected);
    // 最后一页之前每页都必须是满的，否则就是提前把窗口让出去了。
    for (const page of pages.slice(0, -1)) expect(page.length).toBe(limit);
  });

  it("每源多捞两行（limit + 2）", async () => {
    const sources = makeSources();
    await listAssets(DEPS, { userId: "u1", limit: 5 }, sources);
    for (const source of sources) expect(source.takes).toEqual([7]);
  });

  it("到底了就不再给游标（空库同理）", async () => {
    const page = await listAssets(DEPS, { userId: "u1", limit: 10 }, [
      fakeSource({ prefix: "image:", modules: ["image"], origins: ["ai"], rows: [] }),
    ]);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("过滤", () => {
  it("按 module 过滤时整源跳过：不该问的源一次都不问", async () => {
    const sources = makeSources();
    const spies = sources.map((source) => vi.spyOn(source, "fetch"));
    const page = await listAssets(DEPS, { userId: "u1", limit: 50, sourceModule: "video" }, sources);
    expect(page.items.every((entry) => entry.id.startsWith("video:"))).toBe(true);
    expect(page.items.length).toBe(6);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 1, 0]);
  });

  it("按 origin 过滤时同样整源跳过（前端的两个分区靠它）", async () => {
    const sources = makeSources();
    const spies = sources.map((source) => vi.spyOn(source, "fetch"));
    const page = await listAssets(DEPS, { userId: "u1", limit: 50, origin: "upload" }, sources);
    expect(page.items.every((entry) => entry.id.startsWith("audio:"))).toBe(true);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 1]);
  });

  it("过滤条件透传给源（同一张表要在 SQL 里再裁一次）", async () => {
    const sources = makeSources();
    const spy = vi.spyOn(sources[2]!, "fetch");
    await listAssets(DEPS, { userId: "u1", limit: 4, sourceModule: "video", origin: "ai" }, sources);
    expect(spy).toHaveBeenCalledWith(DEPS, {
      userId: "u1",
      cursor: null,
      take: 6,
      sourceModule: "video",
      origin: "ai",
    });
  });

  it("过滤后翻页依然不重不漏", async () => {
    const sources = makeSources();
    const flat = (await walkAll(sources, 2, { sourceModule: "video" })).flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toEqual(expectedOrder(sources).filter((id) => id.startsWith("video:")));
  });

  it("谁都不匹配时返回空页而不是全量", async () => {
    const sources = makeSources();
    const page = await listAssets(DEPS, { userId: "u1", limit: 10, sourceModule: "comic" }, sources);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});


