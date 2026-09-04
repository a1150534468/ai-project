import type { MemoryNode, MemoryType } from "./memoryTypes";

/**
 * 记忆星河的布局：给一批记忆算出画布坐标与大小档位。四条硬要求 ——
 * 同一批数据每次算出同一个结果（否则每次渲染都在跳）、同类记忆聚在同一个方位、
 * 越重要的越大越靠外、节点之间不许叠在一起。
 */

/** 既是筛选栏的展示顺序，也是布局的方位顺序（第 n 类占第 n 个方位），不能随手调。 */
export const MEMORY_TYPE_ORDER = ["CORE", "PERMANENT", "TEMPORARY", "KNOWLEDGE", "OTHER"] as const satisfies readonly MemoryType[];

/**
 * 只放文案。类别颜色的唯一来源是 components/memory/memoryStyles.ts，
 * 规范见 docs/design-system.md 的 Memory Semantic Palette。
 */
const MEMORY_TYPE_LABEL = {
  CORE: "核心记忆",
  PERMANENT: "常驻记忆",
  TEMPORARY: "临时记忆",
  KNOWLEDGE: "知识星云",
  OTHER: "其他记忆",
} as const satisfies Record<MemoryType, string>;

export function getMemoryTypeMeta(type: MemoryType): { readonly label: string } {
  return { label: MEMORY_TYPE_LABEL[type] };
}

/** 节点上的名字最多显示这么多字，超了截断加省略号。 */
const TITLE_LIMIT = 24;

/**
 * 标题为空就退回正文，两边都空才给占位名。记忆文本常是从聊天里截来的，
 * 全角空格与换行都可能混进来，所以先 NFKC 归一、再把连续空白折成一个。
 */
export function fallbackTitle(title: string, text: string): string {
  for (const source of [title, text]) {
    const compact = source.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (compact === "") continue;
    return compact.length <= TITLE_LIMIT ? compact : `${compact.slice(0, TITLE_LIMIT)}...`;
  }

  return "未命名记忆";
}

export type MemoryNodeSize = "sm" | "md" | "lg";

export type PositionedMemoryNode = MemoryNode & {
  readonly x: number;
  readonly y: number;
  readonly size: MemoryNodeSize;
};

/**
 * 三档大小。进哪档看 importance（`from` 是下界），档位对应的半径按画布短边缩放，
 * 但夹在 min/max 之间：手机上不能小到点不着，大屏上也不该胀成一个球。
 */
const SIZE_BANDS = {
  lg: { from: 85, scale: 0.04, min: 22, max: 28 },
  md: { from: 60, scale: 0.032, min: 17, max: 22 },
  sm: { from: 0, scale: 0.025, min: 13, max: 17 },
} as const satisfies Record<MemoryNodeSize, { from: number; scale: number; min: number; max: number }>;

/** 从大到小试，第一个够格的档位就是它 —— 顺序在这儿，阈值在表里，改阈值不用碰逻辑。 */
const SIZES_DESC = ["lg", "md", "sm"] as const satisfies readonly MemoryNodeSize[];

/** 重叠罚分的权重，远大于「偏离理想位」那一项：只要挪得开就一定不叠。 */
const OVERLAP_WEIGHT = 10;

/** 让位时每圈试几个方向。 */
const DETOUR_DIRECTIONS = 18;

const TAU = Math.PI * 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sizeOf(importance: number): MemoryNodeSize {
  // importance 是 NaN 时一档都够不上，`??` 让它落进最小档
  return SIZES_DESC.find((size) => importance >= SIZE_BANDS[size].from) ?? "sm";
}

function radiusOf(size: MemoryNodeSize, minDimension: number): number {
  const band = SIZE_BANDS[size];
  return clamp(minDimension * band.scale, band.min, band.max);
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** 避让只认「圆心 + 半径」，跟记忆内容无关。 */
interface Disc extends Point {
  readonly radius: number;
}

/**
 * 画布尺寸推导出来的一套标尺，一次算好往下传，省得每个几何函数都收七八个裸数字。
 * 半径、间距、让位步长一律按短边取：窄屏上才不会把节点挤到边框外面去。
 */
interface Frame {
  readonly width: number;
  readonly height: number;
  readonly min: number;
  readonly center: Point;
  /** 两个节点边缘之间至少留的空隙。 */
  readonly gap: number;
  /** 让位时每圈往外挪多少、最多挪几圈。 */
  readonly ringStep: number;
  readonly rings: number;
}

function frameOf(width: number, height: number): Frame {
  // 容器还没量出来（NaN）就按桌面尺寸垫一下；量出来了也至少按 320 算，免得半径超过画布
  const safeWidth = Number.isFinite(width) ? Math.max(width, 320) : 1280;
  const safeHeight = Number.isFinite(height) ? Math.max(height, 320) : 720;
  const min = Math.min(safeWidth, safeHeight);
  const ringStep = clamp(min * 0.055, 16, 30);

  return {
    width: safeWidth,
    height: safeHeight,
    min,
    center: { x: safeWidth / 2, y: safeHeight / 2 },
    gap: clamp(min * 0.008, 4, 8),
    // 最外圈够绕到半个画布，再少就会在挤的时候找不到空地
    rings: Math.max(6, Math.ceil((min * 0.42) / ringStep)),
    ringStep,
  };
}

/**
 * FNV-1a。三个抖动量全从它派生，所以同一条记忆每次都落在同一个点上 ——
 * 布局的稳定性就靠这个（测试直接压这一条）。
 */
function hash(value: string): number {
  let acc = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    acc = Math.imul(acc ^ value.charCodeAt(index), 16777619);
  }

  return acc >>> 0;
}

/** 从 hash 里切一段位当 [0, 1] 的随机数用；同一段每次切出同一个值。 */
function bits(seed: number, shift: number, mask: number): number {
  return ((seed >>> shift) & mask) / mask;
}

/** 从 `from` 出发按极坐标落一个点，并保证整个圆都在画布里（圆心离边至少一个半径）。 */
function project(from: Point, radius: number, angle: number, distance: number, frame: Frame): Point {
  return {
    x: clamp(from.x + Math.cos(angle) * distance, radius, frame.width - radius),
    y: clamp(from.y + Math.sin(angle) * distance, radius, frame.height - radius),
  };
}

/**
 * 候选位的代价：离理想位越远越亏（按短边归一，跟画布尺寸脱钩），压在已放好的节点上
 * 则按重叠深度**平方**重罚 —— 平方是为了让「一处压很深」比「两处各挨一点」更亏，
 * 挤的时候优先把深的那处解开。0 分表示这个位置完全干净。
 */
function penaltyAt(candidate: Point, ideal: Point, radius: number, taken: readonly Disc[], frame: Frame): number {
  let penalty = Math.hypot(candidate.x - ideal.x, candidate.y - ideal.y) / frame.min;

  for (const disc of taken) {
    const overlap = radius + disc.radius + frame.gap - Math.hypot(candidate.x - disc.x, candidate.y - disc.y);
    if (overlap > 0) penalty += overlap * overlap * OVERLAP_WEIGHT;
  }

  return penalty;
}

/**
 * 让位路线：以理想位为圆心一圈圈往外找空地，每圈 18 个方向，第 0 圈就是理想位本身。
 * 起始方向按 seed 转一下、每圈再拧 0.17 rad，否则同一圈的节点会全朝同一边挪、挤成一条线。
 */
function* detours(ideal: Point, radius: number, angle: number, seed: number, frame: Frame): Generator<Point> {
  const start = angle + bits(seed, 20, 4095) * TAU;

  for (let ring = 0; ring <= frame.rings; ring += 1) {
    for (let step = 0; step < DETOUR_DIRECTIONS; step += 1) {
      const heading = start + (step / DETOUR_DIRECTIONS) * TAU + ring * 0.17;
      yield project(ideal, radius, heading, ring * frame.ringStep, frame);
    }
  }
}

interface TypeGroup {
  readonly type: MemoryType;
  readonly nodes: readonly MemoryNode[];
}

/**
 * 布局顺序只由数据决定（先类别、同类按 id 排），这样入参顺序换了位置也不变。
 * 排完同类必然连在一起，顺手切成组 —— 组内的「第几个 / 共几个」正是扇形展开要用的。
 */
function groupByType(nodes: readonly MemoryNode[]): readonly TypeGroup[] {
  const ordered = [...nodes].sort(
    (left, right) =>
      MEMORY_TYPE_ORDER.indexOf(left.type) - MEMORY_TYPE_ORDER.indexOf(right.type) || left.id.localeCompare(right.id),
  );

  const groups: { type: MemoryType; nodes: MemoryNode[] }[] = [];
  for (const node of ordered) {
    const current = groups.at(-1);
    if (current?.type === node.type) current.nodes.push(node);
    else groups.push({ type: node.type, nodes: [node] });
  }

  return groups;
}

export function layoutMemoryNodes(
  nodes: readonly MemoryNode[],
  width: number,
  height: number,
): readonly PositionedMemoryNode[] {
  const frame = frameOf(width, height);
  const placed = new Map<string, PositionedMemoryNode>();
  const taken: Disc[] = [];

  for (const group of groupByType(nodes)) {
    const typeIndex = MEMORY_TYPE_ORDER.indexOf(group.type);
    const peers = group.nodes;

    for (const [indexInType, node] of peers.entries()) {
      const seed = hash(`${node.id}:${node.type}:${node.importance}`);
      const importance = clamp(node.importance, 1, 100);
      const size = sizeOf(importance);
      const radius = radiusOf(size, frame.min);
      // 同类节点在自己那个方位上摊开：[-0.5, 0.5]，独苗居中
      const spread = peers.length <= 1 ? 0 : indexInType / (peers.length - 1) - 0.5;

      const angle =
        -Math.PI / 2 // 12 点方向起
        + (typeIndex / MEMORY_TYPE_ORDER.length) * TAU // 每类记忆占一个方位
        + spread * 0.9 // 同类之间扇开
        + (bits(seed, 0, 1023) - 0.5) * 0.22; // 再抖一下，别排成一把尺子
      const distance = clamp(
        frame.min * (0.18 + typeIndex * 0.055) // 越靠后的类别轨道越外
          + ((importance - 50) / 50) * frame.min * 0.05 // 越重要越往外
          + (bits(seed, 10, 1023) - 0.5) * frame.min * 0.08
          + spread * frame.min * 0.07, // 同类之间也拉开点径向差，免得贴在同一条弧上
        radius,
        frame.min * 0.46,
      );

      // 理想位可能已经被占了，就沿让位路线找罚分最低的那个点（同分取先遇到的）
      const ideal = project(frame.center, radius, angle, distance, frame);
      let best: { readonly at: Point; readonly penalty: number } | null = null;
      for (const candidate of detours(ideal, radius, angle, seed, frame)) {
        const penalty = penaltyAt(candidate, ideal, radius, taken, frame);
        if (best === null || penalty < best.penalty) best = { at: candidate, penalty };
        if (penalty === 0) break; // 干净的位置，不用再往外找
      }
      const at = best?.at ?? ideal;

      placed.set(node.id, { ...node, x: at.x, y: at.y, size });
      taken.push({ x: at.x, y: at.y, radius });
    }
  }

  // 输出保持入参顺序，布局顺序只用来决定谁先占位。每个 id 上面都写过了，`??` 只是收个类型的尾
  return nodes.map(
    (node) =>
      placed.get(node.id) ?? { ...node, ...frame.center, size: sizeOf(clamp(node.importance, 1, 100)) },
  );
}

