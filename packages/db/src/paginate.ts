/**
 * 游标分页的公共出口（提示词 22）：仓库里 60% 的 findMany 没写 take、默认全量，
 * 与其逐个说服调用方，不如让「分页」只有一个正确入口。
 *
 * - orderBy 必填：没有稳定排序的分页会重会漏，缺了直接抛错。
 * - take 夹在 [1, maxTake]（默认 50 / 上限 200）：调用方写多写少都不出界。
 * - 内部多取一行判断还有没有下一页；nextCursor 是本页最后一行的 id，
 *   下一页以 Prisma cursor + skip:1 续上。
 * - model 是结构化鸭子类型：任何 Prisma delegate（或测试 fake）满足 findMany 即可。
 *   select/where 原样透传，调用方自己组装响应形状，本函数不碰接口契约。
 */
export interface PaginateOptions {
  readonly where?: unknown;
  readonly orderBy: unknown;
  readonly select?: unknown;
  readonly cursor?: string | null;
  readonly take?: number;
  readonly maxTake?: number;
}

export interface PaginateResult<Row> {
  readonly rows: Row[];
  readonly nextCursor: string | null;
}

export interface PaginateDelegate {
  // Prisma delegate 的 findMany 是带 SelectSubset 约束的泛型函数，参数类型无法用
  // 结构化类型精确表达；这里用 any 只框住「参数袋」这一个点，行类型由 Row 泛型管。
  // biome-ignore lint/suspicious/noExplicitAny: Prisma delegate 的参数袋无法结构化表达
  findMany(args: any): Promise<readonly unknown[]>;
}

const DEFAULT_TAKE = 50;
const DEFAULT_MAX_TAKE = 200;

/**
 * 给 orderBy 补 id 兜底排序：createdAt 这类字段不唯一，并列行在分页边界的
 * 先后由数据库随意决定，翻页就会重/漏。
 * - 已有有效的 id 排序（值是 asc/desc）时原样保留；
 * - id 键存在但值无效（如 undefined——Prisma 会直接忽略这一项，等于没排）
 *   时先剔除该键再补，避免「看起来排了 id 其实没排」的绕过；
 * - 方向跟随主排序字段（desc 列表的 id 也 desc，与列表直觉一致）。
 * 注意：补完后排序键是复合的——单页截断场景下，并列行的相对顺序从
 * 「数据库随意」变成「按 id 稳定」，这是有意的行为收紧而非形状变化。
 */
function withIdTiebreaker(orderBy: unknown): unknown {
  const isEntry = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const list = (Array.isArray(orderBy) ? [...orderBy] : [orderBy]) as unknown[];
  if (list.some((item) => isEntry(item) && (item.id === "asc" || item.id === "desc"))) return orderBy;
  const cleaned = list
    .map((item) => {
      if (!isEntry(item) || !("id" in item)) return item;
      const { id: _invalidId, ...rest } = item;
      return rest;
    })
    .filter((item) => !(isEntry(item) && Object.keys(item).length === 0));
  const first = cleaned[0] as Record<string, unknown> | undefined;
  const direction = first ? Object.values(first)[0] : undefined;
  return [...cleaned, { id: direction === "desc" ? "desc" : "asc" }];
}

/**
 * Row 由调用方按自己的 select 显式声明：Prisma delegate 的返回类型随 select
 * 变化、无法从 delegate 本身可靠推断，这里只保证「行里有 id」这一条分页契约。
 */
export async function paginate<Row extends { readonly id: string } = { readonly id: string }>(
  model: PaginateDelegate,
  options: PaginateOptions,
): Promise<PaginateResult<Row>> {
  if (!options.orderBy || (Array.isArray(options.orderBy) && options.orderBy.length === 0)) {
    throw new Error("paginate 必须显式传 orderBy：没有稳定排序的分页会重会漏");
  }
  const maxTakeRaw = Math.trunc(options.maxTake ?? DEFAULT_MAX_TAKE);
  const maxTake = Number.isFinite(maxTakeRaw) && maxTakeRaw >= 1 ? maxTakeRaw : DEFAULT_MAX_TAKE;
  const takeRaw = Math.trunc(options.take ?? DEFAULT_TAKE);
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), maxTake) : DEFAULT_TAKE;

  const args: Record<string, unknown> = { orderBy: withIdTiebreaker(options.orderBy), take: take + 1 };
  if (options.where !== undefined) args.where = options.where;
  if (options.select !== undefined) args.select = options.select;
  if (options.cursor) {
    args.cursor = { id: options.cursor };
    args.skip = 1;
  }
  const fetched = (await model.findMany(args)) as readonly Row[];
  const rows = fetched.slice(0, take);
  const nextCursor = fetched.length > take ? (rows.at(-1)?.id ?? null) : null;
  return { rows, nextCursor };
}
