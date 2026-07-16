import { describe, expect, it, vi } from "vitest";
import { findLedgerEvidence, syncNovelNarrativeLedgersForChapter } from "./narrative-ledger.js";

describe("novel narrative ledger", () => {
  it("ignores short conversational questions that are not durable threads", () => {
    expect(findLedgerEvidence("他在干嘛？", "众人看了他一眼，随后继续工作。" )).toBeNull();
    expect(findLedgerEvidence("就这？", "门外下起了雨。" )).toBeNull();
  });

  it("distinguishes reinforcement from an explicit payoff", () => {
    const title = "锁灵坠究竟是谁留下的？";
    expect(findLedgerEvidence(title, "林岚再次握住锁灵坠，熟悉的纹路仍然没有答案。" )).toMatchObject({ resolved: false });
    expect(findLedgerEvidence(title, "林岚终于知道了答案：锁灵坠原来是母亲留下的遗物。" )).toMatchObject({ resolved: true });
  });

  it("closes a linked debt when a later chapter pays off the foreshadow", async () => {
    const updateItem = vi.fn(async () => ({}));
    const updateDebts = vi.fn(async () => ({ count: 1 }));
    const upsertEvent = vi.fn(async () => ({}));
    let findCalls = 0;
    const store = {
      novelForeshadowItem: {
        findMany: vi.fn(async () => ++findCalls === 1 ? [] : [{ id: "f-1", projectId: "p-1", title: "锁灵坠究竟是谁留下的？", description: "追查锁灵坠来历", status: "open", introducedInChapterIndex: 1 }]),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        update: updateItem,
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      novelForeshadowEvent: { deleteMany: vi.fn(async () => ({ count: 0 })), upsert: upsertEvent },
      novelNarrativeDebt: { deleteMany: vi.fn(async () => ({ count: 0 })), updateMany: updateDebts, upsert: vi.fn() },
    };

    const result = await syncNovelNarrativeLedgersForChapter({
      store: store as never,
      projectId: "p-1",
      chapterId: "c-4",
      chapterIndex: 4,
      content: "林岚终于知道了答案：锁灵坠原来是母亲留下的遗物。",
      foreshadowItems: [],
    });

    expect(result.resolved).toBe(1);
    expect(upsertEvent).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ action: "paidOff", chapterIndex: 4 }) }));
    expect(updateItem).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "resolved", resolvedInChapterIndex: 4 }) }));
    expect(updateDebts).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "resolved", resolvedInChapter: 4 }) }));
  });
});
