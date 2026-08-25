import { Icon } from "@iconify/react";
import { useEffect, useRef, useState } from "react";
import {
  MEMORY_TYPE_ORDER,
  fallbackTitle,
  getMemoryTypeMeta,
  layoutMemoryNodes,
} from "../../memoryGalaxy";
import type { MemoryNode } from "../../memoryTypes";
import { MEMORY_TYPE_STYLES } from "./memoryStyles";

const ZOOM_LEVELS = [80, 100, 120, 140] as const;

function getNodeSizeClass(size: "sm" | "md" | "lg"): string {
  switch (size) {
    case "lg":
      return "h-40 w-40";
    case "md":
      return "h-32 w-32";
    case "sm":
      return "h-24 w-24";
    default: {
      const unreachable: never = size;
      return unreachable;
    }
  }
}

function getNodeTitleClass(size: "sm" | "md" | "lg"): string {
  switch (size) {
    case "lg":
      return "w-32 text-sm leading-5";
    case "md":
      return "w-28 text-[13px] leading-[18px]";
    case "sm":
      return "w-20 text-xs leading-4";
    default: {
      const unreachable: never = size;
      return unreachable;
    }
  }
}

interface MemoryGalaxyCanvasProps {
  readonly nodes: readonly MemoryNode[];
  readonly selectedId: string | null;
  readonly highlightedIds: readonly string[];
  readonly zoom: number;
  readonly onZoomChange: (zoom: number) => void;
  readonly onSelectNode: (id: string) => void;
  readonly loading: boolean;
  readonly error: string;
}

export default function MemoryGalaxyCanvas({
  nodes,
  selectedId,
  highlightedIds,
  zoom,
  onZoomChange,
  onSelectNode,
  loading,
  error,
}: MemoryGalaxyCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setContainerSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const laidOutNodes = layoutMemoryNodes(
    nodes,
    containerSize.width || 960,
    containerSize.height || 640,
  );

  const typeCounts = MEMORY_TYPE_ORDER.map((type) => ({
    type,
    count: nodes.filter((node) => node.type === type).length,
  })).filter((item) => item.count > 0);

  return (
    <section className="relative flex min-h-0 flex-1 overflow-hidden rounded-[14px] border border-hairline bg-surface">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,102,204,0.06),transparent_48%)]" />
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(148,163,184,0.28) 1px, transparent 0)",
          backgroundSize: "24px 24px",
        }}
      />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[38%] w-[38%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-hairline-subtle" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[58%] w-[58%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-hairline-subtle" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[78%] w-[78%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-hairline-subtle" />

      <div className="absolute left-4 right-4 top-4 z-10 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-wrap gap-2">
          {typeCounts.map(({ type, count }) => {
            const meta = getMemoryTypeMeta(type);
            const tone = MEMORY_TYPE_STYLES[type];
            return (
              <div
                key={type}
                className="inline-flex items-center gap-2 rounded-full border border-surface/80 bg-surface/90 px-3 py-1.5 text-xs text-ink-secondary backdrop-blur"
              >
                <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
                <span className="font-medium text-ink">{meta.label}</span>
                <span>{count}</span>
              </div>
            );
          })}
        </div>

        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-surface/80 bg-surface/90 p-1 backdrop-blur">
          {ZOOM_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => onZoomChange(level)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                zoom === level
                  ? "bg-brand text-white"
                  : "text-ink-secondary "
              }`}
            >
              {level}%
            </button>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="relative min-h-[520px] flex-1">
        {loading ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface/85">
            <div className="flex items-center gap-3 rounded-full border border-hairline-subtle bg-surface px-4 py-3 text-sm text-ink-secondary shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
              <Icon icon="mdi:loading" className="animate-spin text-lg text-brand" />
              正在编织记忆星河...
            </div>
          </div>
        ) : null}

        {!loading && error ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
            <div className="max-w-sm rounded-[14px] border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
              <div className="flex items-start gap-3">
                <Icon icon="mdi:alert-circle-outline" className="mt-0.5 text-xl" />
                <div>
                  <p className="font-medium">记忆星河加载失败</p>
                  <p className="mt-1 text-red-600/90">{error}</p>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {!loading && !error && nodes.length === 0 ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
            <div className="max-w-sm text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-brand">
                <Icon icon="mdi:atom-variant" className="text-2xl" />
              </div>
              <p className="text-lg font-semibold text-ink">你的星河还没有点亮</p>
              <p className="mt-2 text-sm leading-6 text-ink-secondary">
                开启长期记忆后，重要对话会沉淀成可检索、可编辑的长期节点。
              </p>
            </div>
          </div>
        ) : null}

        {!loading && !error
          ? laidOutNodes.map((node) => {
              const tone = MEMORY_TYPE_STYLES[node.type];
              const isSelected = node.id === selectedId;
              const isHighlighted = highlightedIds.includes(node.id);
              const scale = zoom / 100 * (isSelected ? 1.08 : isHighlighted ? 1.04 : 1);
              const displayTitle = fallbackTitle(node.title, node.text);

              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onSelectNode(node.id)}
                  className={`group absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border p-4 text-center transition duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                    getNodeSizeClass(node.size)
                  } ${tone.nodeRing} ${tone.nodeSurface} ${tone.nodeGlow} ${
                    isSelected
                      ? "z-20 border-brand ring-4 ring-brand/15"
                      : isHighlighted
                        ? "z-10 border-brand/70 ring-4 ring-brand/10"
                        : " "
                  }`}
                  style={{
                    left: node.x,
                    top: node.y,
                    transform: `translate(-50%, -50%) scale(${scale})`,
                  }}
                >
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-surface/80 text-base shadow-sm">
                    <Icon icon="mdi:star-four-points-circle-outline" />
                  </div>
                  <p
                    className={`mt-3 line-clamp-2 whitespace-normal text-center font-semibold text-ink [text-wrap:balance] ${getNodeTitleClass(node.size)}`}
                  >
                    {displayTitle}
                  </p>
                  <p className="mt-1 text-[11px] font-medium text-current/80">
                    {getMemoryTypeMeta(node.type).label}
                  </p>
                  {isHighlighted ? (
                    <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[10px] font-semibold text-brand">
                      <Icon icon="mdi:magnify-scan" className="text-xs" />
                      命中
                    </span>
                  ) : null}
                </button>
              );
            })
          : null}
      </div>
    </section>
  );
}
