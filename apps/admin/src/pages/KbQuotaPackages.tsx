import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Field, Modal, Pill, useConfirm, Panel } from "../ui.js";
import { can, loadSession } from "../auth.js";

export function KbQuotaPackagesPage() {
  const session = loadSession();
  if (!can(session, "KNOWLEDGE_MANAGE")) return <div className="card muted">无权限访问此功能</div>;
  const [rows, setRows] = useState<api.QuotaPackage[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { show, node } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  const load = async () => {
    try {
      setRows(await api.listQuotaPackages());
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
      title: "删除配额包",
      message: `确定删除 "${name}" 吗？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteQuotaPackage(id);
      show("已删除");
      void load();
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    } else if (bytes >= 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    } else if (bytes >= 1024) {
      return (bytes / 1024).toFixed(2) + " KB";
    }
    return bytes + " B";
  };

  return (
    <div>
      {node}
      {confirmNode}
      <Panel
        title="知识库配额包"
        actions={
          <button
            className="btn sm"
            onClick={() => {
              setEditingId(null);
              setShowForm(true);
            }}
          >
            + 新建配额包
          </button>
        }
      >
        {rows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: "40px 20px" }}>
            暂无配额包数据
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>名称</th>
                <th>容量</th>
                <th>时长</th>
                <th>价格(点数)</th>
                <th>启用</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong></td>
                  <td className="num">{formatBytes(r.bytes)}</td>
                  <td>
                    <Pill kind={r.durationDays === 0 ? "n" : "g"}>
                      {r.durationDays === 0 ? "永久" : `${r.durationDays}天`}
                    </Pill>
                  </td>
                  <td className="num">{r.pricePoints}</td>
                  <td>
                    <Pill kind={r.enabled ? "g" : "n"}>{r.enabled ? "启用" : "禁用"}</Pill>
                  </td>
                  <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className="btn ghost sm"
                      onClick={() => {
                        setEditingId(r.id);
                        setShowForm(true);
                      }}
                    >
                      编辑
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
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <UpsertForm
        packageId={editingId}
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

function UpsertForm({
  packageId,
  open,
  onClose,
  onDone,
  onErr,
}: {
  packageId: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onErr: (m: string) => void;
}) {
  const [r, setR] = useState<{
    id?: string;
    name: string;
    bytes: number;
    durationDays: number;
    pricePoints: number;
    enabled: boolean;
  }>({
    name: "",
    bytes: 0,
    durationDays: 30,
    pricePoints: 0,
    enabled: true,
  });

  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setR({
      name: "",
      bytes: 0,
      durationDays: 30,
      pricePoints: 0,
      enabled: true,
    });
  };

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open]);

  const submit = async () => {
    if (!r.name || r.bytes <= 0 || r.durationDays < 0 || r.pricePoints < 0) {
      onErr("请填写完整有效的信息");
      return;
    }
    try {
      setSubmitting(true);
      if (r.id) {
        await api.updateQuotaPackage(r.id, r);
      } else {
        await api.createQuotaPackage(r);
      }
      resetForm();
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
      title={packageId ? "编辑配额包" : "新建配额包"}
      onClose={onClose}
      width="600px"
      footer={
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button className="btn" onClick={submit} disabled={submitting || !r.name || r.bytes <= 0}>
            {submitting ? "保存中…" : "保存"}
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <Field label="包名">
          <input
            value={r.name}
            onChange={(e) => setR({ ...r, name: e.target.value })}
            placeholder="例：基础包"
            disabled={submitting}
          />
        </Field>
        <Field label="容量(字节)">
          <input
            type="number"
            min="1"
            value={r.bytes}
            onChange={(e) => setR({ ...r, bytes: Number(e.target.value) })}
            placeholder="1048576"
            disabled={submitting}
          />
        </Field>
        <Field label="时长(天, 0=永久)">
          <input
            type="number"
            min="0"
            value={r.durationDays}
            onChange={(e) => setR({ ...r, durationDays: Number(e.target.value) })}
            disabled={submitting}
          />
        </Field>
        <Field label="价格(点数)">
          <input
            type="number"
            min="0"
            value={r.pricePoints}
            onChange={(e) => setR({ ...r, pricePoints: Number(e.target.value) })}
            disabled={submitting}
          />
        </Field>
        <Field label="启用">
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => setR({ ...r, enabled: e.target.checked })}
            disabled={submitting}
          />
        </Field>
      </div>
    </Modal>
  );
}
