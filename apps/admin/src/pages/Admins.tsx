/**
 * 管理员账号：列表 + 创建，行内可禁用/启用（超管那行不给操作）。
 *
 * 重写时收掉的几处：
 * 1. 权限门禁 `if (!can(...)) return <div/>` 写在所有 useState **之前** —— 一旦这个分支
 *    在某次渲染里变了向，React 两次渲染的 hook 数目就对不上，整页白屏。
 *    现在外层只做门禁、内层才拿 hook，两者各自渲染路径固定。
 * 2. 可授予权限是手抄的三条，漏了 `KNOWLEDGE_MANAGE` —— 服务端的
 *    `GRANTABLE_PERMISSIONS` 收这一条，于是后台根本勾不出知识库权限。
 *    现在名单和中文名都从 auth.ts 那张目录出，前后端各自一份的抄写没了。
 * 3. 权限列是一行三层嵌套的三元（超管 / 有权限 / 空），拆成一个函数。
 * 4. 列表没有加载态：第一帧就摆着「暂无管理员」。
 * 5. 创建弹窗的提交条件在页脚按钮上写一遍、submit 里没有第二道，请求飞行中也不禁用；
 *    现在正文是真 `<form>`，页脚按钮用 `form=` 关联，条件只有 `ready` 一处。
 * 6. 那句 `// eslint-disable-next-line react-hooks/exhaustive-deps`：本仓用 biome，没有这条规则。
 */
import { type FormEvent, useEffect, useState } from "react";
import * as api from "../api.js";
import { can, GRANTABLE_PERMISSIONS, loadSession, type Permission, permissionLabel } from "../auth.js";
import { errMsg, Field, Modal, Panel, Pill, type ToastKind, useConfirm, useToast } from "../ui.js";

export function AdminsPage() {
  // 门禁与控制台分开：这一层不拿任何 hook，返回哪条分支都不影响 hook 顺序
  if (!can(loadSession(), "ADMIN_MANAGE")) return <div className="card muted">无权限访问此功能</div>;
  return <AdminsConsole />;
}

/** 权限列的文案：超管一句话盖过明细，普通管理员列中文名，一条都没有给个破折号。 */
function permissionSummary(row: api.AdminRow): string {
  if (row.role === "super_admin") return "全部权限";
  if (row.permissions.length === 0) return "—";
  return row.permissions.map(permissionLabel).join(", ");
}

function AdminsConsole() {
  const [rows, setRows] = useState<readonly api.AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const { show, node: toastNode } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listAdmins()
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((error) => {
        if (!cancelled) show(errMsg(error), "err");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, show]);

  async function toggleDisabled(row: api.AdminRow) {
    const action = row.disabled ? "启用" : "禁用";
    const ok = await confirm({
      title: `${action}管理员`,
      message: `确认${action}管理员"${row.username}"？`,
      confirmText: action,
      danger: !row.disabled,
    });
    if (!ok) return;
    try {
      await api.updateAdminAccount(row.id, { disabled: !row.disabled });
      show("已更新");
      setNonce((n) => n + 1);
    } catch (error) {
      show(errMsg(error), "err");
    }
  }

  return (
    <div>
      {toastNode}
      {confirmNode}
      <Panel
        title="管理员管理"
        actions={
          <button className="btn sm" type="button" onClick={() => setCreateOpen(true)}>
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
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.username}</td>
                  <td>
                    <Pill kind={row.role === "super_admin" ? "g" : "n"}>
                      {row.role === "super_admin" ? "超级管理员" : "管理员"}
                    </Pill>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {permissionSummary(row)}
                  </td>
                  <td>
                    <Pill kind={row.disabled ? "b" : "g"}>{row.disabled ? "禁用" : "正常"}</Pill>
                  </td>
                  <td>
                    {/* 超管不给禁用键：服务端也会拒，界面上先不摆出来 */}
                    {row.role !== "super_admin" && (
                      <button className="btn ghost sm" type="button" onClick={() => void toggleDisabled(row)}>
                        {row.disabled ? "启用" : "禁用"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="muted">
                    暂无管理员
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <CreateAdmin
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          show("已创建");
          setNonce((n) => n + 1);
        }}
        onNotify={show}
      />
    </div>
  );
}

const FORM_ID = "admin-create";

function CreateAdmin({
  open,
  onClose,
  onCreated,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  onNotify: (text: string, kind?: ToastKind) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Set 而不是数组：勾选就是集合的增删，`includes` + `filter` 那一套换掉
  const [perms, setPerms] = useState<ReadonlySet<Permission>>(new Set());
  const [busy, setBusy] = useState(false);
  const ready = !busy && username.trim().length >= 3 && password.length >= 8;

  function close() {
    setUsername("");
    setPassword("");
    setPerms(new Set());
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      // 顺序按目录来，别让勾选先后决定发出去的数组次序
      const permissions = GRANTABLE_PERMISSIONS.filter((perm) => perms.has(perm));
      await api.createAdminAccount({ username: username.trim(), password, permissions });
      setUsername("");
      setPassword("");
      setPerms(new Set());
      onCreated();
    } catch (error) {
      onNotify(errMsg(error), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="创建管理员"
      onClose={close}
      footer={
        <div className="modal-footer-actions">
          <button className="btn ghost" type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="btn" type="submit" form={FORM_ID} disabled={!ready}>
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      }
    >
      <form id={FORM_ID} style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={submit}>
        <Field label="用户名 (≥3 字符)">
          <input
            value={username}
            placeholder="输入用户名"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label="密码 (≥8 字符)">
          <input
            type="password"
            value={password}
            placeholder="输入密码"
            autoComplete="new-password"
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="权限">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {GRANTABLE_PERMISSIONS.map((perm) => (
              <label key={perm} className="check-line">
                <input
                  type="checkbox"
                  checked={perms.has(perm)}
                  disabled={busy}
                  onChange={() =>
                    setPerms((cur) => {
                      const next = new Set(cur);
                      if (!next.delete(perm)) next.add(perm);
                      return next;
                    })
                  }
                />
                <span>{permissionLabel(perm)}</span>
              </label>
            ))}
          </div>
        </Field>
      </form>
    </Modal>
  );
}
