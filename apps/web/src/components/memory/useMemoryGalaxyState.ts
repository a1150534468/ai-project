import { useEffect, useState } from "react";
import {
  deleteMemory,
  getMemoryGalaxy,
  searchMemory,
  toggleMemory,
  updateMemory,
} from "../../api";
import { MEMORY_TYPE_ORDER } from "../../memoryGalaxy";
import type { MemoryDraft, MemoryGalaxyData, MemoryNode, MemoryType } from "../../memoryTypes";

const MEMORY_REFRESH_INTERVAL_MS = 8_000;

type Notice = {
  readonly tone: "success" | "error";
  readonly text: string;
};

interface UseMemoryGalaxyStateResult {
  readonly nodes: readonly MemoryNode[];
  readonly enabled: boolean;
  readonly selectedId: string | null;
  readonly setSelectedId: (value: string | null) => void;
  readonly query: string;
  readonly setQuery: (value: string) => void;
  readonly highlightedIds: readonly string[];
  readonly activeTypes: readonly MemoryType[];
  readonly zoom: number;
  readonly setZoom: (value: number) => void;
  readonly loading: boolean;
  readonly searchPending: boolean;
  readonly togglePending: boolean;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly loadError: string;
  readonly notice: Notice | null;
  readonly filteredNodes: readonly MemoryNode[];
  readonly selectedNode: MemoryNode | null;
  readonly highlightedCount: number;
  readonly totalCount: number;
  readonly handleToggleType: (type: MemoryType) => void;
  readonly handleSearch: () => Promise<void>;
  readonly handleToggleEnabled: () => Promise<void>;
  readonly handleSave: (draft: MemoryDraft) => Promise<boolean>;
  readonly deleteSelected: () => Promise<void>;
}

export function useMemoryGalaxyState(token: string): UseMemoryGalaxyStateResult {
  const [nodes, setNodes] = useState<readonly MemoryNode[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlightedIds, setHighlightedIds] = useState<readonly string[]>([]);
  const [activeTypes, setActiveTypes] = useState<readonly MemoryType[]>(MEMORY_TYPE_ORDER);
  const [zoom, setZoom] = useState(100);
  const [loading, setLoading] = useState(true);
  const [searchPending, setSearchPending] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let active = true;

    const loadGalaxy = async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setLoadError("");
      }

      try {
        const data = await getMemoryGalaxy(token);
        if (!active) {
          return;
        }

        setEnabled(data.enabled);
        setNodes(data.nodes);
        setSelectedId((current) =>
          current && data.nodes.some((node) => node.id === current)
            ? current
            : null,
        );
      } catch (error) {
        if (!active) {
          return;
        }

        if (!silent) {
          setLoadError(error instanceof Error ? error.message : "未知错误");
          setNotice({ tone: "error", text: "记忆加载失败" });
        }
      } finally {
        if (active && !silent) {
          setLoading(false);
        }
      }
    };

    void loadGalaxy();

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void loadGalaxy(true);
      }
    };
    const refreshTimer = window.setInterval(refreshIfVisible, MEMORY_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [token]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setNotice(null);
    }, 3200);

    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (selectedId && !nodes.some((node) => node.id === selectedId)) {
      setSelectedId(null);
    }
  }, [nodes, selectedId]);

  const filteredNodes = nodes.filter((node) => activeTypes.includes(node.type));
  const selectedNode = filteredNodes.find((node) => node.id === selectedId) ?? null;
  const highlightedCount = filteredNodes.filter((node) => highlightedIds.includes(node.id)).length;

  useEffect(() => {
    if (selectedId === null) {
      return;
    }

    if (filteredNodes.some((node) => node.id === selectedId)) {
      return;
    }

    const nextSelectedId = filteredNodes[0]?.id ?? null;
    if (selectedId !== nextSelectedId) {
      setSelectedId(nextSelectedId);
    }
  }, [filteredNodes, selectedId]);

  const handleToggleType = (type: MemoryType) => {
    setActiveTypes((current) => {
      if (current.includes(type)) {
        if (current.length === 1) {
          return current;
        }

        return current.filter((item) => item !== type);
      }

      return MEMORY_TYPE_ORDER.filter((item) => current.includes(item) || item === type);
    });
  };

  const handleSearch = async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setHighlightedIds([]);
      setNotice({ tone: "success", text: "已清除搜索高亮" });
      return;
    }

    setSearchPending(true);
    try {
      const hits = await searchMemory(token, trimmedQuery);
      const nextHighlightedIds = hits.map((hit) => hit.id);
      setHighlightedIds(nextHighlightedIds);
      if (nextHighlightedIds[0]) {
        setSelectedId(nextHighlightedIds[0]);
      }
      setNotice({
        tone: "success",
        text: hits.length > 0 ? `找到 ${hits.length} 条相关记忆` : "没有找到匹配记忆",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "搜索记忆失败",
      });
    } finally {
      setSearchPending(false);
    }
  };

  const handleToggleEnabled = async () => {
    const nextEnabled = !enabled;
    setTogglePending(true);
    try {
      await toggleMemory(token, nextEnabled);
      setEnabled(nextEnabled);
      setNotice({
        tone: "success",
        text: nextEnabled ? "长期记忆已开启" : "长期记忆已关闭",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "更新记忆设置失败",
      });
    } finally {
      setTogglePending(false);
    }
  };

  const handleSave = async (draft: MemoryDraft): Promise<boolean> => {
    if (!selectedNode) {
      return false;
    }

    setSaving(true);
    try {
      const updatedNode = await updateMemory(token, selectedNode.id, draft);
      setNodes((current) =>
        current.map((node) => (node.id === updatedNode.id ? updatedNode : node)),
      );
      setNotice({ tone: "success", text: "记忆已保存" });
      return true;
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存记忆失败",
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const deleteSelected = async () => {
    if (!selectedNode) {
      return;
    }

    setDeleting(true);
    try {
      await deleteMemory(token, selectedNode.id);
      setNodes((current) => current.filter((node) => node.id !== selectedNode.id));
      setHighlightedIds((current) => current.filter((id) => id !== selectedNode.id));
      setSelectedId((current) => (current === selectedNode.id ? null : current));
      setNotice({ tone: "success", text: "记忆已删除" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除记忆失败",
      });
    } finally {
      setDeleting(false);
    }
  };

  return {
    nodes,
    enabled,
    selectedId,
    setSelectedId,
    query,
    setQuery,
    highlightedIds,
    activeTypes,
    zoom,
    setZoom,
    loading,
    searchPending,
    togglePending,
    saving,
    deleting,
    loadError,
    notice,
    filteredNodes,
    selectedNode,
    highlightedCount,
    totalCount: nodes.length,
    handleToggleType,
    handleSearch,
    handleToggleEnabled,
    handleSave,
    deleteSelected,
  };
}
