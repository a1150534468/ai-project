// @vitest-environment jsdom

/**
 * 记忆页控制器的直测。这一层原来一行测试都没有，而它管着页面上最容易看错的三件事：
 * 「现在该选中谁」是从 `selectedId` 算出来的（不再靠 effect 事后修正）、
 * 后台刷新失败不许打扰用户、类型筛选至少留一个。
 */
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_TYPE_ORDER } from "../../memoryGalaxy";
import type { MemoryGalaxyData, MemoryNode } from "../../memoryTypes";
import { ToastProvider } from "../../motion/Toast";
import { useMemoryGalaxyState, type MemoryGalaxyState } from "./useMemoryGalaxyState";

const api = vi.hoisted(() => ({
  deleteMemory: vi.fn(),
  getMemoryGalaxy: vi.fn(),
  searchMemory: vi.fn(),
  toggleMemory: vi.fn(),
  updateMemory: vi.fn(),
}));

vi.mock("../../memoryApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../memoryApi")>()),
  ...api,
}));

function node(id: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    title: `记忆 ${id}`,
    text: `${id} 的正文`,
    type: "CORE",
    importance: 50,
    tags: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    lastUsedAt: null,
    usedCount: 0,
    ...overrides,
  };
}

const CORE = node("core");
const KNOWLEDGE = node("knowledge", { type: "KNOWLEDGE" });
const OTHER = node("other", { type: "OTHER" });

/** `stats` 控制器根本没读（计数全从 nodes 自己算），给个空壳占位。 */
function galaxy(nodes: readonly MemoryNode[], enabled = true): MemoryGalaxyData {
  return {
    enabled,
    stats: { total: nodes.length, byType: { CORE: 0, PERMANENT: 0, TEMPORARY: 0, KNOWLEDGE: 0, OTHER: 0 } },
    nodes,
  };
}

let latest: MemoryGalaxyState | null = null;

function Probe() {
  latest = useMemoryGalaxyState("token");
  return null;
}

/** 句柄每次渲染都换新，所以一律通过 `state()` 取当次渲染的那份。 */
function renderProbe() {
  render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );

  return () => latest as MemoryGalaxyState;
}

async function mount(nodes: readonly MemoryNode[], enabled = true) {
  api.getMemoryGalaxy.mockResolvedValue(galaxy(nodes, enabled));
  const state = renderProbe();
  await act(async () => {
    await Promise.resolve();
  });

  return state;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  latest = null;
});

describe("首屏", () => {
  it("拉回来的数据直接进状态，默认勾着全部类型", async () => {
    const state = await mount([CORE, KNOWLEDGE, OTHER]);

    expect(state().enabled).toBe(true);
    expect(state().loading).toBe(false);
    expect(state().totalCount).toBe(3);
    expect(state().nodes).toHaveLength(3);
    expect(state().activeTypes).toEqual(MEMORY_TYPE_ORDER);
  });

  it("失败把原因写进 loadError", async () => {
    api.getMemoryGalaxy.mockRejectedValue(new Error("记忆服务没醒"));
    const state = renderProbe();
    await act(async () => {
      await Promise.resolve();
    });

    expect(state().loadError).toBe("记忆服务没醒");
    expect(state().loading).toBe(false);
  });
});

describe("该选中谁是算出来的", () => {
  it("没点过就不选，不会自作主张挑第一条", async () => {
    const state = await mount([CORE, KNOWLEDGE]);

    expect(state().selectedId).toBeNull();
    expect(state().selectedNode).toBeNull();
  });

  it("选中项被类型筛选挡住时顺位到可见的第一条", async () => {
    const state = await mount([CORE, KNOWLEDGE]);
    await act(async () => {
      state().select("knowledge");
    });
    expect(state().selectedId).toBe("knowledge");

    await act(async () => {
      state().toggleType("KNOWLEDGE");
    });

    // 对外报的是算完的 id，不是原始的 selectedId
    expect(state().selectedId).toBe("core");
    expect(state().selectedNode?.id).toBe("core");
  });

  it("一条都看不见时落空", async () => {
    const state = await mount([KNOWLEDGE]);
    await act(async () => {
      state().select("knowledge");
    });

    await act(async () => {
      state().toggleType("KNOWLEDGE");
    });

    expect(state().nodes).toHaveLength(0);
    expect(state().selectedId).toBeNull();
    expect(state().selectedNode).toBeNull();
  });
});

describe("类型筛选", () => {
  it("最后一个类型取消不掉，否则页面空得像记忆丢了", async () => {
    const state = await mount([CORE]);
    for (const type of MEMORY_TYPE_ORDER.slice(1)) {
      await act(async () => {
        state().toggleType(type);
      });
    }
    expect(state().activeTypes).toEqual(["CORE"]);

    await act(async () => {
      state().toggleType("CORE");
    });
    expect(state().activeTypes).toEqual(["CORE"]);
  });

  it("勾回来按固定顺序排，不按点击顺序", async () => {
    const state = await mount([CORE]);
    for (const type of ["CORE", "KNOWLEDGE", "CORE"] as const) {
      await act(async () => {
        state().toggleType(type);
      });
    }

    expect(state().activeTypes).toEqual(MEMORY_TYPE_ORDER.filter((type) => type !== "KNOWLEDGE"));
  });
});

describe("搜索", () => {
  const hits = [
    { ...KNOWLEDGE, score: 0.9 },
    { ...CORE, score: 0.4 },
  ];

  it("关键词是空的就地清高亮，不打接口", async () => {
    const state = await mount([CORE]);
    await act(async () => {
      state().setQuery("   ");
    });
    await act(async () => {
      await state().search();
    });

    expect(api.searchMemory).not.toHaveBeenCalled();
    expect(state().highlightedIds.size).toBe(0);
  });

  it("命中后高亮全部命中项并跳到第一条", async () => {
    const state = await mount([CORE, KNOWLEDGE]);
    api.searchMemory.mockResolvedValue(hits);

    await act(async () => {
      state().setQuery("正文");
    });
    await act(async () => {
      await state().search();
    });

    expect(api.searchMemory).toHaveBeenCalledWith("token", "正文");
    expect([...state().highlightedIds]).toEqual(["knowledge", "core"]);
    expect(state().selectedId).toBe("knowledge");
  });
});

describe("命中计数与搜索失败", () => {
  const hits = [
    { ...KNOWLEDGE, score: 0.9 },
    { ...CORE, score: 0.4 },
  ];

  it("命中数只算看得见的那些，高亮本身不受筛选影响", async () => {
    const state = await mount([CORE, KNOWLEDGE]);
    api.searchMemory.mockResolvedValue(hits);

    await act(async () => {
      state().setQuery("正文");
    });
    await act(async () => {
      await state().search();
    });
    expect(state().hitCount).toBe(2);

    await act(async () => {
      state().toggleType("KNOWLEDGE");
    });
    expect(state().hitCount).toBe(1);
    expect(state().highlightedIds.size).toBe(2);
  });

  it("搜索失败不抛出去，pending 也要松开", async () => {
    const state = await mount([CORE]);
    api.searchMemory.mockRejectedValue(new Error("检索服务超时"));

    await act(async () => {
      state().setQuery("正文");
    });
    await act(async () => {
      await state().search();
    });

    expect(state().pending).toBeNull();
    expect(state().highlightedIds.size).toBe(0);
  });
});

describe("写操作", () => {
  const draft = {
    title: "改过的标题",
    text: "改过的正文",
    type: "PERMANENT",
    importance: 88,
    tags: ["偏好"],
  } as const;

  it("保存成功就地换掉那一条并回 true", async () => {
    const state = await mount([CORE, KNOWLEDGE]);
    api.updateMemory.mockResolvedValue({ ...CORE, ...draft });
    await act(async () => {
      state().select("core");
    });

    let saved: boolean | undefined;
    await act(async () => {
      saved = await state().save(draft);
    });

    expect(saved).toBe(true);
    expect(api.updateMemory).toHaveBeenCalledWith("token", "core", draft);
    expect(state().selectedNode?.title).toBe("改过的标题");
    expect(state().nodes).toHaveLength(2);
  });

  it("保存失败回 false，本地数据不动", async () => {
    const state = await mount([CORE]);
    api.updateMemory.mockRejectedValue(new Error("写库失败"));
    await act(async () => {
      state().select("core");
    });

    let saved: boolean | undefined;
    await act(async () => {
      saved = await state().save(draft);
    });

    expect(saved).toBe(false);
    expect(state().selectedNode?.title).toBe(CORE.title);
    expect(state().pending).toBeNull();
  });

  it("没选中谁的时候保存是空操作", async () => {
    const state = await mount([CORE]);

    let saved: boolean | undefined;
    await act(async () => {
      saved = await state().save(draft);
    });

    expect(saved).toBe(false);
    expect(api.updateMemory).not.toHaveBeenCalled();
  });
});

describe("删除与开关", () => {
  it("删除会清掉选中并把它从高亮里剪掉", async () => {
    const state = await mount([CORE, KNOWLEDGE]);
    api.searchMemory.mockResolvedValue([{ ...CORE, score: 1 }]);
    api.deleteMemory.mockResolvedValue(undefined);

    await act(async () => {
      state().setQuery("正文");
    });
    await act(async () => {
      await state().search();
    });
    expect(state().selectedId).toBe("core");

    await act(async () => {
      await state().remove();
    });

    expect(api.deleteMemory).toHaveBeenCalledWith("token", "core");
    expect(state().totalCount).toBe(1);
    expect(state().selectedId).toBeNull();
    expect(state().highlightedIds.size).toBe(0);
  });

  it("开关先写通了才落到状态上", async () => {
    const state = await mount([CORE], false);
    api.toggleMemory.mockResolvedValue(undefined);

    await act(async () => {
      await state().toggleEnabled();
    });

    expect(api.toggleMemory).toHaveBeenCalledWith("token", true);
    expect(state().enabled).toBe(true);
  });

  it("开关写失败就维持原样", async () => {
    const state = await mount([CORE], false);
    api.toggleMemory.mockRejectedValue(new Error("设置服务不可用"));

    await act(async () => {
      await state().toggleEnabled();
    });

    expect(state().enabled).toBe(false);
    expect(state().pending).toBeNull();
  });
});

describe("后台刷新", () => {
  it("跟上服务端；选中项被别处删掉就落空", async () => {
    vi.useFakeTimers();
    const state = await mount([CORE, KNOWLEDGE]);
    await act(async () => {
      state().select("knowledge");
    });

    api.getMemoryGalaxy.mockResolvedValue(galaxy([CORE]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(state().totalCount).toBe(1);
    expect(state().selectedId).toBeNull();
    expect(state().selectedNode).toBeNull();
  });

  it("刷新失败不写 loadError，也不清掉手上的数据", async () => {
    vi.useFakeTimers();
    const state = await mount([CORE, KNOWLEDGE]);

    api.getMemoryGalaxy.mockRejectedValue(new Error("刷新炸了"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(state().loadError).toBe("");
    expect(state().loading).toBe(false);
    expect(state().nodes).toHaveLength(2);
  });
});

