import { Icon } from "@iconify/react";
import { motion } from "motion/react";
import type { AgentTeamDto } from "../../agentTeamApi";
import { spring, Stagger, StaggerItem } from "../../motion";

interface TeamCardGridProps {
  readonly teams: readonly AgentTeamDto[];
  readonly selectedTeamId: string;
  readonly pendingDeleteTeamId: string | null;
  readonly deletingTeamId: string | null;
  readonly onSelectTeam: (teamId: string) => void;
  readonly onRequestDelete: (teamId: string) => void;
  readonly onConfirmDelete: (teamId: string) => void;
  readonly onCancelDelete: () => void;
  readonly variant?: "grid" | "column";
}

export function TeamCardGrid({
  teams,
  selectedTeamId,
  pendingDeleteTeamId,
  deletingTeamId,
  onSelectTeam,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  variant = "grid",
}: TeamCardGridProps) {
  const gridClassName = variant === "column" ? "mt-4 grid gap-3" : "mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3";
  return (
    <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[#1d1d1f]">我的 Agent 团队</h2>
        <span className="text-xs text-[#6e6e73]">{teams.length} 个团队</span>
      </div>
      <Stagger className={gridClassName}>
        {teams.map((team) => {
          const selected = team.id === selectedTeamId;
          const pendingDelete = team.id === pendingDeleteTeamId;
          const deleting = team.id === deletingTeamId;
          return (
            <StaggerItem key={team.id}>
              <motion.article
                className={`rounded-[10px] border p-4 transition ${
                  selected ? "border-brand/50 bg-brand-soft" : "border-[#e8e8ed] bg-white"
                }`}
                whileHover={!selected ? { y: -5 } : undefined}
                transition={spring.snappy}
              >
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => onSelectTeam(selected ? "" : team.id)}
                  className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="truncate text-sm font-semibold text-[#1d1d1f]">{team.name}</h3>
                    <span className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-brand-ink">{team.members.length} 人</span>
                  </div>
                  <p className="mt-2 line-clamp-2 min-h-[40px] text-xs leading-5 text-[#6e6e73]">{team.description || "暂无描述"}</p>
                  <div className="mt-4 flex -space-x-2">
                    {team.members.slice(0, 5).map((member) => (
                      <span
                        key={member.name}
                        title={member.name}
                        className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-[#f5f5f7] text-[#6e6e73]"
                      >
                        <Icon icon="mdi:robot-outline" className="text-base" aria-hidden />
                      </span>
                    ))}
                  </div>
                </button>
                <button
                  type="button"
                  title="删除团队"
                  aria-label={`删除团队 ${team.name}`}
                  disabled={deleting}
                  onClick={() => onRequestDelete(team.id)}
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] border border-red-100 bg-white text-red-600 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Icon icon={deleting ? "mdi:loading" : "mdi:trash-can-outline"} className="text-base" aria-hidden />
                  <span className="sr-only">删除团队</span>
                </button>
              </div>
              {pendingDelete && (
                <div className="mt-4 rounded-[10px] border border-red-100 bg-red-50 p-3">
                  <p className="text-xs leading-5 text-red-700">确认删除该团队？历史任务会保留，但这个团队不能再复用。</p>
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={onCancelDelete}
                      disabled={deleting}
                      className="rounded-[8px] border border-[#d2d2d7] bg-white px-3 py-1.5 text-xs font-medium text-[#424245] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => onConfirmDelete(team.id)}
                      disabled={deleting}
                      className="rounded-[8px] bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {deleting ? "删除中" : "确认删除"}
                    </button>
                  </div>
                </div>
              )}
              </motion.article>
            </StaggerItem>
          );
        })}
        {teams.length === 0 && (
          <div className="rounded-[10px] border border-dashed border-[#d2d2d7] p-6 text-center text-sm text-[#6e6e73]">
            暂无可复用团队
          </div>
        )}
      </Stagger>
    </section>
  );
}
