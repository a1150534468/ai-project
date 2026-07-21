import type { MemoryNode, MemoryType } from "./memoryTypes";

export const MEMORY_TYPE_ORDER = [
  "CORE",
  "PERMANENT",
  "TEMPORARY",
  "KNOWLEDGE",
  "OTHER",
] as const satisfies readonly MemoryType[];

type MemoryTypeMeta = {
  readonly label: string;
  readonly colorClass: string;
};

export type MemoryNodeSize = "sm" | "md" | "lg";

export type PositionedMemoryNode = MemoryNode & {
  readonly x: number;
  readonly y: number;
  readonly size: MemoryNodeSize;
};

export type LayoutMemoryNode = PositionedMemoryNode;

const MEMORY_TYPE_META = {
  CORE: { label: "核心记忆", colorClass: "bg-amber-400/15 text-amber-200 ring-amber-300/40" },
  PERMANENT: { label: "常驻记忆", colorClass: "bg-blue-400/15 text-blue-200 ring-blue-300/40" },
  TEMPORARY: { label: "临时记忆", colorClass: "bg-brand/15 text-brand-ink ring-brand/30" },
  KNOWLEDGE: { label: "知识星云", colorClass: "bg-violet-400/15 text-violet-200 ring-violet-300/40" },
  OTHER: { label: "其他记忆", colorClass: "bg-gray-400/15 text-gray-200 ring-gray-300/40" },
} as const satisfies Record<MemoryType, MemoryTypeMeta>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hashString(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function normalizeLabelSource(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function truncateLabel(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 24)}...`;
}

function getMemoryNodeSize(importance: number): MemoryNodeSize {
  return importance >= 85 ? "lg" : importance >= 60 ? "md" : "sm";
}

function getSizeRadius(size: MemoryNodeSize, minDimension: number): number {
  switch (size) {
    case "lg":
      return clamp(minDimension * 0.04, 22, 28);
    case "md":
      return clamp(minDimension * 0.032, 17, 22);
    case "sm":
      return clamp(minDimension * 0.025, 13, 17);
    default: {
      const unreachable: never = size;
      return unreachable;
    }
  }
}

function getNodeCollisionGap(minDimension: number): number {
  return clamp(minDimension * 0.008, 4, 8);
}

function getCandidatePosition(
  baseX: number,
  baseY: number,
  safeWidth: number,
  safeHeight: number,
  sizeRadius: number,
  angle: number,
  radialOffset: number,
): { readonly x: number; readonly y: number } {
  return {
    x: clamp(baseX + Math.cos(angle) * radialOffset, sizeRadius, safeWidth - sizeRadius),
    y: clamp(baseY + Math.sin(angle) * radialOffset, sizeRadius, safeHeight - sizeRadius),
  };
}

function getCandidatePenalty(
  candidateX: number,
  candidateY: number,
  baseX: number,
  baseY: number,
  sizeRadius: number,
  minGap: number,
  placedNodes: readonly PositionedMemoryNode[],
  minDimension: number,
): number {
  let penalty = Math.hypot(candidateX - baseX, candidateY - baseY) / Math.max(minDimension, 1);

  for (const placedNode of placedNodes) {
    const dx = candidateX - placedNode.x;
    const dy = candidateY - placedNode.y;
    const distance = Math.hypot(dx, dy);
    const requiredDistance = sizeRadius + getSizeRadius(placedNode.size, minDimension) + minGap;
    const overlap = requiredDistance - distance;

    if (overlap > 0) {
      penalty += overlap * overlap * 10;
    }
  }

  return penalty;
}

export function getMemoryTypeMeta(type: MemoryType): MemoryTypeMeta {
  return MEMORY_TYPE_META[type];
}

export function fallbackTitle(title: string, text: string): string {
  const normalizedTitle = normalizeLabelSource(title);
  if (normalizedTitle) {
    return truncateLabel(normalizedTitle);
  }

  const normalizedText = normalizeLabelSource(text);
  if (normalizedText) {
    return truncateLabel(normalizedText);
  }

  return "未命名记忆";
}

export function layoutMemoryNodes(
  nodes: readonly MemoryNode[],
  width: number,
  height: number,
): readonly PositionedMemoryNode[] {
  const safeWidth = Number.isFinite(width) ? Math.max(width, 320) : 1280;
  const safeHeight = Number.isFinite(height) ? Math.max(height, 320) : 720;
  const minDimension = Math.min(safeWidth, safeHeight);
  const centerX = safeWidth / 2;
  const centerY = safeHeight / 2;
  const collisionGap = getNodeCollisionGap(minDimension);
  const typeCounts = new Map<MemoryType, number>();
  const typeIndexes = new Map<MemoryType, number>();

  const sortedNodes = [...nodes].sort((left, right) => {
    const typeDelta =
      MEMORY_TYPE_ORDER.indexOf(left.type) - MEMORY_TYPE_ORDER.indexOf(right.type);
    if (typeDelta !== 0) {
      return typeDelta;
    }

    return left.id.localeCompare(right.id);
  });

  for (const node of sortedNodes) {
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
  }

  const positioned = new Map<string, PositionedMemoryNode>();
  const placedNodes: PositionedMemoryNode[] = [];
  const candidateAngles = 18;
  const ringStep = clamp(minDimension * 0.055, 16, 30);
  const maxRings = Math.max(6, Math.ceil((minDimension * 0.42) / ringStep));

  for (const node of sortedNodes) {
    const typeIndex = MEMORY_TYPE_ORDER.indexOf(node.type);
    const typeTotal = typeCounts.get(node.type) ?? 1;
    const nodeIndex = typeIndexes.get(node.type) ?? 0;
    typeIndexes.set(node.type, nodeIndex + 1);

    const seed = hashString(`${node.id}:${node.type}:${node.importance}`);
    const normalizedImportance = clamp(node.importance, 1, 100);
    const size = getMemoryNodeSize(normalizedImportance);
    const sizeRadius = getSizeRadius(size, minDimension);
    const baseAngle = -Math.PI / 2 + (typeIndex / MEMORY_TYPE_ORDER.length) * Math.PI * 2;
    const angleSpread =
      typeTotal <= 1 ? 0 : ((nodeIndex / Math.max(typeTotal - 1, 1)) - 0.5) * 0.9;
    const angleJitter = (((seed & 1023) / 1023) - 0.5) * 0.22;
    const angle = baseAngle + angleSpread + angleJitter;

    const baseRadius = minDimension * (0.18 + typeIndex * 0.055);
    const importanceOffset = ((normalizedImportance - 50) / 50) * minDimension * 0.05;
    const radialJitter = ((((seed >>> 10) & 1023) / 1023) - 0.5) * minDimension * 0.08;
    const bandOffset =
      typeTotal <= 1 ? 0 : ((nodeIndex / Math.max(typeTotal - 1, 1)) - 0.5) * minDimension * 0.07;
    const orbitRadius = clamp(
      baseRadius + importanceOffset + radialJitter + bandOffset,
      sizeRadius,
      minDimension * 0.46,
    );

    const basePosition = getCandidatePosition(
      centerX,
      centerY,
      safeWidth,
      safeHeight,
      sizeRadius,
      angle,
      orbitRadius,
    );
    const seedAngleOffset = (((seed >>> 20) & 4095) / 4095) * Math.PI * 2;
    let bestCandidate = {
      x: basePosition.x,
      y: basePosition.y,
      penalty: Number.POSITIVE_INFINITY,
    };

    for (let ring = 0; ring <= maxRings; ring += 1) {
      const radialOffset = ring * ringStep;

      for (let angleIndex = 0; angleIndex < candidateAngles; angleIndex += 1) {
        const candidateAngle =
          angle
          + seedAngleOffset
          + (angleIndex / candidateAngles) * Math.PI * 2
          + ring * 0.17;
        const candidate = getCandidatePosition(
          basePosition.x,
          basePosition.y,
          safeWidth,
          safeHeight,
          sizeRadius,
          candidateAngle,
          radialOffset,
        );
        const penalty = getCandidatePenalty(
          candidate.x,
          candidate.y,
          basePosition.x,
          basePosition.y,
          sizeRadius,
          collisionGap,
          placedNodes,
          minDimension,
        );

        if (penalty < bestCandidate.penalty) {
          bestCandidate = { x: candidate.x, y: candidate.y, penalty };
        }

        if (penalty === 0) {
          break;
        }
      }

      if (bestCandidate.penalty === 0) {
        break;
      }
    }

    const positionedNode: PositionedMemoryNode = {
      ...node,
      x: bestCandidate.x,
      y: bestCandidate.y,
      size,
    };

    positioned.set(node.id, positionedNode);
    placedNodes.push(positionedNode);
  }

  return nodes.map((node) => {
    const layoutNode = positioned.get(node.id);
    if (layoutNode) {
      return layoutNode;
    }

    return {
      ...node,
      x: centerX,
      y: centerY,
      size: getMemoryNodeSize(clamp(node.importance, 1, 100)),
    };
  });
}
