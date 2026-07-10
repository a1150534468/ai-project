import type { MemoryType } from "../../memoryTypes";

type MemoryTypeStyle = {
  readonly nodeRing: string;
  readonly nodeGlow: string;
  readonly nodeSurface: string;
  readonly dot: string;
  readonly filterActive: string;
  readonly filterInactive: string;
  readonly editorActive: string;
  readonly editorIdle: string;
  readonly viewDot: string;
  readonly viewPill: string;
  readonly mobileAccent: string;
  readonly mobilePill: string;
};

export const MEMORY_TYPE_STYLES: Readonly<Record<MemoryType, MemoryTypeStyle>> = {
  CORE: {
    nodeRing: "border-amber-300/80 text-amber-700",
    nodeGlow: "shadow-[0_18px_44px_rgba(245,158,11,0.18)]",
    nodeSurface: "bg-[radial-gradient(circle_at_30%_30%,rgba(255,251,235,0.96),rgba(253,230,138,0.60))]",
    dot: "bg-amber-500",
    filterActive: "border-amber-300 bg-amber-50 text-amber-700",
    filterInactive: "border-white/70 bg-white/75 text-amber-700/80 hover:border-amber-200",
    editorActive: "border-amber-300 bg-amber-50 text-amber-700",
    editorIdle: "border-[#d2d2d7] bg-white text-[#6e6e73] hover:border-amber-200",
    viewDot: "bg-amber-500",
    viewPill: "bg-amber-50 text-amber-700",
    mobileAccent: "border-l-amber-400",
    mobilePill: "bg-amber-50 text-amber-700",
  },
  PERMANENT: {
    nodeRing: "border-sky-300/80 text-sky-700",
    nodeGlow: "shadow-[0_18px_44px_rgba(59,130,246,0.16)]",
    nodeSurface: "bg-[radial-gradient(circle_at_30%_30%,rgba(239,246,255,0.96),rgba(147,197,253,0.52))]",
    dot: "bg-sky-500",
    filterActive: "border-sky-300 bg-sky-50 text-sky-700",
    filterInactive: "border-white/70 bg-white/75 text-sky-700/80 hover:border-sky-200",
    editorActive: "border-sky-300 bg-sky-50 text-sky-700",
    editorIdle: "border-[#d2d2d7] bg-white text-[#6e6e73] hover:border-sky-200",
    viewDot: "bg-sky-500",
    viewPill: "bg-sky-50 text-sky-700",
    mobileAccent: "border-l-sky-400",
    mobilePill: "bg-sky-50 text-sky-700",
  },
  TEMPORARY: {
    nodeRing: "border-teal-300/80 text-teal-700",
    nodeGlow: "shadow-[0_18px_44px_rgba(20,184,166,0.16)]",
    nodeSurface: "bg-[radial-gradient(circle_at_30%_30%,rgba(240,253,250,0.96),rgba(94,234,212,0.48))]",
    dot: "bg-teal-500",
    filterActive: "border-teal-300 bg-teal-50 text-teal-700",
    filterInactive: "border-white/70 bg-white/75 text-teal-700/80 hover:border-teal-200",
    editorActive: "border-teal-300 bg-teal-50 text-teal-700",
    editorIdle: "border-[#d2d2d7] bg-white text-[#6e6e73] hover:border-teal-200",
    viewDot: "bg-teal-500",
    viewPill: "bg-teal-50 text-teal-700",
    mobileAccent: "border-l-teal-400",
    mobilePill: "bg-teal-50 text-teal-700",
  },
  KNOWLEDGE: {
    nodeRing: "border-violet-300/80 text-violet-700",
    nodeGlow: "shadow-[0_18px_44px_rgba(139,92,246,0.16)]",
    nodeSurface: "bg-[radial-gradient(circle_at_30%_30%,rgba(245,243,255,0.96),rgba(196,181,253,0.52))]",
    dot: "bg-violet-500",
    filterActive: "border-violet-300 bg-violet-50 text-violet-700",
    filterInactive: "border-white/70 bg-white/75 text-violet-700/80 hover:border-violet-200",
    editorActive: "border-violet-300 bg-violet-50 text-violet-700",
    editorIdle: "border-[#d2d2d7] bg-white text-[#6e6e73] hover:border-violet-200",
    viewDot: "bg-violet-500",
    viewPill: "bg-violet-50 text-violet-700",
    mobileAccent: "border-l-violet-400",
    mobilePill: "bg-violet-50 text-violet-700",
  },
  OTHER: {
    nodeRing: "border-slate-300/80 text-slate-700",
    nodeGlow: "shadow-[0_18px_44px_rgba(100,116,139,0.14)]",
    nodeSurface: "bg-[radial-gradient(circle_at_30%_30%,rgba(248,250,252,0.96),rgba(203,213,225,0.52))]",
    dot: "bg-slate-500",
    filterActive: "border-slate-300 bg-slate-100 text-slate-700",
    filterInactive: "border-white/70 bg-white/75 text-slate-600 hover:border-slate-200",
    editorActive: "border-slate-300 bg-slate-100 text-slate-700",
    editorIdle: "border-[#d2d2d7] bg-white text-[#6e6e73] hover:border-slate-200",
    viewDot: "bg-slate-500",
    viewPill: "bg-slate-100 text-slate-700",
    mobileAccent: "border-l-slate-400",
    mobilePill: "bg-slate-100 text-slate-700",
  },
};
