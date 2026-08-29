/**
 * 生成中的两个视觉提示,从 `pages/Chat.tsx` 原样搬出:
 *  - `StreamingCaret`:接在正在输出的助手消息末尾,让用户确认「还在写」而不是卡死。
 *  - `TypingIndicator`:助手还没吐出第一个字时占位的三点跳动。
 *
 * 两者都尊重 `useReducedMotion()`:用户在系统里关了动效就不再闪烁 / 跳动。
 */
import { motion, useReducedMotion } from "motion/react";
import { AgentAvatar } from "../AgentAvatar";
import { msgIn } from "../../motion";

export function StreamingCaret() {
  const reduced = useReducedMotion();
  return (
    <motion.span
      aria-label="正在生成"
      className="ml-0.5 inline-block h-[1.05em] w-[3px] translate-y-[2px] rounded-full bg-brand align-baseline"
      animate={reduced ? undefined : { opacity: [1, 0.15, 1] }}
      transition={reduced ? undefined : { duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

export function TypingIndicator({ agentIcon, agentAvatarSvg, agentAvatarUrl, agentName }: {
  agentIcon: string;
  agentAvatarSvg?: string | null;
  agentAvatarUrl?: string | null;
  agentName: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      variants={msgIn}
      initial="initial"
      animate="animate"
      exit={{ opacity: 0, y: 10, scale: 0.95 }}
      className="flex items-start space-x-3"
    >
      <AgentAvatar avatarUrl={agentAvatarUrl} avatarSvg={agentAvatarSvg} icon={agentIcon} size={40} name={agentName} />
      <div className="rounded-2xl rounded-tl-none p-4 bg-surface-subtle border border-hairline-subtle">
        <div className="flex space-x-1">
          <motion.span
            className="w-2 h-2 bg-ink-tertiary rounded-full"
            animate={reduced ? undefined : { y: [0, -3, 0] }}
            transition={reduced ? undefined : { duration: 0.6, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.span
            className="w-2 h-2 bg-ink-tertiary rounded-full"
            animate={reduced ? undefined : { y: [0, -3, 0] }}
            transition={reduced ? undefined : { duration: 0.6, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
          />
          <motion.span
            className="w-2 h-2 bg-ink-tertiary rounded-full"
            animate={reduced ? undefined : { y: [0, -3, 0] }}
            transition={reduced ? undefined : { duration: 0.6, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
          />
        </div>
      </div>
    </motion.div>
  );
}
