import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

interface AssistantMessageActionsProps {
  readonly content: string;
}

const RESET_DELAY_MS = 1400;

function CopyGlyph() {
  return (
    <svg className="h-[17px] w-[17px]" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="8" y="7" width="10" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M6 16H5.5A2.5 2.5 0 0 1 3 13.5v-7A2.5 2.5 0 0 1 5.5 4h7A2.5 2.5 0 0 1 15 6.5V7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg className="h-[17px] w-[17px]" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.2 4L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function AlertGlyph() {
  return (
    <svg className="h-[17px] w-[17px]" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7.5v5.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <circle cx="12" cy="16.5" r="1" fill="currentColor" />
    </svg>
  );
}

function copyWithTextareaFallback(text: string): boolean {
  if (!document.body) return false;

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  previousFocus?.focus();
  return copied;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (!copyWithTextareaFallback(text)) {
    throw new Error("clipboard_copy_failed");
  }
}

export function AssistantMessageActions({ content }: AssistantMessageActionsProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<number | undefined>(undefined);
  const text = content.trim();

  useEffect(() => {
    setCopyState("idle");
  }, [content]);

  useEffect(() => () => {
    if (resetTimerRef.current !== undefined) {
      window.clearTimeout(resetTimerRef.current);
    }
  }, []);

  if (!text) return null;

  const scheduleStateReset = () => {
    if (resetTimerRef.current !== undefined) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      resetTimerRef.current = undefined;
    }, RESET_DELAY_MS);
  };

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(text);
      setCopyState("copied");
    } catch (error) {
      if (error instanceof Error) {
        console.warn("assistant message copy failed", error.message);
      } else {
        console.warn("assistant message copy failed", String(error));
      }
      setCopyState("failed");
    }
    scheduleStateReset();
  };

  const label = copyState === "copied" ? "已复制 AI 回复" : copyState === "failed" ? "复制失败，重试" : "复制 AI 回复";
  const colorClass = copyState === "copied"
    ? "text-brand"
    : copyState === "failed"
      ? "text-red-500"
      : "text-ink-secondary ";
  const glyph = copyState === "copied" ? <CheckGlyph /> : copyState === "failed" ? <AlertGlyph /> : <CopyGlyph />;

  return (
    <div className="mt-2 flex items-center gap-1">
      <button
        type="button"
        onClick={handleCopy}
        className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${colorClass}`}
        aria-label={label}
        title={label}
      >
        {glyph}
        <span className="sr-only">{label}</span>
      </button>
    </div>
  );
}
