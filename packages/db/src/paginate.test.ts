import { describe, expect, it, vi } from "vitest";
import { paginate, type PaginateResult } from "./paginate.js";

/**
 * paginate 验收：take 夹取、缺 orderBy 抛错、cursor 翻页不重不漏。
 * fake delegate 按 Prisma 语义实现（where 等值过滤 / orderBy 单字段 / cursor+skip / take）。
 */

interface FakeRow {
  id: string;
  n: number;
  tag: string;
}

function fakeModel(rows: FakeRow[]) {
  return {
    async findMany(args: Record<string, unknown>): Promise<FakeRow[]> {
      let list = [...rows];
      const where = args.where as { tag?: string } | undefined;
      if (where?.tag !== undefined) list = list.filter((row) => row.tag === where.tag);
      const orderList = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) as Record<string, "asc" | "desc">[];
      list.sort((a, b) => {
        for (const order of orderList) {
          const [field, direction] = Object.entries(order)[0]!;
          const av = a[field as keyof FakeRow];
          const bv = b[field as keyof FakeRow];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          if (cmp !== 0) return direction === "asc" ? cmp : -cmp;
        }
        return 0;
      });
      if (args.cursor) {
        const cursorId = (args.cursor as { id: string }).id;
        const idx = list.findIndex((row) => row.id === cursorId);
        list = list.slice(idx + Number(args.skip ?? 0));
      }
      const select = args.select as Record<string, boolean> | undefined;
      const taken = list.slice(0, Number(args.take));
      if (!select) return taken;
      return taken.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(select)) if (select[key]) out[key] = row[key as keyof FakeRow];
        return out as unknown as FakeRow;
      });
    },
  };
}

const rows250: FakeRow[] = Array.from({ length: 250 }, (_, i) => ({ id: `r${i + 1}`, n: i + 1, tag: (i + 1) % 2 ? "odd" : "even" }));

describe("paginate", () => {
  it("take 超过 maxTake 被夹到上限", async () => {
    const { rows, nextCursor } = await paginate<FakeRow>(fakeModel(rows250), { orderBy: { n: "asc" }, take: 500 });
    expect(rows).toHaveLength(200);
    expect(nextCursor).toBe("r200");
  });

  it("自定义 maxTake 生效，默认 take 为 50", async () => {
    const capped = await paginate<FakeRow>(fakeModel(rows250), { orderBy: { n: "asc" }, take: 500, maxTake: 30 });
    expect(capped.rows).toHaveLength(30);
    const defaulted = await paginate<FakeRow>(fakeModel(rows250), { orderBy: { n: "asc" } });
    expect(defaulted.rows).toHaveLength(50);
  });

  it("take=0 或负数被夹到 1", async () => {
    const zero = await paginate<FakeRow>(fakeModel(rows250), { orderBy: { n: "asc" }, take: 0 });
    expect(zero.rows).toHaveLength(1);
    expect(zero.nextCursor).toBe("r1");
    const negative = await paginate<FakeRow>(fakeModel(rows250), { orderBy: { n: "asc" }, take: -5 });
    expect(negative.rows).toHaveLength(1);
  });

  it.each([NaN, Infinity, -Infinity])("非有限 take 回退后仍遵守较小的 maxTake：%s", async (take) => {
    const inner = fakeModel(rows250);
    const findMany = vi.fn(inner.findMany);
    const result = await paginate<FakeRow>({ findMany }, { orderBy: { n: "asc" }, take, maxTake: 2 });

    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).toBe("r2");
    expect(findMany.mock.calls[0]?.[0].take).toBe(3);
  });

  it("缺 orderBy 抛错（无排序分页不可靠）", async () => {
    await expect(paginate(fakeModel(rows250), { orderBy: undefined })).rejects.toThrow(/orderBy/);
    await expect(paginate(fakeModel(rows250), { orderBy: [] })).rejects.toThrow(/orderBy/);
  });

  it("cursor 翻页不重不漏，顺序稳定", async () => {
    const model = fakeModel(rows250.slice(0, 10));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result: PaginateResult<FakeRow> = await paginate<FakeRow>(model, { orderBy: { n: "asc" }, take: 4, cursor });
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10"]);
    expect(cursor).toBeNull();
  });

  it("orderBy 字段有并列值时靠自动补的 id 兜底排序不重不漏", async () => {
    // n 全部并列且输入顺序打乱：只按 n 排（稳定排序保留输入序）时翻页顺序是乱的，
    // paginate 必须自动补 { id: 'asc' } 把顺序钉死——撤掉兜底这条测试就会红。
    const shuffled = ["t5", "t2", "t9", "t1", "t7", "t3", "t8", "t4", "t6"];
    const tied: FakeRow[] = shuffled.map((id) => ({ id, n: 7, tag: "x" }));
    const inner = fakeModel(tied);
    const findMany = vi.fn(inner.findMany);
    const model = { findMany };
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result: PaginateResult<FakeRow> = await paginate<FakeRow>(model, { orderBy: { n: "asc" }, take: 4, cursor });
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
    // 直接断言传给 delegate 的 orderBy 真的带上了 id 兜底（asc 跟随主方向、desc 同理）
    expect(findMany.mock.calls[0]![0]!.orderBy).toEqual([{ n: "asc" }, { id: "asc" }]);
    await paginate<FakeRow>(model, { orderBy: { n: "desc" }, take: 2 });
    expect(findMany.mock.calls.at(-1)![0]!.orderBy).toEqual([{ n: "desc" }, { id: "desc" }]);
  });

  it("orderBy 里 id 值无效（undefined）不算已排，会被剔除并补上真兜底", async () => {
    const inner = fakeModel(rows250.slice(0, 3));
    const findMany = vi.fn(inner.findMany);
    await paginate<FakeRow>({ findMany }, { orderBy: { n: "desc", id: undefined } as never, take: 2 });
    expect(findMany.mock.calls[0]![0]!.orderBy).toEqual([{ n: "desc" }, { id: "desc" }]);
  });

  it("where 与 select 原样透传给 delegate", async () => {
    const { rows } = await paginate<FakeRow>(fakeModel(rows250), {
      orderBy: { n: "desc" },
      where: { tag: "even" },
      select: { id: true, n: true },
      take: 3,
    });
    expect(rows.map((row) => row.n)).toEqual([250, 248, 246]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "n"]);
  });
});
