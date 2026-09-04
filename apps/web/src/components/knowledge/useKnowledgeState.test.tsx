// @vitest-environment jsdom

/**
 * 知识库控制器的直测。这一层原来一行测试都没有，而三个真问题正好都长在它管的事情上：
 * 「编辑」提交时走 PATCH 还是 POST、「在看哪个库」与「在改哪个库」是不是同一件事、
 * 还没落地的文档谁在轮询以及什么时候停。
 */
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KbDocument, KnowledgeBase } from "../../kbApi";
import { ToastProvider } from "../../motion/Toast";
import { type KnowledgeState, useKnowledgeState } from "./useKnowledgeState";

const api = vi.hoisted(() => ({
  addKbFile: vi.fn(),
  createKb: vi.fn(),
  deleteKb: vi.fn(),
  deleteKbDocument: vi.fn(),
  getKbDocument: vi.fn(),
  listKb: vi.fn(),
  listKbDocuments: vi.fn(),
  renameKb: vi.fn(),
}));

vi.mock("../../kbApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../kbApi")>()),
  ...api,
}));

const MINE: KnowledgeBase = { id: "mine", name: "我的库", description: "自己建的", ownerType: "USER" };
const OTHER: KnowledgeBase = { id: "other", name: "另一个库", ownerType: "USER" };
const OFFICIAL: KnowledgeBase = { id: "official", name: "官方库", ownerType: "OFFICIAL", latticeCount: 9 };

function doc(id: string, status: KbDocument["status"]): KbDocument {
  return { id, name: `${id}.md`, status, sizeBytes: 2048, chunkCount: 0, createdAt: "2026-09-01T00:00:00.000Z" };
}

let latest: KnowledgeState | null = null;

function Probe() {
  latest = useKnowledgeState("token");
  return null;
}

/** 句柄每次渲染都换新，所以一律通过 `state()` 取当次渲染的那份。 */
function renderProbe() {
  const view = render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );

  return { state: () => latest as KnowledgeState, unmount: view.unmount };
}

type Probed = ReturnType<typeof renderProbe>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function mount(list: readonly KnowledgeBase[] = [MINE, OTHER, OFFICIAL]): Promise<Probed> {
  api.listKb.mockResolvedValue(list);
  const probe = renderProbe();
  await flush();
  return probe;
}

/** 选中一个库，并把它的文档喂进去。 */
async function open(probe: Probed, kbId: string, docs: readonly KbDocument[]) {
  api.listKbDocuments.mockResolvedValue(docs);
  await act(async () => {
    probe.state().select(kbId);
  });
  await flush();
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  latest = null;
});

describe("首屏", () => {
  it("我的库和官方库按 ownerType 分开，谁都还没选中", async () => {
    const { state } = await mount();

    expect(state().loading).toBe(false);
    expect(state().myKbs.map((kb) => kb.id)).toEqual(["mine", "other"]);
    expect(state().officialKbs.map((kb) => kb.id)).toEqual(["official"]);
    expect(state().selectedKb).toBeNull();
  });

  it("拉不回来就把原因写进 loadError", async () => {
    api.listKb.mockRejectedValue(new Error("知识库服务没醒"));
    const { state } = renderProbe();
    await flush();

    expect(state().loadError).toBe("知识库服务没醒");
    expect(state().loading).toBe(false);
  });
});

describe("新建与编辑", () => {
  it("编辑提交走 PATCH —— 原来它走 POST，改个名字变成多一个库", async () => {
    const probe = await mount();
    await act(async () => {
      probe.state().startEdit(MINE);
    });
    expect(probe.state().editingId).toBe("mine");
    expect(probe.state().draft).toEqual({ name: "我的库", description: "自己建的" });

    api.renameKb.mockResolvedValue(undefined);
    await act(async () => {
      probe.state().updateDraft({ name: "改过的名字" });
    });
    await act(async () => {
      await probe.state().submitDraft();
    });

    expect(api.renameKb).toHaveBeenCalledWith("token", "mine", "改过的名字", "自己建的");
    expect(api.createKb).not.toHaveBeenCalled();
    expect(probe.state().editingId).toBeNull();
    expect(probe.state().draft).toEqual({ name: "", description: "" });
    // 存完重拉一次列表
    expect(api.listKb).toHaveBeenCalledTimes(2);
  });

  it("没在编辑就走 POST；名字只有空格时一个请求都不发", async () => {
    const probe = await mount();
    await act(async () => {
      probe.state().updateDraft({ name: "   " });
    });
    await act(async () => {
      await probe.state().submitDraft();
    });
    expect(api.createKb).not.toHaveBeenCalled();

    api.createKb.mockResolvedValue(MINE);
    await act(async () => {
      probe.state().updateDraft({ name: "  新库  " });
    });
    await act(async () => {
      await probe.state().submitDraft();
    });
    expect(api.createKb).toHaveBeenCalledWith("token", "新库", "");
  });

  it("在看哪个库和在改哪个库互不相干", async () => {
    const probe = await mount();
    await open(probe, "mine", [doc("a", "indexed")]);
    await act(async () => {
      probe.state().startEdit(OTHER);
    });

    // 点「编辑」不该把右栏换成另一个库 —— 原来这两件事共用一个 selectedKbId
    expect(probe.state().selectedKb?.id).toBe("mine");
    expect(probe.state().editingId).toBe("other");
    expect(api.listKbDocuments).toHaveBeenCalledTimes(1);
  });
});

describe("文档", () => {
  it("官方库不去要文档明细 —— 后端对它那两个接口直接 403", async () => {
    const probe = await mount();
    await act(async () => {
      probe.state().select("official");
    });
    await flush();

    expect(probe.state().official).toBe(true);
    expect(api.listKbDocuments).not.toHaveBeenCalled();
    expect(probe.state().documents).toEqual([]);
  });

  it("只回访还没落地的那几篇，全落地就停", async () => {
    vi.useFakeTimers();
    const probe = await mount();
    await open(probe, "mine", [doc("waiting", "indexing"), doc("done", "indexed")]);

    api.getKbDocument.mockResolvedValue({ ...doc("waiting", "indexed"), chunkCount: 7 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(api.getKbDocument).toHaveBeenCalledTimes(1);
    expect(api.getKbDocument).toHaveBeenCalledWith("token", "mine", "waiting");
    expect(probe.state().documents.map((row) => row.status)).toEqual(["indexed", "indexed"]);

    // 没有还在排队的了，就不该再有下一轮
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.getKbDocument).toHaveBeenCalledTimes(1);
  });

  it("离页就停 —— 原来每篇文档各起一条递归 setTimeout，没人取消", async () => {
    vi.useFakeTimers();
    const probe = await mount();
    await open(probe, "mine", [doc("waiting", "indexing")]);

    probe.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(api.getKbDocument).not.toHaveBeenCalled();
  });

  it("删文档只从当前列表里摘掉，不整表重拉", async () => {
    const probe = await mount();
    await open(probe, "mine", [doc("a", "indexed"), doc("b", "indexed")]);

    api.deleteKbDocument.mockResolvedValue(undefined);
    await act(async () => {
      await probe.state().removeDocument("a");
    });

    expect(api.deleteKbDocument).toHaveBeenCalledWith("token", "mine", "a");
    expect(probe.state().documents.map((row) => row.id)).toEqual(["b"]);
    expect(api.listKbDocuments).toHaveBeenCalledTimes(1);
  });
});

describe("上传", () => {
  it("一篇一篇交，坏文件只算它自己失败，选中的文件留着好重试", async () => {
    const probe = await mount();
    await open(probe, "mine", []);

    api.addKbFile.mockImplementation(async (_token: string, _kbId: string, file: File) => {
      if (file.name === "bad.md") throw new Error("格式不支持");
      return doc("fresh", "pending");
    });

    const picked = [new File(["hi"], "ok.md"), new File(["hi"], "bad.md")] as unknown as FileList;
    await act(async () => {
      probe.state().chooseFiles(picked);
    });
    await act(async () => {
      await probe.state().upload();
    });

    expect(api.addKbFile).toHaveBeenCalledTimes(2);
    expect(probe.state().uploaded).toBe(2);
    expect(probe.state().failures).toEqual(["bad.md: 格式不支持"]);
    expect(probe.state().files).toHaveLength(2);
    // 交上去的那篇直接插进列表，状态交给轮询补
    expect(probe.state().documents.map((row) => row.id)).toEqual(["fresh"]);
  });

  it("全交成功才清空选择，并让两个 file input 重挂", async () => {
    const probe = await mount();
    await open(probe, "mine", []);

    api.addKbFile.mockResolvedValue(doc("fresh", "pending"));
    const before = probe.state().pickerKey;

    await act(async () => {
      probe.state().chooseFiles([new File(["hi"], "ok.md")] as unknown as FileList);
    });
    await act(async () => {
      await probe.state().upload();
    });

    expect(probe.state().files).toEqual([]);
    expect(probe.state().failures).toEqual([]);
    expect(probe.state().pickerKey).toBe(before + 1);
  });
});

describe("删库", () => {
  it("删掉正在看又正在改的那个库，选中和编辑一起收掉", async () => {
    const probe = await mount();
    await open(probe, "mine", [doc("a", "indexed")]);
    await act(async () => {
      probe.state().startEdit(MINE);
    });

    api.deleteKb.mockResolvedValue(undefined);
    api.listKb.mockResolvedValue([OTHER, OFFICIAL]);
    await act(async () => {
      await probe.state().remove(MINE);
    });

    expect(api.deleteKb).toHaveBeenCalledWith("token", "mine");
    expect(probe.state().selectedKb).toBeNull();
    expect(probe.state().editingId).toBeNull();
    expect(probe.state().draft).toEqual({ name: "", description: "" });
    expect(probe.state().myKbs.map((kb) => kb.id)).toEqual(["other"]);
  });
});
