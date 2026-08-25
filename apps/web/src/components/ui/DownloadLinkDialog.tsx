import { useState } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";

export interface DownloadDialogState {
  readonly title: string;
  readonly links: readonly string[];
  /** 覆盖默认操作说明（默认文案是针对图片的） */
  readonly description?: string;
  /** 醒目的时效/风险提示，如「链接 2 小时后失效，请尽快保存」 */
  readonly notice?: string;
}

export function DownloadLinkDialog({
  dialog,
  onClose,
}: {
  readonly dialog: DownloadDialogState;
  readonly onClose: () => void;
}) {
  const text = dialog.links.join("\n");

  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4">
      <section className="w-full max-w-[560px] rounded-[14px] border border-hairline-subtle bg-surface p-5 shadow-[0_20px_70px_rgba(15,23,42,0.18)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">{dialog.title}</h2>
            <p className="mt-1 text-sm leading-6 text-ink-secondary">
              {dialog.description ?? "复制链接到浏览器地址栏打开后保存原图。"}
            </p>
          </div>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-[9px] text-ink-secondary ">
            <Icon icon="mdi:close" aria-hidden />
          </button>
        </div>
        {dialog.notice && (
          <p className="mt-3 flex items-start gap-2 rounded-[10px] bg-warning/10 px-3 py-2 text-[13px] leading-6 text-warning-ink">
            <Icon icon="mdi:clock-alert-outline" className="mt-[3px] shrink-0 text-base" aria-hidden />
            <span>{dialog.notice}</span>
          </p>
        )}
        {dialog.links.length === 1 ? (
          <input
            readOnly
            value={text}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-4 h-11 w-full rounded-[10px] border border-hairline px-3 text-sm text-ink"
          />
        ) : (
          <textarea
            readOnly
            value={text}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-4 min-h-44 w-full resize-y rounded-[10px] border border-hairline p-3 text-sm leading-6 text-ink"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-[10px] border border-hairline px-4 text-sm font-semibold text-ink ">
            关闭
          </button>
          <RippleButton type="button" onClick={handleCopy} className="h-10 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white ">
            {copied ? "已复制" : "复制链接"}
          </RippleButton>
        </div>
      </section>
    </div>
  );
}
