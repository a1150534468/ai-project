import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Field, Panel, Modal, useConfirm, Pill } from "../ui.js";
import type { Permission } from "../auth.js";
import { can, loadSession } from "../auth.js";

const GRANTABLE: Permission[] = ["USER_MANAGE", "USER_DETAIL_VIEW", "ANNOUNCEMENT_MANAGE"];

const PERMISSION_LABELS: Record<Permission, string> = {
  USER_MANAGE: "用户管理",
  USER_DETAIL_VIEW: "用户完整详情",
  ANNOUNCEMENT_MANAGE: "公告管理",
  ADMIN_MANAGE: "管理员管理",
  KNOWLEDGE_MANAGE: "知识库管理"
};

export function AdminsPage() {
  const session = loadSession();
  if (!can(session, "ADMIN_MANAGE")) return <div className="card muted">无权限访问此功能</div>;
  const [rows, setRows] = useState<api.AdminRow[]>([]);
  const { show, node: toastNode } = useToast();
  const { confirm, node: confirmNode } = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);

  const load = async () => {
    try {
      setRows(await api.listAdmins());
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleDisable = async (id: string, username: string, disabled: boolean) => {
    const action = disabled ? "启用" : "禁用";
    const confirmed = await confirm({
      title: action + "管理员",
      message: `确认${action}管理员"${username}"？`,
      confirmText: action,
      danger: !disabled
    });
    if (!confirmed) return;
    try {
      await api.updateAdminAccount(id, { disabled: !disabled });
      show("已更新");
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
        title="管理员管理"
        actions={
          <button className="btn sm" onClick={() => setCreateOpen(true)}>
            创建管理员
          </button>
        }
      >
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>权限</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>{a.username}</td>
                  <td>
                    <Pill kind={a.role === "super_admin" ? "g" : "n"}>
                      {a.role === "super_admin" ? "超级管理员" : "管理员"}
                    </Pill>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {a.role === "super_admin" ? "全部权限" : a.permissions.length > 0 ? a.permissions.map((p) => PERMISSION_LABELS[p as Permission] || p).join(", ") : "—"}
                  </td>
                  <td>
                    <Pill kind={a.disabled ? "b" : "g"}>
                      {a.disabled ? "禁用" : "正常"}
                    </Pill>
                  </td>
                  <td>
                    {a.role !== "super_admin" && (
                      <button
                        className="btn ghost sm"
                        onClick={() => void handleToggleDisable(a.id, a.username, a.disabled)}
                      >
                        {a.disabled ? "启用" : "禁用"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="muted">暂无管理员</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
      <CreateAdminModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          show("已创建");
          setCreateOpen(false);
          void load();
        }}
        onErr={(m) => show(m, "err")}
      />
    </div>
  );
}

interface CreateAdminModalProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onErr: (m: string) => void;
}

function CreateAdminModal({ open, onClose, onDone, onErr }: CreateAdminModalProps) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [perms, setPerms] = useState<Permission[]>([]);

  const toggle = (perm: Permission) =>
    setPerms((cur) => (cur.includes(perm) ? cur.filter((x) => x !== perm) : [...cur, perm]));

  const submit = async () => {
    try {
      await api.createAdminAccount({ username: u, password: p, permissions: perms });
      setU("");
      setP("");
      setPerms([]);
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    }
  };

  const handleClose = () => {
    setU("");
    setP("");
    setPerms([]);
    onClose();
  };

  return (
    <Modal
      open={open}
      title="创建管理员"
      onClose={handleClose}
      footer={
        <div className="modal-footer-actions">
          <button className="btn ghost" onClick={handleClose}>
            取消
          </button>
          <button className="btn" disabled={u.length < 3 || p.length < 8} onClick={submit}>
            创建
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="用户名 (≥3 字符)">
          <input value={u} onChange={(e) => setU(e.target.value)} placeholder="输入用户名" />
        </Field>
        <Field label="密码 (≥8 字符)">
          <input type="password" value={p} onChange={(e) => setP(e.target.value)} placeholder="输入密码" />
        </Field>
        <Field label="权限">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {GRANTABLE.map((perm) => (
              <label key={perm} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={perms.includes(perm)}
                  onChange={() => toggle(perm)}
                  style={{ width: 16, height: 16 }}
                />
                <span>{PERMISSION_LABELS[perm] || perm}</span>
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
