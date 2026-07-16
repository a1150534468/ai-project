// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NovelIntelligenceWorkspace } from "./NovelIntelligenceWorkspace";

const api = vi.hoisted(() => ({
  backfillNovelNarrativeAssets: vi.fn(),
  createNovelBranch: vi.fn(),
  createNovelCheckpoint: vi.fn(),
  createNovelResource: vi.fn(),
  createNovelStorylineMilestone: vi.fn(),
  deleteNovelResource: vi.fn(),
  getNovelNarrativeAssets: vi.fn(),
  getNovelNarrativeDashboard: vi.fn(),
  getNovelStructure: vi.fn(),
  listNovelCheckpoints: vi.fn(),
  listNovelCharacters: vi.fn(),
  listNovelProps: vi.fn(),
  listNovelStorylines: vi.fn(),
  rollbackNovelCheckpoint: vi.fn(),
  updateNovelResource: vi.fn(),
}));

vi.mock("../../api", () => api);
vi.mock("@iconify/react", () => ({ Icon: ({ icon }: { readonly icon: string }) => <span data-icon={icon} /> }));

describe("NovelIntelligenceWorkspace continuity backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getNovelNarrativeDashboard.mockResolvedValue({
      project: { storyPhase: "ending", autopilotStatus: "completed", currentBranch: "main" },
      stats: { chapters: 30, totalChars: 84_134, openForeshadows: 5, storylines: 3, debts: 0, facts: 105, characters: 8 },
      tensionCurve: [],
    });
    api.getNovelStructure.mockResolvedValue([]);
    api.listNovelCharacters.mockResolvedValue({ characters: [], relations: [] });
    api.listNovelStorylines.mockResolvedValue([]);
    api.listNovelProps.mockResolvedValue([]);
    api.getNovelNarrativeAssets.mockResolvedValue({ timeline: [], foreshadows: [], debts: [], events: [], causalEdges: [], facts: [], foreshadowEvents: [] });
    api.listNovelCheckpoints.mockResolvedValue([]);
    api.backfillNovelNarrativeAssets.mockResolvedValue({ chapters: 30, timelineEvents: 120, props: 8, propEvents: 24, foreshadows: 3, foreshadowEvents: 7, debts: 2, reinforced: 2, resolved: 1, rescoredChapters: 30 });
  });

  it("lets the author rebuild both empty views from existing chapter text", async () => {
    render(<NovelIntelligenceWorkspace token="token" projectId="project-1" showPrompts={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "时间线" }));
    fireEvent.click(screen.getByRole("button", { name: /从正文补齐/ }));

    await waitFor(() => expect(api.backfillNovelNarrativeAssets).toHaveBeenCalledWith("token", "project-1"));
    expect(await screen.findByText(/已扫描 30 章并重算 30 章评分；当前 3 条伏笔、7 条伏笔事件、2 项债务/)).toBeVisible();
  });
});
