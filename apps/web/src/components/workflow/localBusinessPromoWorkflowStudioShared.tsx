import type { ReactNode } from "react";
import { Icon } from "@iconify/react";
import type { WorkflowAudioAsset } from "../../workflowLocalBusinessPromoApi";
import { formatLocalBusinessPromoTime } from "./localBusinessPromoWorkflowModel";

export function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="block">
      <p className="text-[12px] font-semibold text-ink-secondary">{label}</p>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

export function ControlGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-2 text-[12px] font-semibold text-ink-secondary">{label}</p>
      {children}
    </div>
  );
}

export function OptionGrid<T extends string | number>(props: {
  readonly options: readonly { value: T; label: string; description?: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly compact?: boolean;
}) {
  return (
    <div className={`grid gap-2 ${props.compact ? "grid-cols-3" : "grid-cols-1 sm:grid-cols-2"}`}>
      {props.options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => props.onChange(option.value)}
            className={`rounded-[10px] border px-3 py-2.5 text-left transition ${
              active ? "border-brand/40 bg-brand-soft text-brand-ink" : "border-hairline "
            }`}
          >
            <p className={`text-[12px] ${active ? "font-semibold" : "font-medium"} text-current`}>{option.label}</p>
            {!props.compact && option.description && <p className="mt-1 text-[11px] leading-5 text-ink-secondary">{option.description}</p>}
          </button>
        );
      })}
    </div>
  );
}

export function AudioAssetPanel(props: {
  readonly title: string;
  readonly asset: WorkflowAudioAsset | null;
  readonly emptyText: string;
  readonly className?: string;
}) {
  return (
    <div className={props.className}>
      <p className="text-[12px] font-semibold text-ink-secondary">{props.title}</p>
      {props.asset ? (
        <div className="mt-2 rounded-[10px] bg-surface-subtle p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[12px] font-semibold text-ink">{formatLocalBusinessPromoTime(props.asset.createdAt)}</p>
              <p className="text-[11px] text-ink-secondary">{props.asset.durationSec || 0} 秒 · {props.asset.format.toUpperCase()}</p>
            </div>
            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-ink-secondary">{props.asset.providerModel ?? props.asset.source}</span>
          </div>
          {props.asset.textContent && <p className="mt-2 line-clamp-3 text-[11px] leading-5 text-ink-secondary">{props.asset.textContent}</p>}
          <audio className="mt-3 w-full" controls src={props.asset.originalUrl} />
        </div>
      ) : (
        <p className="mt-2 rounded-[10px] border border-dashed border-hairline px-3 py-3 text-[12px] leading-5 text-ink-tertiary">{props.emptyText}</p>
      )}
    </div>
  );
}

export function AudioHistoryList(props: {
  readonly title: string;
  readonly assets: readonly WorkflowAudioAsset[];
  readonly activeAssetId: string | null;
  readonly emptyText: string;
  readonly actionLabel: string;
  readonly pendingKeyPrefix: string;
  readonly pendingKey: string;
  readonly className?: string;
  readonly gridClassName?: string;
  readonly onActivate: (assetId: string) => void;
}) {
  return (
    <div className={props.className}>
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-semibold text-ink-secondary">{props.title}</p>
        <span className="text-[11px] text-ink-tertiary">{props.assets.length} 条</span>
      </div>
      <div className={`mt-2 grid gap-2 ${props.gridClassName ?? ""}`}>
        {props.assets.length > 0 ? props.assets.map((asset) => {
          const active = asset.id === props.activeAssetId;
          const pending = props.pendingKey === `${props.pendingKeyPrefix}:${asset.id}`;
          return (
            <div key={asset.id} className={`rounded-[10px] border px-3 py-2 ${active ? "border-brand/30 bg-brand-soft" : "border-hairline-subtle bg-surface-subtle"}`}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[12px] font-semibold text-ink">{formatLocalBusinessPromoTime(asset.createdAt)}</p>
                  <p className="text-[11px] text-ink-secondary">{asset.durationSec || 0} 秒 · {asset.format.toUpperCase()}</p>
                </div>
                {active ? (
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-brand-ink">当前</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => props.onActivate(asset.id)}
                    disabled={pending}
                    className="inline-flex h-8 items-center gap-1 rounded-[8px] border border-hairline px-2.5 text-[11px] font-semibold text-ink disabled:opacity-50"
                  >
                    <Icon icon={pending ? "mdi:loading" : "mdi:check-circle-outline"} className={pending ? "animate-spin" : ""} aria-hidden />
                    {pending ? "切换中" : props.actionLabel}
                  </button>
                )}
              </div>
              {asset.textContent && <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-ink-secondary">{asset.textContent}</p>}
              <audio className="mt-2 w-full" controls src={asset.originalUrl} />
            </div>
          );
        }) : (
          <p className="rounded-[10px] border border-dashed border-hairline px-3 py-3 text-[12px] leading-5 text-ink-tertiary">{props.emptyText}</p>
        )}
      </div>
    </div>
  );
}
