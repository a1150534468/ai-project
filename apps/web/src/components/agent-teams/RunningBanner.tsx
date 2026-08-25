import { Icon } from "@iconify/react";
import { motion } from "motion/react";

const RUNNING_STATUSES = new Set(["team_confirmed", "planning", "running"]);

interface RunningBannerProps {
  /** 正在提交（生成推荐团队 / 创建工作流）中。 */
  readonly isSubmitting: boolean;
  /** 当前运行状态，用于区分规划中 / 执行中。 */
  readonly runStatus?: string | null;
}

function bannerCopy(isSubmitting: boolean, runStatus?: string | null): { title: string; subtitle: string } | null {
  if (isSubmitting) {
    return { title: "正在启动任务…", subtitle: "正在生成 Agent 团队并创建工作流，请稍候" };
  }
  if (runStatus && RUNNING_STATUSES.has(runStatus)) {
    if (runStatus === "running") {
      return { title: "Agent 团队执行中…", subtitle: "团队成员正在协作完成任务，界面每几秒自动刷新进度" };
    }
    return { title: "正在规划工作流…", subtitle: "已确认团队，正在拆解任务步骤，请稍候" };
  }
  return null;
}

/**
 * 醒目的执行中横幅：点击开始执行后到工作流跑完期间持续显示，
 * 用不断流动的进度条与脉冲动画告诉用户「正在执行中」，避免误以为卡死。
 */
export function RunningBanner({ isSubmitting, runStatus }: RunningBannerProps) {
  const copy = bannerCopy(isSubmitting, runStatus);
  if (!copy) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="overflow-hidden rounded-[14px] border border-brand/25 bg-brand-soft"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-4 px-5 py-4">
        <span className="relative flex h-11 w-11 flex-none items-center justify-center">
          <motion.span
            className="absolute inset-0 rounded-full bg-brand/20"
            animate={{ scale: [1, 1.35, 1], opacity: [0.6, 0, 0.6] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
          <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-brand/10 text-brand">
            <Icon icon="mdi:loading" className="animate-spin text-2xl" aria-hidden />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-brand-ink">{copy.title}</p>
          <p className="mt-0.5 truncate text-xs text-ink-secondary">{copy.subtitle}</p>
        </div>
      </div>
      <div className="h-1 w-full overflow-hidden bg-brand/10">
        <motion.div
          className="h-full w-1/3 rounded-full bg-brand"
          animate={{ x: ["-100%", "300%"] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    </motion.section>
  );
}
