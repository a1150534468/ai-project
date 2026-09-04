import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { cx } from "./cx";

export interface DownloadDialogState {
  readonly title: string;
  readonly links: readonly string[];
  /** 覆盖默认操作说明（默认文案是针对图片的） */
  readonly description?: string;
  /** 醒目的时效/风险提示，如「链接 2 小时后失效，请尽快保存」 */
  readonly notice?: string;
}

/*
 * 下载链接弹窗。产物走的是带签名的临时直链，不能塞进 <a download> 了事 ——
 * 用户得拿到链接本身（换设备打开、贴给别人、存进备忘录），所以这里只做两件事：
 * 把链接原文摊开给他看，再给一个复制键。
 */

const FIELD = "mt-4 w-full rounded-[10px] border border-hairline text-sm text-ink";
const COPIED_MS = 2000;

export function DownloadLinkDialog({
  dialog,
  onClose,
}: {
  readonly dialog: DownloadDialogState;
  readonly onClose: () => void;
}) {
  const text = dialog.links.join("\n");
  // 计数器而不是布尔：连点两次要重新计时，布尔的话第二次点不到状态变化、effect 不重跑
  const [copyCount, setCopyCount] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (copyCount === 0) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copyCount]);

  const copy = () => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setCopyCount((count) => count + 1);
  };

  // 单条链接一行放得下，多条得能滚 —— 同一份文本，两种容器
  const field =
    dialog.links.length === 1 ? (
      <input readOnly value={text} onFocus={selectAll} className={cx(FIELD, "h-11 px-3")} />
    ) : (
      <textarea readOnly value={text} onFocus={selectAll} className={cx(FIELD, "min-h-44 resize-y p-3 leading-6")} />
    );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim/30 px-4">
      <section className="w-full max-w-[560px] rounded-[14px] border border-hairline-subtle bg-surface p-5 shadow-[0_20px_70px_rgba(15,23,42,0.18)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">{dialog.title}</h2>
            <p className="mt-1 text-sm leading-6 text-ink-secondary">
              {dialog.description ?? "复制链接到浏览器地址栏打开后保存原图。"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-[9px] text-ink-secondary"
          >
            <Icon icon="mdi:close" aria-hidden />
          </button>
        </div>

        {dialog.notice && (
          <p className="mt-3 flex items-start gap-2 rounded-[10px] bg-warning/10 px-3 py-2 text-[13px] leading-6 text-warning-ink">
            <Icon icon="mdi:clock-alert-outline" className="mt-[3px] shrink-0 text-base" aria-hidden />
            <span>{dialog.notice}</span>
          </p>
        )}

        {field}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-[10px] border border-hairline px-4 text-sm font-semibold text-ink"
          >
            关闭
          </button>
          <RippleButton
            type="button"
            onClick={copy}
            className="h-10 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white"
          >
            {copied ? "已复制" : "复制链接"}
          </RippleButton>
        </div>
      </section>
    </div>
  );
}

/** 聚焦即全选：用户下一步十有八九是 Cmd+C。 */
function selectAll(event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) {
  event.currentTarget.select();
}
