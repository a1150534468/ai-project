import { Icon } from "@iconify/react";
import type { RecommendedAgentTeam } from "../../agentTeamApi";
import { RippleButton } from "../../motion";

interface TeamRecommendationPanelProps {
  readonly recommendation: RecommendedAgentTeam | null;
  readonly isConfirming: boolean;
  readonly onConfirm: () => void;
}

export function TeamRecommendationPanel({ recommendation, isConfirming, onConfirm }: TeamRecommendationPanelProps) {
  if (!recommendation) return null;
  return (
    <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-5">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-ink">等待确认</p>
          <h2 className="mt-1 text-lg font-semibold text-ink">{recommendation.teamName}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#6e6e73]">{recommendation.teamDescription}</p>
        </div>
        <RippleButton
          type="button"
          onClick={onConfirm}
          disabled={isConfirming}
          className="inline-flex h-10 w-full flex-none items-center justify-center gap-2 whitespace-nowrap rounded-[10px] bg-brand px-4 text-sm font-semibold text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-60 lg:w-auto"
        >
          <Icon icon={isConfirming ? "mdi:loading" : "mdi:check"} className={isConfirming ? "animate-spin" : ""} aria-hidden />
          确认团队并创建工作流
        </RippleButton>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {recommendation.members.map((member) => (
          <article key={member.name} className="rounded-[10px] border border-[#e8e8ed] p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 flex-none items-center justify-center rounded-[8px] bg-brand-soft text-brand-ink">
                <Icon icon="mdi:robot-outline" className="text-lg" aria-hidden />
              </div>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-ink">{member.name}</h3>
                <p className="mt-0.5 text-xs text-[#6e6e73]">{member.role}</p>
              </div>
            </div>
            <p className="mt-3 line-clamp-3 text-xs leading-5 text-[#424245]">{member.responsibility}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {member.skills.map((skill) => (
                <span key={skill} className="rounded-full bg-[#f7faf9] px-2 py-1 text-[11px] text-[#6e6e73]">
                  {skill}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
