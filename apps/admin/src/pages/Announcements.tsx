import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Field, Panel, Modal, useConfirm, Pill } from "../ui.js";

export function AnnouncementsPage() {
  const [rows, setRows] = useState<api.Announcement[]>([]);
  const { show, node: toastNode } = useToast();
  const { confirm, node: confirmNode } = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);

  const load = async () => {
    try {
      setRows(await api.listAnnouncements());
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async (id: string, title: string) => {
    const confirmed = await confirm({
      title: "删除公告",
      message: `确认删除公告"${title}"？此操作不可撤销。`,
      confirmText: "删除",
      danger: true
    });
    if (!confirmed) return;
    try {
      await api.deleteAnnouncement(id);
      show("已删除");
      void load();
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  return (
    <div>
      {toastNode}
      {confirmNode}
      <Panel
        title="公告管理"
        actions={
          <button className="btn sm" onClick={() => setCreateOpen(true)}>
            新增公告
          </button>
        }
      >
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>{a.title}</td>
                  <td>
                    <Pill kind={a.active ? "g" : "n"}>
                      {a.active ? "启用" : "停用"}
                    </Pill>
                  </td>
                  <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="row" style={{ margin: 0 }}>
                    <button
                      className="btn ghost sm"
                      onClick={async () => {
                        try {
                          await api.updateAnnouncement(a.id, { active: !a.active });
                          show("已更新");
                          void load();
                        } catch (e) {
                          show(errMsg(e), "err");
                        }
                      }}
                    >
                      {a.active ? "停用" : "启用"}
                    </button>
                    <button
                      className="btn danger sm"
                      onClick={() => void handleDelete(a.id, a.title)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} className="muted">暂无公告</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
      <CreateAnnModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          show("已发布");
          setCreateOpen(false);
          void load();
        }}
        onErr={(m) => show(m, "err")}
      />
    </div>
  );
}

interface CreateAnnModalProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onErr: (m: string) => void;
}

function CreateAnnModal({ open, onClose, onDone, onErr }: CreateAnnModalProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const submit = async () => {
    try {
      await api.createAnnouncement({ title, body, active: true });
      setTitle("");
      setBody("");
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    }
  };

  const handleClose = () => {
    setTitle("");
    setBody("");
    onClose();
  };

  return (
    <Modal
      open={open}
      title="新增公告"
      onClose={handleClose}
      footer={
        <div className="modal-footer-actions">
          <button className="btn ghost" onClick={handleClose}>
            取消
          </button>
          <button className="btn" disabled={!title || !body} onClick={submit}>
            发布
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="标题">
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="正文">
          <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
