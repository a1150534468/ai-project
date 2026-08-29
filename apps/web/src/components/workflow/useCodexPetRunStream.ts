/**
 * 桌宠运行的事件通道:先回放持久化事件,再挂 SSE,断线退化成轮询;另有一条 2.5 秒的兜底轮询
 * 同时刷 detail。从 `CodexPetStudio.tsx` 原样搬出。
 *
 * **两条通道必须都留着**。SSE 掉线在生产里是常态(网关 idle 超时、切网络),而桌宠一轮跑十几分钟;
 * 只留 SSE 会让进度永久停在断线那一刻,只留轮询则事件延迟到 2.5 秒粒度、工作台看着像卡住。
 *
 * 顺序上不能动的两处:
 *  - **先 `replayPersisted()` 再连流**。事件先落库后推送,先回放才能保证不丢在连上之前发生的事件;
 *    回放完如果 run 已终态就直接收尾,不再连一条注定立刻关闭的流。
 *  - `acceptEvents` 里对 `DETAIL_REFRESH_EVENTS` 的 160ms 去抖刷新:一批事件里多条都要求刷 detail 时
 *    只发一次请求。去掉去抖会在 job 完成的瞬间打出一串重复的 GET。
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { CodexPetEvent, CodexPetProjectDetail, CodexPetRun } from "../../codexPetApi";
import { CODEX_PET_POLL_MS, CODEX_PET_STREAM_RECONNECT_MS, mergeCodexPetEvents } from "./codexPetStudioModel";
import type { CodexPetStudioClient } from "./codexPetStudioClient";
import {
  DETAIL_REFRESH_EVENTS,
  TERMINAL_RUN_STATUSES,
  isAbortError,
  type CodexPetStreamState,
} from "./codexPetStudioFormat";

export interface CodexPetRunStreamInput {
  readonly client: CodexPetStudioClient;
  readonly token: string;
  readonly projectId: string | undefined;
  readonly run: CodexPetRun | null | undefined;
  readonly selectedProjectIdRef: MutableRefObject<string | null | undefined>;
  readonly detailRevisionRef: MutableRefObject<number>;
  readonly applyDetail: (next: CodexPetProjectDetail, hydrateDraft: boolean) => void;
  readonly refreshSelectedProject: (silent?: boolean) => Promise<CodexPetProjectDetail | null>;
}

export interface CodexPetRunStream {
  readonly events: readonly CodexPetEvent[];
  readonly streamState: CodexPetStreamState;
  readonly eventCursorRef: MutableRefObject<number>;
  /** 切换/新建/删除项目时把事件与游标一起清零——事件是按 run 编号的,跨项目复用会串号。 */
  readonly resetEvents: () => void;
}

export function useCodexPetRunStream({
  client,
  token,
  projectId,
  run,
  selectedProjectIdRef,
  detailRevisionRef,
  applyDetail,
  refreshSelectedProject,
}: CodexPetRunStreamInput): CodexPetRunStream {
  const [events, setEvents] = useState<readonly CodexPetEvent[]>([]);
  const [streamState, setStreamState] = useState<CodexPetStreamState>("idle");
  const eventCursorRef = useRef(0);

  const resetEvents = useCallback(() => {
    setEvents([]);
    eventCursorRef.current = 0;
  }, []);

  const runId = run?.id;
  const runStatus = run?.status;

  useEffect(() => {
    if (!projectId || !runId || !runStatus) {
      setEvents([]);
      eventCursorRef.current = 0;
      setStreamState("idle");
      return undefined;
    }

    let disposed = false;
    let reconnectTimer: number | undefined;
    let detailRefreshTimer: number | undefined;
    const controller = new AbortController();
    eventCursorRef.current = 0;
    setEvents([]);

    const acceptEvents = (incoming: readonly CodexPetEvent[]) => {
      if (disposed || incoming.length === 0) return;
      eventCursorRef.current = Math.max(eventCursorRef.current, ...incoming.map((event) => event.sequence));
      setEvents((current) => mergeCodexPetEvents(current, incoming));
      if (incoming.some((event) => DETAIL_REFRESH_EVENTS.has(event.type))) {
        if (detailRefreshTimer !== undefined) window.clearTimeout(detailRefreshTimer);
        detailRefreshTimer = window.setTimeout(() => { void refreshSelectedProject(true); }, 160);
      }
    };

    const replayPersisted = async () => {
      const replay = await client.listEvents(token, projectId, runId, eventCursorRef.current, controller.signal);
      acceptEvents(replay.events);
      eventCursorRef.current = Math.max(eventCursorRef.current, replay.cursor);
    };

    let reconnecting = false;
    const connect = async () => {
      if (disposed) return;
      setStreamState(reconnecting ? "reconnecting" : "connecting");
      try {
        await replayPersisted();
        if (disposed || TERMINAL_RUN_STATUSES.has(runStatus)) {
          if (!disposed) setStreamState("ended");
          return;
        }
        setStreamState("live");
        await client.streamEvents({
          token,
          projectId,
          runId,
          after: eventCursorRef.current,
          signal: controller.signal,
          onEvent: (event) => acceptEvents([event]),
        });
        if (disposed) return;
      } catch (streamError) {
        if (disposed || isAbortError(streamError)) return;
        setStreamState("polling");
      }
      reconnecting = true;
      reconnectTimer = window.setTimeout(() => { void connect(); }, CODEX_PET_STREAM_RECONNECT_MS);
    };

    void connect();
    return () => {
      disposed = true;
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (detailRefreshTimer !== undefined) window.clearTimeout(detailRefreshTimer);
    };
  }, [client, projectId, refreshSelectedProject, runId, runStatus, token]);

  useEffect(() => {
    if (!projectId || !runId || !runStatus || TERMINAL_RUN_STATUSES.has(runStatus)) return undefined;
    let disposed = false;
    const poll = async () => {
      const revision = detailRevisionRef.current;
      const [nextDetail, replay] = await Promise.allSettled([
        client.getProject(token, projectId),
        client.listEvents(token, projectId, runId, eventCursorRef.current),
      ]);
      if (disposed || selectedProjectIdRef.current !== projectId) return;
      if (nextDetail.status === "fulfilled" && detailRevisionRef.current === revision) applyDetail(nextDetail.value, false);
      if (replay.status === "fulfilled") {
        eventCursorRef.current = Math.max(eventCursorRef.current, replay.value.cursor);
        setEvents((current) => mergeCodexPetEvents(current, replay.value.events));
      }
    };
    const timer = window.setInterval(() => { void poll(); }, CODEX_PET_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [applyDetail, client, detailRevisionRef, projectId, runId, runStatus, selectedProjectIdRef, token]);

  return { events, streamState, eventCursorRef, resetEvents };
}
