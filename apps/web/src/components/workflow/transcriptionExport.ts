import type { TranscriptionSegment, TranscriptionTask } from "../../api";

function pad2(value: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(2, "0");
}

function pad3(value: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(3, "0");
}

/** 毫秒 → SRT 时间戳 "00:01:23,456" */
export function formatSrtTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(ms % 1000)}`;
}

/** 毫秒 → "[01:23]" 短时间戳 */
export function formatShortTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  return `[${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}]`;
}

export function buildTranscriptionTxt(task: TranscriptionTask): string {
  return task.transcriptText ?? "";
}

export function buildTranscriptionMarkdown(task: TranscriptionTask): string {
  const lines = [`# ${task.fileName}`, ""];
  if (task.transcriptText) {
    lines.push(task.transcriptText, "");
  }
  if (task.segments && task.segments.length > 0) {
    lines.push("## 分段", "");
    for (const segment of task.segments) {
      lines.push(`${formatShortTimestamp(segment.beginMs)} ${segment.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function buildTranscriptionSrt(task: TranscriptionTask): string | null {
  const segments: readonly TranscriptionSegment[] | null = task.segments;
  if (!segments || segments.length === 0) return null;
  return segments
    .map((segment, index) =>
      `${index + 1}\n${formatSrtTimestamp(segment.beginMs)} --> ${formatSrtTimestamp(segment.endMs)}\n${segment.text}\n`,
    )
    .join("\n");
}

export function downloadTextFile(filename: string, content: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function transcriptionExportBaseName(task: TranscriptionTask): string {
  const withoutExt = task.fileName.replace(/\.[a-z0-9]+$/i, "");
  return withoutExt || task.requestId;
}
