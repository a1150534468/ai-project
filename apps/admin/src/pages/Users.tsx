import { useEffect, useRef, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, useConfirm, Pill } from "../ui.js";
import { can, loadSession } from "../auth.js";
import { UserDetailModal } from "./UserDetailModal.js";

export function UsersPage() {
  const session = loadSession();
  const [rows, setRows] = useState<api.AdminUser[]>([]);
  const [q, setQ] = useState("");
  // 翻页/刷新用已提交的搜索词，避免输入框未提交的内容悄悄改变查询
  const [committedQ, setCommittedQ] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const loadSeqRef = useRef(0);
  const { show, node: toastNode } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  const [detailModal, setDetailModal] = useState<{ userId: string } | null>(null);
  const canViewFullDetail = can(session, "USER_DETAIL_VIEW");

  const load = async (targetPage = page, term = committedQ) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      let r = await api.listUsers(term || undefined, targetPage, pageSize);
      // 页码越界（如数据被删导致总数缩水）时回退到最后一页
      if (r.rows.length === 0 && r.total > 0 && r.page > 1) {
        r = await api.listUsers(term || undefined, Math.max(1, Math.ceil(r.total / pageSize)), pageSize);
      }
      if (seq !== loadSeqRef.current) return; // 期间发起了更新的请求，丢弃过期结果
      setRows(r.rows);
      setTotal(r.total);
      setPage(r.page);
      setCommittedQ(term);
    }
    catch (e) { if (seq === loadSeqRef.current) show(errMsg(e), "err"); }
    finally { if (seq === loadSeqRef.current) setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const ban = async (u: api.AdminUser, banned: boolean) => {
    const action = banned ? "解封" : "封禁";
    const msg = banned ? `确认解封用户 ${u.username}(${u.uid})?` : `确认封禁用户 ${u.username}(${u.uid})?`;
    const confirmed = await confirm({
      title: action,
      message: msg,
      confirmText: action,
      danger: !banned
    });
    if (!confirmed) return;
    try { banned ? await api.unbanUser(u.id) : await api.banUser(u.id); show("已更新"); void load(); }
    catch (e) { show(errMsg(e), "err"); }
  };

  return (
    <div>
      {toastNode}
      {confirmNode}
      <div className="row">
        <input placeholder="按 UID / 用户名搜索" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(1, q)} />
        <button className="btn" onClick={() => load(1, q)} disabled={loading}>{loading ? "加载中…" : "搜索"}</button>
        <CreateUser onDone={() => { show("已创建"); void load(); }} onErr={(m) => show(m, "err")} />
      </div>
      <table>
        <thead><tr><th>UID</th><th>用户名</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.uid}</td>
              <td>{u.username}</td>
              <td><Pill kind={u.bannedAt ? "b" : "g"}>{u.bannedAt ? "已封禁" : "正常"}</Pill></td>
              <td className="muted">{new Date(u.createdAt).toLocaleString()}</td>
              <td className="row" style={{ margin: 0, gap: 4 }}>
                {can(session, "USER_MANAGE") && (
                  <button className={`btn sm ${u.bannedAt ? "ghost" : "danger"}`} onClick={() => ban(u, !!u.bannedAt)}>{u.bannedAt ? "解封" : "封禁"}</button>
                )}
                {canViewFullDetail && <button className="btn ghost sm" onClick={() => setDetailModal({ userId: u.id })}>详情</button>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted">无数据</td></tr>}
        </tbody>
      </table>
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <button className="btn ghost sm" onClick={() => load(page - 1)} disabled={loading || page <= 1}>上一页</button>
        <span className="muted">第 {page} / {totalPages} 页 · 共 {total} 人</span>
        <button className="btn ghost sm" onClick={() => load(page + 1)} disabled={loading || page >= totalPages}>下一页</button>
      </div>

      <UserDetailModal
        userId={detailModal?.userId ?? null}
        onClose={() => setDetailModal(null)}
        onError={(m) => show(m, "err")}
      />
    </div>
  );
}

function CreateUser({ onDone, onErr }: { onDone: () => void; onErr: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [u, setU] = useState(""); const [p, setP] = useState("");
  const submit = async () => {
    try { await api.createUser(u, p); setOpen(false); setU(""); setP(""); onDone(); }
    catch (e) { onErr(errMsg(e)); }
  };
  if (!open) return <button className="btn gray" onClick={() => setOpen(true)}>+ 建用户</button>;
  return (
    <span className="row" style={{ margin: 0 }}>
      <input placeholder="用户名(≥3)" value={u} onChange={(e) => setU(e.target.value)} />
      <input placeholder="初始密码(≥8)" value={p} onChange={(e) => setP(e.target.value)} />
      <button className="btn" disabled={u.length < 3 || p.length < 8} onClick={submit}>提交</button>
      <button className="btn gray" onClick={() => setOpen(false)}>取消</button>
    </span>
  );
}
