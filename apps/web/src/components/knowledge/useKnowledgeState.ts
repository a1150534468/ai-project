/**
 * 知识库页的控制器：列表、选中、增删改、上传、以及「还在索引的文档」的轮询。
 * 页面本体只管画，所有异步和状态迁移都在这里，因为原来那版把它们摊在页面里之后
 * 埋了三个真问题：
 *
 * 1. 「编辑」只是把名字填回新建表单，提交走的还是 POST —— 改个名字变成多一个同名库
 *    （`handleRenameKb` 定义了但没有任何调用点）。这里把「在编辑谁」显式记成 `editingId`，
 *    提交时按它选 PATCH 还是 POST。
 * 2. 「当前查看哪个库」和「当前编辑哪个库」共用一个 `selectedKbId`：点编辑会把右栏标题换成
 *    另一个库，文档列表却还是上一个库的，接着上传就传错地方。现在这是两份互不相干的状态。
 * 3. 每篇新文档各起一条 `setTimeout` 递归链，没有取消：切库、离页之后它们照样在跑。
 *    现在是一个 effect 统一轮询「当前库里还没落地的那几篇」，卸载即停。
 */
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../apiError";
import {
  addKbFile,
  createKb,
  deleteKb,
  deleteKbDocument,
  getKbDocument,
  listKb,
  listKbDocuments,
  renameKb,
  type KbDocument,
  type KnowledgeBase,
} from "../../kbApi";
import { useToast } from "../../motion/Toast";
import { isIndexing } from "./kbDocumentMeta";

/** 还在索引的文档隔多久回访一次。 */
const POLL_INTERVAL_MS = 3_000;

/** 同一时刻只可能有一件写操作在飞，所以用一个标签而不是四个 boolean。 */
export type KbPending = "list" | "save" | "upload" | "delete";

export interface KbDraft {
  readonly name: string;
  readonly description: string;
}

const EMPTY_DRAFT: KbDraft = { name: "", description: "" };

const OFFICIAL = "OFFICIAL";

export interface KnowledgeState {
  /** 首屏还在拉列表。后续的刷新走 `pending === "list"`，不再把列表清空。 */
  readonly loading: boolean;
  /** 首屏拉失败的原因；刷新失败只弹 toast，不写这里。 */
  readonly loadError: string;
  readonly pending: KbPending | null;
  readonly myKbs: readonly KnowledgeBase[];
  readonly officialKbs: readonly KnowledgeBase[];
  readonly selectedKb: KnowledgeBase | null;
  /** 选中的是官方库：只读，没有文档明细（后端对官方库的文档接口直接 403）。 */
  readonly official: boolean;
  readonly documents: readonly KbDocument[];
  readonly draft: KbDraft;
  /** 表单在改哪个库；null 就是在新建。 */
  readonly editingId: string | null;
  readonly files: readonly File[];
  /** 这一批已经交完的个数（成功和失败都算）。 */
  readonly uploaded: number;
  readonly failures: readonly string[];
  /**
   * 两个 file input 的 key。上传完加一让它们重挂 —— 清 `<input type="file">` 只能动 DOM 的
   * `value`，重挂等价且不用留 ref。同一个文件挑第二次也才会再触发 change。
   */
  readonly pickerKey: number;
  readonly select: (id: string | null) => void;
  readonly refresh: () => Promise<void>;
  readonly updateDraft: (patch: Partial<KbDraft>) => void;
  readonly startEdit: (kb: KnowledgeBase) => void;
  readonly cancelEdit: () => void;
  readonly submitDraft: () => Promise<void>;
  readonly remove: (kb: KnowledgeBase) => Promise<void>;
  readonly chooseFiles: (files: FileList | null) => void;
  readonly upload: () => Promise<void>;
  readonly removeDocument: (docId: string) => Promise<void>;
}

export function useKnowledgeState(token: string): KnowledgeState {
  const [list, setList] = useState<readonly KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<KbPending | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<readonly KbDocument[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<KbDraft>(EMPTY_DRAFT);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [uploaded, setUploaded] = useState(0);
  const [failures, setFailures] = useState<readonly string[]>([]);
  const [pickerKey, setPickerKey] = useState(0);
  // `show` 是 provider 里 useCallback([]) 出来的，身份稳定，可以直接进依赖表
  const { show } = useToast();

  const fetchList = useCallback(async () => setList(await listKb(token)), [token]);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        await fetchList();
      } catch (error) {
        if (alive) setLoadError(errorMessage(error, "未知错误"));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [fetchList]);

  const selectedKb = list.find((kb) => kb.id === selectedId) ?? null;
  const official = selectedKb?.ownerType === OFFICIAL;

  /**
   * 选中谁就拉谁的文档。放在 effect 里而不是写在点击回调里，图的是那个 cleanup：
   * 连着点两个库时慢的那次响应会被丢掉，不会把 A 的文档画在 B 的标题下面。
   */
  useEffect(() => {
    if (selectedId === null || official) {
      setDocuments([]);
      return;
    }

    let alive = true;

    void (async () => {
      try {
        const docs = await listKbDocuments(token, selectedId);
        if (alive) setDocuments(docs);
      } catch (error) {
        if (alive) show("err", errorMessage(error, "加载文档失败"));
      }
    })();

    return () => {
      alive = false;
    };
  }, [token, selectedId, official, show]);

  /**
   * 索引是后台干的，页面只能问。这里每轮只问「当前还没落地的那几篇」，
   * 写回时必然换一个新数组 —— 下一轮就是靠这次身份变化重新排上的，所以不需要
   * setInterval，也不会在全部落地之后继续空转。
   */
  useEffect(() => {
    const kbId = selectedId;
    if (kbId === null) return;

    const waiting = documents.filter(isIndexing);
    if (waiting.length === 0) return;

    let alive = true;
    const timer = window.setTimeout(async () => {
      const fresh = await Promise.all(
        // 单篇失败不该拖掉整轮：这一篇下一轮再问
        waiting.map((doc) => getKbDocument(token, kbId, doc.id).catch(() => null)),
      );
      if (!alive) return;

      const byId = new Map(fresh.filter((doc): doc is KbDocument => doc !== null).map((doc) => [doc.id, doc]));
      setDocuments((current) => current.map((doc) => byId.get(doc.id) ?? doc));
    }, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [token, selectedId, documents]);

  /**
   * 写操作的公共外壳：占住 pending → 跑 → 失败弹一条 err → 松开。
   * 成功提示留给各自的 task，文案要看是创建还是更新。
   */
  const run = async (tag: KbPending, fallback: string, task: () => Promise<void>) => {
    setPending(tag);
    try {
      await task();
    } catch (error) {
      show("err", errorMessage(error, fallback));
    } finally {
      setPending(null);
    }
  };

  const submitDraft = async () => {
    const name = draft.name.trim();
    if (name === "") return;

    const description = draft.description.trim();
    const target = editingId;

    await run("save", target === null ? "创建失败" : "更新失败", async () => {
      if (target === null) await createKb(token, name, description);
      else await renameKb(token, target, name, description);

      setDraft(EMPTY_DRAFT);
      setEditingId(null);
      await fetchList();
      show("ok", target === null ? "创建成功" : "更新成功");
    });
  };

  const remove = async (kb: KnowledgeBase) => {
    await run("delete", "删除失败", async () => {
      await deleteKb(token, kb.id);

      setSelectedId((current) => (current === kb.id ? null : current));
      if (editingId === kb.id) {
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
      }
      await fetchList();
      show("ok", "删除成功");
    });
  };

  const upload = async () => {
    const kbId = selectedId;
    if (kbId === null || files.length === 0) return;

    await run("upload", "上传失败", async () => {
      setUploaded(0);
      setFailures([]);
      const added: KbDocument[] = [];
      const failed: string[] = [];

      // 一篇一篇交：整批塞一个请求的话，一个坏文件会把好文件一起退回来
      for (const file of files) {
        try {
          added.push(await addKbFile(token, kbId, file));
        } catch (error) {
          failed.push(`${file.name}: ${errorMessage(error, "未知错误")}`);
        } finally {
          setUploaded((done) => done + 1);
        }
      }

      // 列表是按创建时间倒序的，新的直接插在最前面，省一次整表重拉；状态交给轮询补
      setDocuments((current) => [...added.reverse(), ...current]);
      setFailures(failed);
      if (failed.length === 0) {
        setFiles([]);
        setPickerKey((key) => key + 1);
        show("ok", "文件已提交，正在向量化处理");
      } else {
        show("err", `已提交 ${added.length} 个，失败 ${failed.length} 个`);
      }
    });
  };

  const removeDocument = async (docId: string) => {
    const kbId = selectedId;
    if (kbId === null) return;

    await run("delete", "删除失败", async () => {
      await deleteKbDocument(token, kbId, docId);

      setDocuments((current) => current.filter((doc) => doc.id !== docId));
      show("ok", "删除成功");
    });
  };

  return {
    loading,
    loadError,
    pending,
    myKbs: list.filter((kb) => kb.ownerType !== OFFICIAL),
    officialKbs: list.filter((kb) => kb.ownerType === OFFICIAL),
    selectedKb,
    official,
    documents,
    draft,
    editingId,
    files,
    uploaded,
    failures,
    pickerKey,
    select: setSelectedId,
    refresh: () => run("list", "刷新失败", fetchList),
    updateDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
    startEdit: (kb) => {
      setEditingId(kb.id);
      setDraft({ name: kb.name, description: kb.description ?? "" });
    },
    cancelEdit: () => {
      setEditingId(null);
      setDraft(EMPTY_DRAFT);
    },
    submitDraft,
    remove,
    chooseFiles: (picked) => {
      setFiles(Array.from(picked ?? []));
      setUploaded(0);
      setFailures([]);
    },
    upload,
    removeDocument,
  };
}
