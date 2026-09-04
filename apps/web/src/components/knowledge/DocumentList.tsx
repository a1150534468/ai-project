/**
 * 当前库的文档清单。状态徽标与体积文案都走 `kbDocumentMeta`，跟后台那张表同源 ——
 * 原来这里是四个并排的 `status === "…" && "文案"`，落在名单外的状态整个徽标只剩个图标，
 * 看着像卡住了。
 */
import { Icon } from "@iconify/react";
import type { KbDocument } from "../../kbApi";
import { Alert, Badge, cx } from "../ui";
import { formatBytes, kbStatusMeta } from "./kbDocumentMeta";

/** 一行元信息里那几个小项，只有取值方式不同。 */
const FACTS: readonly { readonly icon: string; readonly read: (doc: KbDocument) => string }[] = [
  { icon: "mdi:file-document", read: (doc) => formatBytes(doc.sizeBytes) },
  { icon: "mdi:layers", read: (doc) => `已链接晶格数量：${doc.chunkCount}` },
  { icon: "mdi:clock-outline", read: (doc) => new Date(doc.createdAt).toLocaleDateString("zh-CN") },
];

const DELETE =
  "inline-flex h-8 flex-none items-center gap-1 rounded-[10px] border border-danger/20 bg-surface px-2.5 text-xs font-medium text-danger-ink transition-colors hover:bg-danger/10 disabled:opacity-50";

export interface DocumentListProps {
  readonly documents: readonly KbDocument[];
  readonly deleting: boolean;
  readonly onDelete: (doc: KbDocument) => void;
}

export default function DocumentList({ documents, deleting, onDelete }: DocumentListProps) {
  if (documents.length === 0) return <p className="py-8 text-center text-sm text-ink-secondary">暂无文档</p>;

  return (
    <ul className="max-h-96 space-y-3 overflow-y-auto">
      {documents.map((doc) => {
        const meta = kbStatusMeta(doc.status);

        return (
          <li key={doc.id} className="space-y-3 rounded-lg border border-hairline-subtle bg-surface-subtle p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{doc.name}</p>
                <Badge tone={meta.tone} size="md" className="mt-2 font-semibold">
                  <Icon icon={meta.icon} className={cx("text-sm", meta.spin && "animate-spin")} aria-hidden />
                  {meta.label}
                </Badge>
              </div>
              {/* 名字进 aria-label：一列「删除」按钮读起来全都一样，光靠可见文案分不出删的是哪篇 */}
              <button
                type="button"
                aria-label={`删除文档 ${doc.name}`}
                disabled={deleting}
                onClick={() => onDelete(doc)}
                className={DELETE}
              >
                <Icon icon="mdi:trash-outline" className="text-base" aria-hidden />
                删除
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-secondary">
              {FACTS.map((fact) => (
                <span key={fact.icon} className="flex items-center gap-1">
                  <Icon icon={fact.icon} className="text-sm" aria-hidden />
                  {fact.read(doc)}
                </span>
              ))}
              {doc.sourceUri && (
                <a href={doc.sourceUri} target="_blank" rel="noreferrer" className="font-medium text-brand-ink">
                  打开产物
                </a>
              )}
            </div>

            {doc.error && (
              <Alert tone="danger" size="sm">
                错误: {doc.error}
              </Alert>
            )}
          </li>
        );
      })}
    </ul>
  );
}
