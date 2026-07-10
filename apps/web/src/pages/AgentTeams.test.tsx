// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTeamDto, AgentWorkflowRunDto } from "../agentTeamApi";
import { AGENT_TEAM_ACTIVE_RUN_STORAGE_KEY } from "../agentTeamRunState";
import AgentTeams from "./AgentTeams";

const apiMocks = vi.hoisted(() => ({
  listKb: vi.fn(async () => []),
  listModels: vi.fn(async () => []),
}));

const agentTeamApiMocks = vi.hoisted(() => ({
  cancelAgentWorkflowRun: vi.fn(),
  confirmAgentTeam: vi.fn(),
  createRunFromAgentTeam: vi.fn(),
  getAgentWorkflowRun: vi.fn(),
  listAgentWorkflowRuns: vi.fn(),
  listAgentTeams: vi.fn(),
  recommendAgentTeam: vi.fn(),
}));

vi.mock("../api", () => ({
  listKb: apiMocks.listKb,
  listModels: apiMocks.listModels,
}));

vi.mock("../agentTeamApi", () => ({
  cancelAgentWorkflowRun: agentTeamApiMocks.cancelAgentWorkflowRun,
  confirmAgentTeam: agentTeamApiMocks.confirmAgentTeam,
  createRunFromAgentTeam: agentTeamApiMocks.createRunFromAgentTeam,
  getAgentWorkflowRun: agentTeamApiMocks.getAgentWorkflowRun,
  listAgentWorkflowRuns: agentTeamApiMocks.listAgentWorkflowRuns,
  listAgentTeams: agentTeamApiMocks.listAgentTeams,
  recommendAgentTeam: agentTeamApiMocks.recommendAgentTeam,
}));

function makeRun(overrides: Partial<AgentWorkflowRunDto> = {}): AgentWorkflowRunDto {
  return {
    id: "run-1",
    teamId: "team-1",
    taskGoal: "审查这个授权书靠谱不靠谱",
    status: "succeeded",
    teamSnapshot: {},
    planSnapshot: {},
    finalReport: "# 结论\n\n授权书需要补齐授权范围后再使用。\n\n".repeat(40),
    error: null,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:10:00.000Z",
    completedAt: "2026-07-03T00:10:00.000Z",
    cancelledAt: null,
    steps: [],
    events: [],
    ...overrides,
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForText(container: Element, text: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await flushEffects();
  }
  throw new Error(`Expected text not found: ${text}`);
}

describe("AgentTeams", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    apiMocks.listKb.mockResolvedValue([]);
    apiMocks.listModels.mockResolvedValue([]);
    agentTeamApiMocks.listAgentTeams.mockResolvedValue([]);
    agentTeamApiMocks.listAgentWorkflowRuns.mockResolvedValue([makeRun()]);
    agentTeamApiMocks.getAgentWorkflowRun.mockResolvedValue(makeRun());
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("renders history before the active run report so long reports do not bury historical tasks", async () => {
    window.localStorage.setItem(AGENT_TEAM_ACTIVE_RUN_STORAGE_KEY, "run-1");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AgentTeams
          token="token"
          selectedModel=""
          onModelChange={vi.fn()}
        />,
      );
    });
    await waitForText(container, "Agent 团队运行历史");
    await waitForText(container, "执行记录");

    const text = container.textContent ?? "";
    expect(text.indexOf("Agent 团队运行历史")).toBeLessThan(text.indexOf("执行记录"));

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
