import { useEffect, useState } from "react";
import { errorMessage } from "../../apiError";
import { useToast } from "../../motion/Toast";
import { MEMORY_TYPE_ORDER } from "../../memoryGalaxy";
import { deleteMemory, getMemoryGalaxy, searchMemory, toggleMemory, updateMemory } from "../../memoryApi";
import type { MemoryDraft, MemoryNode, MemoryType } from "../../memoryTypes";

/** 自动刷新间隔。记忆是后台异步写进来的（对话结束才抽取），不轮询就得手动刷页面才看得到。 */
const REFRESH_INTERVAL_MS = 8_000;

/** 同一时刻只可能有一件写操作在飞，所以用一个标签而不是四个 boolean。 */
export type MemoryPending = "search" | "toggle" | "save" | "delete";

export interface MemoryGalaxyState {
  readonly enabled: boolean;
  readonly loading: boolean;
  /** 首屏加载失败的原因；后台刷新失败不写这里（见 `load` 的 `background`）。 */
  readonly loadError: string;
  readonly pending: MemoryPending | null;
  /** 按类型筛选之后剩下的，也就是各处该渲染的那批。 */
  readonly nodes: readonly MemoryNode[];
  /** 筛选前的总条数。 */
  readonly totalCount: number;
  /** 可见范围内命中搜索的条数。 */
  readonly hitCount: number;
  /** 用 Set 而不是数组：表格每一行都要判一次归属，数组版是 O(行 × 命中)。 */
  readonly highlightedIds: ReadonlySet<string>;
  readonly activeTypes: readonly MemoryType[];
  readonly selectedId: string | null;
  readonly selectedNode: MemoryNode | null;
  readonly query: string;
  readonly select: (id: string | null) => void;
  readonly setQuery: (value: string) => void;
  readonly toggleType: (type: MemoryType) => void;
  readonly search: () => Promise<void>;
  readonly toggleEnabled: () => Promise<void>;
  readonly save: (draft: MemoryDraft) => Promise<boolean>;
  readonly remove: () => Promise<void>;
}

/**
 * 当前该选中谁。迁移前这件事写了三遍（loader 里剪一次、两个 effect 各修一次），
 * 三份还互相打架 —— 其实它是纯函数，从 `selectedId` 加两条规则就能算出来：
 *
 * 1. 选中的记忆整个没了（被删、或被后台刷新刷掉）→ 落空，回到 null；
 * 2. 还在，但被类型筛选挡住了 → 顺位到当前可见的第一条。
 *
 * 算出来而不是 `setState` 修正，还顺手去掉了原来那一帧空档（effect 跑之前详情面板会先闪一下空）。
 * 副作用是「取消勾选某类型再勾回来，原来的选中项会回来」—— 这是想要的，
 * 真删掉的那条由 `remove()` 显式清掉 id，不会复活。
 */
function resolveSelection(
  all: readonly MemoryNode[],
  visible: readonly MemoryNode[],
  selectedId: string | null,
): MemoryNode | null {
  if (selectedId === null) return null;
  if (!all.some((node) => node.id === selectedId)) return null;

  return visible.find((node) => node.id === selectedId) ?? visible[0] ?? null;
}

export function useMemoryGalaxyState(token: string): MemoryGalaxyState {
  const [allNodes, setAllNodes] = useState<readonly MemoryNode[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<string>>(new Set());
  const [activeTypes, setActiveTypes] = useState<readonly MemoryType[]>(MEMORY_TYPE_ORDER);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<MemoryPending | null>(null);
  // `show` 是 provider 里 useCallback([]) 出来的，身份稳定，可以直接进 effect 的依赖
  const { show } = useToast();

  useEffect(() => {
    let alive = true;

    /** `background` 为真表示这是自动刷新：不亮 loading，失败也不打扰用户（8 秒后自己再试）。 */
    const load = async (background: boolean) => {
      if (!background) {
        setLoading(true);
        setLoadError("");
      }

      try {
        const data = await getMemoryGalaxy(token);
        if (!alive) return;

        setEnabled(data.enabled);
        setAllNodes(data.nodes);
      } catch (error) {
        if (!alive || background) return;

        setLoadError(errorMessage(error, "未知错误"));
        show("err", "记忆加载失败");
      } finally {
        if (alive && !background) setLoading(false);
      }
    };

    void load(false);

    // 标签页在后台就不发请求：定时器照走，回到前台由 focus / visibilitychange 立刻补一次
    const refresh = () => {
      if (document.visibilityState === "visible") void load(true);
    };

    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);

    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [token, show]);

  const nodes = allNodes.filter((node) => activeTypes.includes(node.type));
  const selectedNode = resolveSelection(allNodes, nodes, selectedId);

  /**
   * 四个写操作的公共外壳：占住 pending → 跑 → 失败弹一条 err → 松开 pending。
   * 成功提示留给各自的 task，因为文案要看结果（「找到 N 条」/「已开启」）。
   * 返回 `undefined` 就是这趟失败了。
   */
  async function run<T>(tag: MemoryPending, fallback: string, task: () => Promise<T>): Promise<T | undefined> {
    setPending(tag);
    try {
      return await task();
    } catch (error) {
      show("err", errorMessage(error, fallback));
      return undefined;
    } finally {
      setPending(null);
    }
  }

  /** 至少留一个类型勾着：全都取消的话页面会空掉，用户还以为记忆丢了。 */
  const toggleType = (type: MemoryType) => {
    setActiveTypes((current) => {
      if (!current.includes(type)) {
        // 按 MEMORY_TYPE_ORDER 重建，勾选顺序不影响筛选条的排列
        return MEMORY_TYPE_ORDER.filter((item) => item === type || current.includes(item));
      }

      return current.length === 1 ? current : current.filter((item) => item !== type);
    });
  };

  const search = async () => {
    const keyword = query.trim();
    if (!keyword) {
      setHighlightedIds(new Set());
      show("ok", "已清除搜索高亮");
      return;
    }

    await run("search", "搜索记忆失败", async () => {
      const hits = await searchMemory(token, keyword);

      setHighlightedIds(new Set(hits.map((hit) => hit.id)));
      // 命中第一条直接跳过去：搜完还要自己在表里找一遍就白搜了
      if (hits[0]) setSelectedId(hits[0].id);
      show("ok", hits.length > 0 ? `找到 ${hits.length} 条相关记忆` : "没有找到匹配记忆");
    });
  };

  const toggleEnabled = async () => {
    const next = !enabled;

    await run("toggle", "更新记忆设置失败", async () => {
      await toggleMemory(token, next);
      setEnabled(next);
      show("ok", next ? "长期记忆已开启" : "长期记忆已关闭");
    });
  };

  const save = async (draft: MemoryDraft): Promise<boolean> => {
    const target = selectedNode;
    if (!target) return false;

    const saved = await run("save", "保存记忆失败", async () => {
      const updated = await updateMemory(token, target.id, draft);

      setAllNodes((current) => current.map((node) => (node.id === updated.id ? updated : node)));
      show("ok", "记忆已保存");
      return updated;
    });

    return saved !== undefined;
  };

  const remove = async () => {
    const target = selectedNode;
    if (!target) return;

    await run("delete", "删除记忆失败", async () => {
      await deleteMemory(token, target.id);

      setAllNodes((current) => current.filter((node) => node.id !== target.id));
      setHighlightedIds((current) => new Set([...current].filter((id) => id !== target.id)));
      setSelectedId((current) => (current === target.id ? null : current));
      show("ok", "记忆已删除");
    });
  };

  return {
    enabled,
    loading,
    loadError,
    pending,
    nodes,
    totalCount: allNodes.length,
    hitCount: nodes.filter((node) => highlightedIds.has(node.id)).length,
    highlightedIds,
    activeTypes,
    selectedId: selectedNode?.id ?? null,
    selectedNode,
    query,
    select: setSelectedId,
    setQuery,
    toggleType,
    search,
    toggleEnabled,
    save,
    remove,
  };
}
