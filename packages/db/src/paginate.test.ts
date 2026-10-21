import { describe, expect, it } from "vitest";
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
    // n 大量并列：只按 n 排序时边界行顺序不稳定，paginate 必须自动补 { id: 'asc' }
    const tied: FakeRow[] = Array.from({ length: 9 }, (_, i) => ({ id: `t${i + 1}`, n: 7, tag: "x" }));
    const model = fakeModel(tied);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result: PaginateResult<FakeRow> = await paginate<FakeRow>(model, { orderBy: { n: "asc" }, take: 4, cursor });
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
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
