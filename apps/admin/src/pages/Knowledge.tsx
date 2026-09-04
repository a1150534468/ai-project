/**
 * 后台的官方知识库页：上面一张库表，展开某一行就在它下面摆这个库的文档。
 *
 * 重写前这一版有四处是真的坏的：
 * 1. 权限判断落在所有 useState 之前 —— 无权限时提前 return，两次渲染的 Hook 数量对不上。
 *    现在外层只做判断，Hook 全在内层组件里。
 * 2. 库表每一行又套了一层 `<tbody>`（`<tbody>` 里嵌 `<tbody>`）。这不是合法 HTML，
 *    解析器会把它拆平，展开行落在哪儿就不由我们说了算。现在用 `<Fragment>` 串起两行。
 * 3. 状态徽标只认 `INDEXED` / `已索引` 这类值，而接口回的是小写的 `indexed` ——
 *    于是每一篇文档都显示「待处理」。现在按小写值查表，口径与用户端那张表一致。
 * 4.「改名」弹出来的输入框是空的：表单只拿到 id 没拿到当前名字，改名等于重新起名。
 *
 * 顺带收掉的：文档区收了个 `onRefresh` 却从没调用过；两个弹窗各自 new 了一份 toast/confirm，
 * 整页于是有三份（其中一份还挂在 `<td>` 里）；「大小(字节)」那列是 `toLocaleString()`，
 * 十位数的字节数没人读得出量级。
 *
 * 文档状态在后台仍然是手动刷新，没跟用户端一样起轮询 —— 这是台运营用的表，
 * 不值得为了看进度在后台常驻定时请求。
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import * as api from "../api.js";
import { can, loadSession } from "../auth.js";
import { errMsg, Field, Modal, Panel, Pill, useConfirm, useToast } from "../ui.js";

interface StatusMeta {
  readonly label: string;
  /** Pill 的配色：g 成功 / w 警告 / b 失败 / n 中性 */
  readonly kind: "g" | "w" | "b" | "n";
}

type DocStatus = "pending" | "indexing" | "indexed" | "failed";

/** 键就是接口回的小写值；文案与用户端的 `kbDocumentMeta` 对齐，两边别各说一套。 */
const STATUS: Record<DocStatus, StatusMeta> = {
  pending: { label: "待处理", kind: "n" },
  indexing: { label: "索引中", kind: "w" },
  indexed: { label: "已建立知识晶格链接", kind: "g" },
  failed: { label: "失败", kind: "b" },
};

/** 认不出来的值按「待处理」显示 —— 上面那个 as 是句谎话，这个兜底就是为它准备的。 */
function statusOf(raw: string): StatusMeta {
  return STATUS[raw.toLowerCase() as DocStatus] ?? STATUS.pending;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 字节数变人话，口径跟用户端一致：只有 B 取整，往上都留一位小数。 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${UNITS[0]}`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : Math.round(value * 10) / 10} ${UNITS[unit]}`;
}

/** 同一时刻最多开一个弹窗，所以用一个字段说明「开着哪个」，不摆两个 boolean 加一个 editingId。 */
type Dialog =
  | { readonly kind: "name"; readonly editing: api.KnowledgeBase | null }
  | { readonly kind: "upload"; readonly kbId: string };

const at = (iso: string): string => new Date(iso).toLocaleString();

/** 权限判断只能待在这一层：它要提前 return，而 return 之前不许出现 Hook。 */
export function KnowledgePage() {
  if (!can(loadSession(), "KNOWLEDGE_MANAGE")) return <div className="card muted">无权限访问此功能</div>;
  return <KnowledgeConsole />;
}

function KnowledgeConsole() {
  const [rows, setRows] = useState<readonly api.KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [docs, setDocs] = useState<readonly api.KbDocument[]>([]);
  const [docsBusy, setDocsBusy] = useState(false);
  /** 自增一次就等于「把展开着那一行的文档重拉一遍」，见下面第二个 effect */
  const [docsNonce, setDocsNonce] = useState(0);
  const { show, node: toastNode } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  const reload = useCallback(async () => {
    try {
      setRows(await api.adminListKb());
    } catch (error) {
      show(errMsg(error), "err");
    } finally {
      setLoading(false);
    }
  }, [show]);

  // useToast 给的 show 是稳定引用，所以这条只在挂载时跑一次，不用再压依赖检查
  useEffect(() => {
    void reload();
  }, [reload]);

  // 文档只有这一处在拉：换展开行、或者 nonce 变了，都落到同一件事上
  useEffect(() => {
    if (expandedId === null) {
      setDocs([]);
      return;
    }
    let alive = true;
    setDocsBusy(true);
    void (async () => {
      try {
        const list = await api.listKbDocs(expandedId);
        if (alive) setDocs(list);
      } catch (error) {
        if (alive) show(errMsg(error), "err");
      } finally {
        if (alive) setDocsBusy(false);
      }
    })();
    // 收起或换行时把回得慢的那次结果丢掉，别盖到新展开的库上
    return () => {
      alive = false;
    };
  }, [expandedId, docsNonce, show]);

  const refreshDocs = () => setDocsNonce((value) => value + 1);

  const removeKb = async (target: api.KnowledgeBase) => {
    const ok = await confirm({
      title: "删除知识库",
      message: `「${target.name}」里的文档和已建立的知识晶格会一起移除，且无法恢复。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteKb(target.id);
      // 删掉的正好是展开着那行时，展开态得跟着收 —— 否则它一直指着一个不存在的库
      setExpandedId((current) => (current === target.id ? null : current));
      show("已删除");
      await reload();
    } catch (error) {
      show(errMsg(error), "err");
    }
  };

  const removeDoc = async (doc: api.KbDocument) => {
    const ok = await confirm({
      title: "删除文档",
      message: `「${doc.name}」及其已建立的知识晶格会一起移除，且无法恢复。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      // 文档自己带着 kbId，不用再从外面把库 id 传一层进来
      await api.deleteKbDoc(doc.kbId, doc.id);
      show("已删除");
      refreshDocs();
    } catch (error) {
      show(errMsg(error), "err");
    }
  };

  return (
    <div>
      {toastNode}
      {confirmNode}
      <Panel
        title="官方知识库"
        actions={
          <button type="button" className="btn sm" onClick={() => setDialog({ kind: "name", editing: null })}>
            + 新建库
          </button>
        }
      >
        {rows.length === 0 ? (
          // 首屏还在拉的时候别说「暂无」，那是两件事
          <p className="muted" style={{ margin: 0, padding: "40px 20px", textAlign: "center" }}>
            {loading ? "正在加载…" : "暂无知识库"}
          </p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>名称</th>
                <th>创建时间</th>
                <th>最后更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const expanded = row.id === expandedId;

                return (
                  <Fragment key={row.id}>
                    <tr>
                      <td>
                        <strong>{row.name}</strong>
                      </td>
                      <td className="muted">{at(row.createdAt)}</td>
                      <td className="muted">{at(row.updatedAt)}</td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => setDialog({ kind: "name", editing: row })}
                          >
                            改名
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            aria-expanded={expanded}
                            onClick={() => setExpandedId(expanded ? null : row.id)}
                          >
                            {expanded ? "收起" : "文档"}
                          </button>
                          <button type="button" className="btn danger sm" onClick={() => void removeKb(row)}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={4} style={{ background: "var(--surface2)" }}>
                          <DocumentPanel
                            docs={docs}
                            busy={docsBusy}
                            onAdd={() => setDialog({ kind: "upload", kbId: row.id })}
                            onRefresh={refreshDocs}
                            onDelete={removeDoc}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {/* 两个弹窗都只在开着的时候挂载：关掉即卸载，状态跟着一起没，不用再写「!open 就清空」的 effect */}
      {dialog?.kind === "name" && (
        <NameDialog
          editing={dialog.editing}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            setDialog(null);
            show(message);
            void reload();
          }}
          onFailed={(message) => show(message, "err")}
        />
      )}

      {dialog?.kind === "upload" && (
        <UploadDialog
          kbId={dialog.kbId}
          onClose={() => setDialog(null)}
          onFinished={(ok, failed) => {
            if (ok > 0) refreshDocs();
            if (failed === 0) {
              setDialog(null);
              show(`已添加 ${ok} 个文档`);
              return;
            }
            // 有失败就把弹窗留着 —— 失败清单在它里面，关掉就没处看了
            show(`成功 ${ok} 个，失败 ${failed} 个`, "err");
          }}
        />
      )}
    </div>
  );
}

interface DocumentPanelProps {
  readonly docs: readonly api.KbDocument[];
  readonly busy: boolean;
  readonly onAdd: () => void;
  readonly onRefresh: () => void;
  readonly onDelete: (doc: api.KbDocument) => void;
}

/** 展开行里的文档表。数据在上层拿着 —— 上传完要刷的就是它，没必要再往下传一层回调。 */
function DocumentPanel({ docs, busy, onAdd, onRefresh, onDelete }: DocumentPanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong>文档列表</strong>
        <div style={{ display: "flex", gap: 4 }}>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={onRefresh}>
            {busy ? "刷新中…" : "刷新"}
          </button>
          <button type="button" className="btn sm" onClick={onAdd}>
            + 添加文档
          </button>
        </div>
      </div>

      {docs.length === 0 ? (
        <p className="muted" style={{ margin: 0, padding: 24, textAlign: "center" }}>
          {busy ? "正在加载…" : "暂无文档"}
        </p>
      ) : (
        <table className="tbl compact">
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th className="num">晶格数</th>
              <th className="num">大小</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => {
              const status = statusOf(doc.status);

              return (
                <tr key={doc.id}>
                  <td>{doc.name}</td>
                  <td>
                    <Pill kind={status.kind}>{status.label}</Pill>
                  </td>
                  <td className="num">{doc.chunkCount}</td>
                  {/* 精确字节数挪到 title 里：偶尔真要对账 */}
                  <td className="num" title={`${doc.sizeBytes} 字节`}>
                    {formatSize(doc.sizeBytes)}
                  </td>
                  <td className="muted">{at(doc.createdAt)}</td>
                  <td>
                    {/* 名字进 aria-label：一列「删除」读起来全都一样，光靠可见文案分不出删的是哪篇 */}
                    <button
                      type="button"
                      className="btn danger sm"
                      aria-label={`删除文档 ${doc.name}`}
                      onClick={() => onDelete(doc)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface NameDialogProps {
  /** null = 新建；有值 = 改这个库的名字，输入框拿它当初值 */
  readonly editing: api.KnowledgeBase | null;
  readonly onClose: () => void;
  readonly onSaved: (message: string) => void;
  readonly onFailed: (message: string) => void;
}

/** 新建与改名共用一个弹窗，`editing` 有没有值决定走 POST 还是 PATCH。 */
function NameDialog({ editing, onClose, onSaved, onFailed }: NameDialogProps) {
  const [name, setName] = useState(editing?.name ?? "");
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  const submit = async () => {
    if (trimmed === "" || saving) return;
    setSaving(true);
    try {
      if (editing === null) {
        await api.createKb(trimmed);
        onSaved(`已创建「${trimmed}」`);
      } else {
        await api.updateKb(editing.id, trimmed);
        onSaved(`已改名为「${trimmed}」`);
      }
    } catch (error) {
      // 成功那条路上组件跟着弹窗一起卸载了，所以只有失败才需要把按钮解锁
      setSaving(false);
      onFailed(errMsg(error));
    }
  };

  return (
    <Modal
      open
      title={editing === null ? "新建知识库" : "改名"}
      onClose={onClose}
      width="480px"
      footer={
        <div className="modal-footer-actions">
          <button type="button" className="btn ghost" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn" disabled={saving || trimmed === ""} onClick={() => void submit()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      }
    >
      <Field label="知识库名称">
        <input
          value={name}
          placeholder="例：产品文档"
          disabled={saving}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          // 就一个字段的表单，回车该能提交（提交按钮在 footer 里，构不成一个 <form>）
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </Field>
    </Modal>
  );
}

/** 后端解析器认得的扩展名。原来这串字面量写在渲染里，它是常量。 */
const ACCEPT = [
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".csv",
  ".log",
  ".pdf",
  ".docx",
  ".xlsx",
  ".xls",
  ".pptx",
].join(",");

/** 选中的文件和失败原因都只露前几条，剩下的报个数。 */
const PREVIEW_LIMIT = 8;

interface Picker {
  readonly label: string;
  /** 目录选择器。`webkitdirectory` / `directory` 不在 React 的属性表里，只能自己 set */
  readonly directory: boolean;
}

/**
 * 挑文件和挑文件夹是同一个 `<input type="file">`，差别只有那两个非标准属性。
 * 原来为此写了两份 Field、一个 ref 和一个挂在 `[open]` 上的 effect —— 那个 effect 的依赖
 * 跟「属性该不该设」没关系，属性只是碰巧每次开弹窗被补设一次。现在随挂载在 ref 回调里设好。
 */
const PICKERS: readonly Picker[] = [
  { label: "选择文件", directory: false },
  { label: "选择文件夹", directory: true },
];

function markDirectory(node: HTMLInputElement | null): void {
  if (node === null) return;
  node.setAttribute("webkitdirectory", "");
  node.setAttribute("directory", "");
}

interface Failure {
  readonly name: string;
  readonly reason: string;
}

interface UploadDialogProps {
  readonly kbId: string;
  readonly onClose: () => void;
  /** 一批交完的回执：成功几个、失败几个。弹窗留不留由上层定 */
  readonly onFinished: (ok: number, failed: number) => void;
}

function UploadDialog({ kbId, onClose, onFinished }: UploadDialogProps) {
  const [files, setFiles] = useState<readonly File[]>([]);
  /** 这一批已经交完的个数（成功和失败都算） */
  const [done, setDone] = useState(0);
  const [failures, setFailures] = useState<readonly Failure[]>([]);
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    setBusy(true);
    setDone(0);
    setFailures([]);
    const failed: Failure[] = [];

    // 一个个交：接口一次只收一个文件，而且要能指名道姓地说哪个没进去
    for (const file of files) {
      try {
        await api.addKbDoc(kbId, file);
      } catch (error) {
        failed.push({ name: file.name, reason: errMsg(error) });
      } finally {
        setDone((value) => value + 1);
      }
    }

    setFailures(failed);
    setBusy(false);
    onFinished(files.length - failed.length, failed.length);
  };

  return (
    <Modal
      open
      title="批量上传文档"
      onClose={onClose}
      width="600px"
      footer={
        <div className="modal-footer-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          {/* 一个都没选时按钮本来就是灰的，所以不用再在 upload 里判空 */}
          <button type="button" className="btn" disabled={busy || files.length === 0} onClick={() => void upload()}>
            {busy ? `上传中 ${done}/${files.length}` : "开始上传"}
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {PICKERS.map((picker) => (
          <Field key={picker.label} label={picker.label}>
            <input
              type="file"
              multiple
              accept={picker.directory ? undefined : ACCEPT}
              ref={picker.directory ? markDirectory : undefined}
              disabled={busy}
              onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}
            />
          </Field>
        ))}

        <p className="muted" style={{ margin: 0 }}>
          支持 txt、md、json、xml、yaml、csv、log、pdf、docx、xlsx、xls、pptx。
          整个文件夹选进来也会逐个入库并自动进入向量化队列。
        </p>

        {files.length > 0 && (
          <div className="card" style={{ margin: 0, padding: 12 }}>
            <strong>已选择 {files.length} 个文件</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {files.slice(0, PREVIEW_LIMIT).map((file) => (
                <li key={`${file.name}-${file.size}`} className="muted">
                  {file.name}
                </li>
              ))}
              {files.length > PREVIEW_LIMIT && (
                <li className="muted">还有 {files.length - PREVIEW_LIMIT} 个文件未展示</li>
              )}
            </ul>
          </div>
        )}

        {failures.length > 0 && (
          // 原来这里描的是 var(--danger)：后台没这个变量，边框颜色于是回落成 .card 的默认值
          <div className="card" style={{ margin: 0, padding: 12, borderColor: "var(--bad)" }}>
            <strong>失败 {failures.length} 个</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {failures.slice(0, PREVIEW_LIMIT).map((failure) => (
                <li key={failure.name} className="muted">
                  {failure.name}：{failure.reason}
                </li>
              ))}
              {failures.length > PREVIEW_LIMIT && (
                <li className="muted">还有 {failures.length - PREVIEW_LIMIT} 个失败未展示</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
