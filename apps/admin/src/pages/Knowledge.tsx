import { useEffect, useRef, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Field, Modal, useConfirm, Panel, Pill } from "../ui.js";
import { can, loadSession } from "../auth.js";

export function KnowledgePage() {
  const session = loadSession();
  if (!can(session, "KNOWLEDGE_MANAGE")) return <div className="card muted">无权限访问此功能</div>;
  const [rows, setRows] = useState<api.KnowledgeBase[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { show, node } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  const load = async () => {
    try {
      setRows(await api.adminListKb());
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  useEffect(() => {
    void load();
    /* eslint-disable-next-line */
  }, []);

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirm({
      title: "删除知识库",
      message: `确定删除知识库 "${name}" 及其所有文档吗？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteKb(id);
      show("已删除");
      void load();
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  return (
    <div>
      {node}
      {confirmNode}
      <Panel
        title="官方知识库"
        actions={
          <button
            className="btn sm"
            onClick={() => {
              setEditingId(null);
              setShowForm(true);
            }}
          >
            + 新建库
          </button>
        }
      >
        {rows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: "40px 20px" }}>
            暂无知识库
          </div>
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
              {rows.map((r) => (
                <tbody key={r.id}>
                  <tr>
                    <td><strong>{r.name}</strong></td>
                    <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="muted">{new Date(r.updatedAt).toLocaleString()}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          setEditingId(r.id);
                          setShowForm(true);
                        }}
                      >
                        改名
                      </button>
                      <button
                        className="btn ghost sm"
                        onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                        style={{ marginLeft: "4px" }}
                      >
                        {expandedId === r.id ? "收起" : "文档"}
                      </button>
                      <button
                        className="btn danger sm"
                        onClick={() => handleDelete(r.id, r.name)}
                        style={{ marginLeft: "4px" }}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                  {expandedId === r.id && (
                    <tr>
                      <td colSpan={4}>
                        <DocumentsSection kbId={r.id} onRefresh={() => void load()} />
                      </td>
                    </tr>
                  )}
                </tbody>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <CreateKbForm
        kbId={editingId}
        open={showForm}
        onClose={() => setShowForm(false)}
        onDone={() => {
          show("已保存");
          setShowForm(false);
          void load();
        }}
        onErr={(m) => show(m, "err")}
      />
    </div>
  );
}

function CreateKbForm({
  kbId,
  open,
  onClose,
  onDone,
  onErr,
}: {
  kbId: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onErr: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      onErr("知识库名称不能为空");
      return;
    }
    try {
      setSubmitting(true);
      if (kbId) {
        await api.updateKb(kbId, name.trim());
      } else {
        await api.createKb(name.trim());
      }
      setName("");
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={kbId ? "编辑库名" : "新建知识库"}
      onClose={onClose}
      width="480px"
      footer={
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button className="btn" onClick={submit} disabled={submitting || !name.trim()}>
            {submitting ? "保存中…" : "保存"}
          </button>
        </div>
      }
    >
      <Field label="知识库名称">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例：产品文档"
          disabled={submitting}
          autoFocus
        />
      </Field>
    </Modal>
  );
}

function DocumentsSection({ kbId, onRefresh }: { kbId: string; onRefresh: () => void }) {
  const [docs, setDocs] = useState<api.KbDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddDoc, setShowAddDoc] = useState(false);
  const { show, node } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  const load = async () => {
    setLoading(true);
    try {
      setDocs(await api.listKbDocs(kbId));
    } catch (e) {
      show(errMsg(e), "err");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    /* eslint-disable-next-line */
  }, [kbId]);

  const handleDeleteDoc = async (docId: string, name: string) => {
    const ok = await confirm({
      title: "删除文档",
      message: `确定删除文档 "${name}" 吗？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteKbDoc(kbId, docId);
      show("已删除");
      void load();
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  const statusToPill = (status: string): "g" | "w" | "b" | "n" => {
    if (status === "已索引" || status === "INDEXED") return "g";
    if (status === "索引中" || status === "INDEXING") return "w";
    if (status === "失败" || status === "FAILED") return "b";
    return "n";
  };

  const statusLabel = (status: string): string => {
    if (status === "INDEXED") return "已索引";
    if (status === "INDEXING") return "索引中";
    if (status === "FAILED") return "失败";
    return "待处理";
  };

  return (
    <div style={{ padding: "16px", backgroundColor: "var(--surface2)", borderRadius: "8px" }}>
      {node}
      {confirmNode}
      <div style={{ marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong>文档列表</strong>
        <button className="btn sm" onClick={() => setShowAddDoc(true)}>
          + 添加文档
        </button>
      </div>

      {docs.length === 0 ? (
        <div className="muted" style={{ textAlign: "center", padding: "24px" }}>
          暂无文档
        </div>
      ) : (
        <table className="tbl" style={{ marginBottom: "12px", fontSize: "0.9rem" }}>
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th className="num">块数</th>
              <th className="num">大小(字节)</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>
                  <Pill kind={statusToPill(d.status)}>{statusLabel(d.status)}</Pill>
                </td>
                <td className="num">{d.chunkCount}</td>
                <td className="num">{d.sizeBytes.toLocaleString()}</td>
                <td className="muted">{new Date(d.createdAt).toLocaleString()}</td>
                <td>
                  <button
                    className="btn danger sm"
                    onClick={() => handleDeleteDoc(d.id, d.name)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button className="btn ghost sm" disabled={loading} onClick={load}>
        {loading ? "刷新中…" : "刷新列表"}
      </button>

      <AddDocForm
        kbId={kbId}
        open={showAddDoc}
        onClose={() => setShowAddDoc(false)}
        onDone={() => {
          show("已添加");
          setShowAddDoc(false);
          void load();
        }}
        onUploaded={() => {
          void load();
        }}
        onErr={(m) => show(m, "err")}
      />
    </div>
  );
}

interface UploadFailure {
  readonly name: string;
  readonly reason: string;
}

function AddDocForm({
  kbId,
  open,
  onClose,
  onDone,
  onUploaded,
  onErr,
}: {
  kbId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onUploaded: () => void;
  onErr: (m: string) => void;
}) {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [failures, setFailures] = useState<readonly UploadFailure[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, [open]);

  useEffect(() => {
    if (!open) {
      setFiles([]);
      setUploadedCount(0);
      setFailures([]);
    }
  }, [open]);

  const submit = async () => {
    if (files.length === 0) {
      onErr("请选择文件或文件夹");
      return;
    }

    try {
      setSubmitting(true);
      setUploadedCount(0);
      setFailures([]);
      const nextFailures: UploadFailure[] = [];

      for (const file of files) {
        try {
          await api.addKbDoc(kbId, file);
        } catch (e) {
          nextFailures.push({ name: file.name, reason: errMsg(e) });
        } finally {
          setUploadedCount((value) => value + 1);
        }
      }

      if (nextFailures.length === 0) {
        setFiles([]);
        onDone();
      } else {
        setFailures(nextFailures);
        if (nextFailures.length < files.length) {
          onUploaded();
        }
        onErr(`已完成 ${files.length - nextFailures.length} 个，失败 ${nextFailures.length} 个`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fileAccept = ".txt,.md,.markdown,.json,.xml,.yaml,.yml,.csv,.log,.pdf,.docx,.xlsx,.xls,.pptx";
  const previewFiles = files.slice(0, 8);

  return (
    <Modal
      open={open}
      title="批量上传文档"
      onClose={onClose}
      width="600px"
      footer={
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button className="btn" onClick={submit} disabled={submitting || files.length === 0}>
            {submitting ? `上传中 ${uploadedCount}/${files.length}` : "开始上传"}
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <Field label="选择文件">
          <input
            type="file"
            multiple
            accept={fileAccept}
            onChange={(e) => setFiles(Array.from(e.currentTarget.files ?? []))}
            disabled={submitting}
          />
        </Field>
        <Field label="选择文件夹">
          <input
            ref={folderInputRef}
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.currentTarget.files ?? []))}
            disabled={submitting}
          />
        </Field>
        <p className="muted" style={{ margin: 0 }}>
          支持 txt、md、json、xml、yaml、csv、log、pdf、docx、xlsx、xls、pptx。文件夹上传会逐个入库并自动进入向量化索引队列。
        </p>
        {files.length > 0 && (
          <div className="card" style={{ padding: 12, margin: 0 }}>
            <strong>已选择 {files.length} 个文件</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {previewFiles.map((file) => (
                <li key={`${file.name}-${file.size}`} className="muted">
                  {file.name}
                </li>
              ))}
            </ul>
            {files.length > previewFiles.length && (
              <p className="muted" style={{ margin: "8px 0 0" }}>
                还有 {files.length - previewFiles.length} 个文件未展示
              </p>
            )}
          </div>
        )}
        {failures.length > 0 && (
          <div className="card" style={{ padding: 12, margin: 0, borderColor: "var(--danger)" }}>
            <strong>失败文件</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {failures.slice(0, 8).map((failure) => (
                <li key={failure.name} className="muted">
                  {failure.name}: {failure.reason}
                </li>
              ))}
            </ul>
            {failures.length > 8 && (
              <p className="muted" style={{ margin: "8px 0 0" }}>
                还有 {failures.length - 8} 个失败文件未展示
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
