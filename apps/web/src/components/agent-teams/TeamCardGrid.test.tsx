import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentTeamDto } from "../../agentTeamApi";
import { TeamCardGrid } from "./TeamCardGrid";

function makeTeam(overrides: Partial<AgentTeamDto> = {}): AgentTeamDto {
  return {
    id: "team-1",
    name: "授权书审查团队",
    description: "复用授权书风险识别和结论输出流程",
    mainAgentPrompt: "统筹授权书审查任务",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    members: [
      {
        id: "member-1",
        name: "法律合规专家",
        role: "Reviewer",
        responsibility: "识别授权范围风险",
        systemPrompt: "审查授权书风险。",
        skills: ["legal-review"],
        isCore: true,
        position: 0,
      },
    ],
    ...overrides,
  };
}

describe("TeamCardGrid", () => {
  it("renders a themed delete action with inline confirmation", () => {
    const html = renderToStaticMarkup(
      <TeamCardGrid
        teams={[makeTeam()]}
        selectedTeamId=""
        pendingDeleteTeamId="team-1"
        deletingTeamId={null}
        onSelectTeam={vi.fn()}
        onRequestDelete={vi.fn()}
        onConfirmDelete={vi.fn()}
        onCancelDelete={vi.fn()}
      />,
    );

    expect(html).toContain("删除团队");
    expect(html).toContain("确认删除");
    expect(html).toContain("历史任务会保留");
    expect(html).toContain("取消");
  });
});
