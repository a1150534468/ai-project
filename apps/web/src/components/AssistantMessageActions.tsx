import { useEffect, useState, type ReactNode } from "react";

/** 复制完给 1.4 秒的反馈，然后回到常态 */
const RESET_DELAY_MS = 1400;

type CopyState = "idle" | "copied" | "failed";

const GLYPH = "h-[17px] w-[17px]";

/** 三个图标共用一副画布：17px、24 格坐标系、只描边不填色。 */
function Glyph({ children }: { readonly children: ReactNode }) {
  return (
    <svg className={GLYPH} viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

/** 按钮的三种模样。图标在模块级建好，每次渲染不用重新造。 */
const LOOK: Record<CopyState, { readonly label: string; readonly tone: string; readonly glyph: ReactNode }> = {
  idle: {
    label: "复制 AI 回复",
    tone: "text-ink-secondary",
    glyph: (
      <Glyph>
        <rect x="8" y="7" width="10" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M6 16H5.5A2.5 2.5 0 0 1 3 13.5v-7A2.5 2.5 0 0 1 5.5 4h7A2.5 2.5 0 0 1 15 6.5V7"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      </Glyph>
    ),
  },
  copied: {
    label: "已复制 AI 回复",
    tone: "text-brand",
    glyph: (
      <Glyph>
        <path d="M5 12.5l4.2 4L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      </Glyph>
    ),
  },
  failed: {
    label: "复制失败，重试",
    tone: "text-danger-ink",
    glyph: (
      <Glyph>
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 7.5v5.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <circle cx="12" cy="16.5" r="1" fill="currentColor" />
      </Glyph>
    ),
  },
};

const BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";
/**
 * 没有 clipboard API 的场合（http 页面、老 Safari）退回到「塞一个看不见的 textarea 再 execCommand」。
 * 这条路要求元素真的在文档里且被选中，所以只能先插进去，用完立刻收走。
 */
function copyViaTextarea(text: string): boolean {
  if (!document.body) return false;

  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const carrier = document.createElement("textarea");
  carrier.value = text;
  carrier.setAttribute("readonly", "");
  carrier.style.position = "fixed";
  carrier.style.left = "-9999px";
  carrier.style.top = "0";
  document.body.appendChild(carrier);
  try {
    carrier.focus();
    carrier.select();
    return document.execCommand("copy");
  } finally {
    // 无论成没成都要拆掉，并把焦点还给原来那个元素
    carrier.remove();
    focused?.focus();
  }
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (!copyViaTextarea(text)) throw new Error("clipboard_copy_failed");
}

/** state 是模样，round 是第几次点 —— 连点两次同一结果也要重新计时，靠 round 让 effect 再跑一遍。 */
interface Flash {
  readonly state: CopyState;
  readonly round: number;
}

const CALM: Flash = { state: "idle", round: 0 };

interface AssistantMessageActionsProps {
  readonly content: string;
}

/** 助手消息下面那颗复制按钮。空消息（比如流还没吐字）不占位。 */
export function AssistantMessageActions({ content }: AssistantMessageActionsProps) {
  const [flash, setFlash] = useState<Flash>(CALM);
  const text = content.trim();

  // 换了一条消息，上一条的「已复制」不该留在这颗按钮上
  useEffect(() => setFlash(CALM), [content]);

  useEffect(() => {
    if (flash.state === "idle") return;
    const timer = window.setTimeout(() => setFlash(CALM), RESET_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  if (text === "") return null;

  const copy = async () => {
    let state: CopyState = "copied";
    try {
      await copyText(text);
    } catch (failure) {
      console.warn("assistant message copy failed", failure instanceof Error ? failure.message : String(failure));
      state = "failed";
    }
    setFlash((prev) => ({ state, round: prev.round + 1 }));
  };

  const look = LOOK[flash.state];

  return (
    <div className="mt-2 flex items-center gap-1">
      <button
        type="button"
        onClick={() => void copy()}
        className={`${BUTTON} ${look.tone}`}
        aria-label={look.label}
        title={look.label}
      >
        {look.glyph}
        <span className="sr-only">{look.label}</span>
      </button>
    </div>
  );
}
