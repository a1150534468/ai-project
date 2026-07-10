import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalBusinessPromoSettings } from "../../workflowLocalBusinessPromoApi";
import type { NarrationPreviewState } from "./localBusinessPromoWorkflowStudioModel";

export function useLocalBusinessPromoNarrationPreview(args: {
  readonly onPlaybackError: (message: string) => void;
}) {
  const { onPlaybackError } = args;
  const narrationPreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const presetNarrationPreviewUrlRef = useRef<Partial<Record<LocalBusinessPromoSettings["narrationVoice"], string>>>({});
  const [narrationPreviewState, setNarrationPreviewState] = useState<NarrationPreviewState>("idle");

  const stopNarrationPreviewPlayback = useCallback((nextState: Exclude<NarrationPreviewState, "loading"> = "ready") => {
    const audio = narrationPreviewAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.currentTime = 0;
      narrationPreviewAudioRef.current = null;
    }
    setNarrationPreviewState(nextState);
  }, []);

  const playNarrationPreviewUrl = useCallback(async (url: string) => {
    stopNarrationPreviewPlayback("idle");
    if (typeof Audio === "undefined") {
      setNarrationPreviewState("ready");
      return;
    }
    const audio = new Audio(url);
    audio.onended = () => {
      if (narrationPreviewAudioRef.current === audio) {
        narrationPreviewAudioRef.current = null;
        setNarrationPreviewState("ready");
      }
    };
    audio.onerror = () => {
      if (narrationPreviewAudioRef.current === audio) {
        narrationPreviewAudioRef.current = null;
        setNarrationPreviewState("ready");
        onPlaybackError("口播试听播放失败");
      }
    };
    narrationPreviewAudioRef.current = audio;
    await audio.play();
    setNarrationPreviewState("playing");
  }, [onPlaybackError, stopNarrationPreviewPlayback]);

  useEffect(() => () => {
    stopNarrationPreviewPlayback("idle");
  }, [stopNarrationPreviewPlayback]);

  return {
    presetNarrationPreviewUrlRef,
    narrationPreviewState,
    setNarrationPreviewState,
    stopNarrationPreviewPlayback,
    playNarrationPreviewUrl,
  };
}
