import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { cx } from "../ui";
import { errorMessage } from "../../apiError";
import {
  createTranscriptionRequestId,
  deleteTranscriptionTask,
  getTranscriptionTask,
  listTranscriptionTasks,
  updateTranscriptionText,
  uploadTranscriptionAudio,
  type TranscriptionLanguage,
  type TranscriptionTask,
} from "../../api";
import { useToast } from "../../motion";
import {
  buildTranscriptionMarkdown,
  buildTranscriptionSrt,
  buildTranscriptionTxt,
  downloadTextFile,
  transcriptionExportBaseName,
} from "./transcriptionExport";

interface TranscriptionStudioProps {
  readonly token: string;
}

const LANGUAGE_OPTIONS: readonly { readonly value: TranscriptionLanguage; readonly label: string }[] = [
  { value: "zh-CN", label: "普通话" },
  { value: "yue", label: "粤语" },
  { value: "en", label: "英语" },
];

const LANGUAGE_LABEL: Record<TranscriptionLanguage, string> = {
  "zh-CN": "普通话",
  yue: "粤语",
  en: "英语",
};

const POLL_MS = 5000;
const ACCEPT = ".mp3,.wav,.m4a,.flac,.ogg,.aac";

function isActiveTask(task: TranscriptionTask): boolean {
  return task.status === "queued" || task.status === "running";
}

function statusLabel(task: TranscriptionTask): string {
  switch (task.status) {
    case "queued": return "排队中";
    case "running": return "转写中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    default: return task.status;
  }
}

export function TranscriptionStudio({ token }: TranscriptionStudioProps) {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tasks, setTasks] = useState<readonly TranscriptionTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [language, setLanguage] = useState<TranscriptionLanguage>("zh-CN");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** 同一时刻只允许一个列表请求在飞：轮询比响应还快时不该叠加请求。 */
  const refreshingRef = useRef(false);
  /** 上一条已经弹过的错误。后端持续不可用时，每 5 秒重弹同一条提示只会糊屏。 */
  const lastErrorRef = useRef<string | null>(null);

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId],
  );
  const hasActive = useMemo(() => tasks.some(isActiveTask), [tasks]);
  const draftDirty = selected?.transcriptText !== undefined && draft !== (selected?.transcriptText ?? "");

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const list = await listTranscriptionTasks(token);
      lastErrorRef.current = null;
      setTasks(list);
      // 用函数式更新读当前选中项，而不是把 selectedId 写进依赖：否则每切一次任务
      // `refresh` 就换一个引用，挂在这个回调上的 effect 会跟着重跑一遍。
      setSelectedId((current) => {
        if (current && list.some((task) => task.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch (error) {
      const message = errorMessage(error, "获取转写任务失败");
      if (lastErrorRef.current !== message) {
        lastErrorRef.current = message;
        toast.show("err", message);
      }
    } finally {
      refreshingRef.current = false;
    }
  }, [token, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, refresh]);

  useEffect(() => {
    setDraft(selected?.transcriptText ?? "");
  }, [selected?.id, selected?.transcriptText]);

  const submitFile = useCallback(async (file: File) => {
    if (uploading) return;
    setUploading(true);
    try {
      const task = await uploadTranscriptionAudio(token, file, createTranscriptionRequestId(), language);
      setTasks((current) => [task, ...current]);
      setSelectedId(task.id);
      toast.show("ok", "已提交转写任务");
    } catch (error) {
      toast.show("err", errorMessage(error, "上传音频失败"));
    } finally {
      setUploading(false);
    }
  }, [token, language, uploading, toast]);

  const onFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (file) void submitFile(file);
  }, [submitFile]);

  const onSave = useCallback(async () => {
    if (!selected || saving || !draftDirty) return;
    setSaving(true);
    try {
      const updated = await updateTranscriptionText(token, selected.id, draft);
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
      toast.show("ok", "文稿已保存");
    } catch (error) {
      toast.show("err", errorMessage(error, "保存文稿失败"));
    } finally {
      setSaving(false);
    }
  }, [token, selected, draft, draftDirty, saving, toast]);

  const onDelete = useCallback(async (task: TranscriptionTask) => {
    if (deletingId) return;
    setDeletingId(task.id);
    try {
      await deleteTranscriptionTask(token, task.id);
      setTasks((current) => current.filter((item) => item.id !== task.id));
      if (selectedId === task.id) setSelectedId(null);
      toast.show("ok", "任务已删除");
    } catch (error) {
      toast.show("err", errorMessage(error, "删除任务失败"));
    } finally {
      setDeletingId(null);
    }
  }, [token, selectedId, deletingId, toast]);

  const onExport = useCallback((kind: "txt" | "md" | "srt") => {
    if (!selected) return;
    const base = transcriptionExportBaseName(selected);
    if (kind === "txt") downloadTextFile(`${base}.txt`, buildTranscriptionTxt(selected));
    else if (kind === "md") downloadTextFile(`${base}.md`, buildTranscriptionMarkdown(selected), "text/markdown;charset=utf-8");
    else {
      const srt = buildTranscriptionSrt(selected);
      if (!srt) {
        toast.show("err", "该任务没有时间戳，无法导出字幕");
        return;
      }
      downloadTextFile(`${base}.srt`, srt);
    }
  }, [selected, toast]);

  const onRefreshOne = useCallback(async () => {
    if (!selected) return;
    try {
      const updated = await getTranscriptionTask(token, selected.id);
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
    } catch (error) {
      toast.show("err", errorMessage(error, "刷新失败"));
    }
  }, [token, selected, toast]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      {/* 左：上传 + 任务列表 */}
      <section className="flex w-full flex-col gap-3 lg:w-[340px] lg:flex-none">
        <div
          role="button"
          tabIndex={0}
          aria-label="上传音频文件"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click(); }}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); onFiles(event.dataTransfer.files); }}
          className={cx(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[14px] border-2 border-dashed p-8 text-center transition-colors",
            dragging ? "border-brand bg-brand-soft" : "border-hairline bg-surface hover:border-brand-ink",
          )}
        >
          <Icon icon="mdi:cloud-upload-outline" className="text-3xl text-ink-tertiary" aria-hidden />
          <p className="text-sm font-semibold text-ink">{uploading ? "上传中…" : "点击或拖拽上传音频"}</p>
          <p className="text-xs text-ink-secondary">mp3 / wav / m4a / flac / ogg / aac，单文件 60 分钟内</p>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => { onFiles(event.target.files); event.target.value = ""; }}
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <span className="flex-none">识别语言</span>
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value as TranscriptionLanguage)}
            className="min-w-0 flex-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {tasks.length === 0 && (
            <p className="rounded-[14px] border border-hairline-subtle bg-surface p-6 text-center text-sm text-ink-secondary">
              还没有转写任务，上传第一段录音试试
            </p>
          )}
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => setSelectedId(task.id)}
              className={cx(
                "flex items-center gap-3 rounded-[14px] border p-3 text-left transition-colors",
                task.id === selectedId ? "border-brand bg-brand-soft" : "border-hairline-subtle bg-surface hover:border-hairline",
              )}
            >
              <Icon icon="mdi:file-music-outline" className="flex-none text-xl text-ink-tertiary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink">{task.fileName}</span>
                <span className="mt-0.5 block text-xs text-ink-secondary">
                  {LANGUAGE_LABEL[task.language] ?? task.language} · {statusLabel(task)}
                  {task.status === "failed" && task.error ? ` · ${task.error}` : ""}
                </span>
              </span>
              {isActiveTask(task) && (
                <Icon icon="mdi:loading" className="flex-none animate-spin text-lg text-brand-ink" aria-hidden />
              )}
              <span
                role="button"
                tabIndex={0}
                aria-label={`删除 ${task.fileName}`}
                onClick={(event) => { event.stopPropagation(); void onDelete(task); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.stopPropagation(); void onDelete(task); } }}
                className="flex-none rounded p-1 text-ink-tertiary hover:bg-surface-muted hover:text-ink"
              >
                <Icon icon="mdi:delete-outline" className="text-lg" aria-hidden />
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* 右：文稿详情 */}
      <section className="flex min-h-0 flex-1 flex-col rounded-[14px] border border-hairline-subtle bg-surface p-4 lg:p-5">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-secondary">
            从左侧选择一个任务查看转写结果
          </div>
        ) : isActiveTask(selected) ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <Icon icon="mdi:loading" className="animate-spin text-3xl text-brand-ink" aria-hidden />
            <p className="text-sm font-semibold text-ink">{statusLabel(selected)}…</p>
            <p className="max-w-sm text-xs leading-5 text-ink-secondary">
              转写在云端进行中，长录音需要几分钟。你可以先去忙别的，回来刷新即可。
            </p>
            <button
              type="button"
              onClick={() => void onRefreshOne()}
              className="rounded-lg border border-hairline px-4 py-2 text-sm font-semibold text-ink hover:border-brand-ink"
            >
              立即刷新
            </button>
          </div>
        ) : selected.status === "failed" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <Icon icon="mdi:alert-circle-outline" className="text-3xl text-red-500" aria-hidden />
            <p className="text-sm font-semibold text-ink">转写失败</p>
            <p className="max-w-sm text-xs leading-5 text-ink-secondary">{selected.error ?? "未知错误"}</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-none flex-wrap items-center gap-2">
              <h2 className="mr-auto truncate text-base font-bold text-ink">{selected.fileName}</h2>
              <button
                type="button"
                onClick={() => onExport("txt")}
                className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-semibold text-ink hover:border-brand-ink"
              >
                导出 txt
              </button>
              <button
                type="button"
                onClick={() => onExport("md")}
                className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-semibold text-ink hover:border-brand-ink"
              >
                导出 md
              </button>
              <button
                type="button"
                onClick={() => onExport("srt")}
                disabled={!selected.segments || selected.segments.length === 0}
                className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-semibold text-ink hover:border-brand-ink disabled:opacity-40"
              >
                导出字幕 srt
              </button>
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={!draftDirty || saving}
                className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              >
                {saving ? "保存中…" : "保存修改"}
              </button>
            </div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="转写文稿"
              aria-label="转写文稿（可编辑）"
              className="min-h-0 flex-1 resize-none rounded-lg border border-hairline-subtle bg-surface-muted p-3 text-sm leading-7 text-ink"
            />
            {selected.segments && selected.segments.length > 0 && (
              <details className="mt-3 flex-none">
                <summary className="cursor-pointer text-xs font-semibold text-ink-secondary">
                  查看分段时间轴（{selected.segments.length} 段）
                </summary>
                <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs leading-5 text-ink-secondary">
                  {selected.segments.slice(0, 200).map((segment, index) => (
                    <li key={index}>
                      <span className="mr-2 font-mono text-brand-ink">
                        {new Date(segment.beginMs).toISOString().slice(14, 19)}
                      </span>
                      {segment.text}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
    </div>
  );
}
