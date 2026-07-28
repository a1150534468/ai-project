import { useEffect, useRef, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Field, Modal, useConfirm, Pill } from "../ui.js";
import { can, loadSession } from "../auth.js";
import { UserDetailModal, type UserDetailMode } from "./UserDetailModal.js";

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
  const [adjusting, setAdjusting] = useState(false);
  const { show, node: toastNode } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  const [adjustModal, setAdjustModal] = useState<api.AdminUser | null>(null);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustAccount, setAdjustAccount] = useState<"points" | "video">("points");

  const [kbModal, setKbModal] = useState<api.AdminUser | null>(null);
  const [kbBytes, setKbBytes] = useState("");
  const [kbExpiresAt, setKbExpiresAt] = useState("");
  const [kbNote, setKbNote] = useState("");
  const [detailModal, setDetailModal] = useState<{ userId: string; mode: UserDetailMode } | null>(null);
  const canViewFullDetail = can(session, "USER_DETAIL_VIEW");
  const canViewBillingLog = can(session, "USER_BILLING_LOG_VIEW") || canViewFullDetail;

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

  const handleAdjust = async () => {
    if (!adjustModal || adjusting) return;
    const delta = Number(adjustDelta);
    if (!Number.isInteger(delta) || delta === 0) { show("请输入非 0 整数", "err"); return; }
    const reason = adjustReason.trim();
    if (!reason) { show("原因必填", "err"); return; }
    try {
      setAdjusting(true);
      const r = await api.adjustBalance(adjustModal.id, delta, reason, crypto.randomUUID(), adjustAccount);
      const unit = adjustAccount === "video" ? "视频点" : "算力点";
      show(`完成（${unit}）：${r.before} → ${r.after}`);
      setAdjustModal(null);
      setAdjustDelta("");
      setAdjustReason("");
      setAdjustAccount("points");
      void load();
    } catch (e) { show(errMsg(e), "err"); }
    finally { setAdjusting(false); }
  };

  const handleKbQuota = async () => {
    if (!kbModal || adjusting) return;
    const bytes = Number(kbBytes);
    if (!Number.isInteger(bytes) || bytes <= 0) { show("请输入正整数", "err"); return; }
    try {
      setAdjusting(true);
      await api.grantUserKbQuota(kbModal.id, { bytes, expiresAt: kbExpiresAt || undefined, note: kbNote || undefined });
      show("已配额");
      setKbModal(null);
      setKbBytes("");
      setKbExpiresAt("");
      setKbNote("");
      void load();
    } catch (e) { show(errMsg(e), "err"); }
    finally { setAdjusting(false); }
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
        <thead><tr><th>UID</th><th>用户名</th><th>余额</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.uid}</td>
              <td>{u.username}</td>
              <td className="num">{u.balance ?? <span className="muted">—</span>}</td>
              <td><Pill kind={u.bannedAt ? "b" : "g"}>{u.bannedAt ? "已封禁" : "正常"}</Pill></td>
              <td className="muted">{new Date(u.createdAt).toLocaleString()}</td>
              <td className="row" style={{ margin: 0, gap: 4 }}>
                {can(session, "USER_MANAGE") && (
                  <button className={`btn sm ${u.bannedAt ? "ghost" : "danger"}`} onClick={() => ban(u, !!u.bannedAt)}>{u.bannedAt ? "解封" : "封禁"}</button>
                )}
                {can(session, "BALANCE_ADJUST") && <button className="btn sm" onClick={() => { setAdjustModal(u); setAdjustDelta(""); setAdjustReason(""); }} disabled={adjusting}>调余额</button>}
                {can(session, "KNOWLEDGE_MANAGE") && <button className="btn ghost sm" onClick={() => { setKbModal(u); setKbBytes(""); setKbExpiresAt(""); setKbNote(""); }}>调知识库</button>}
                {canViewFullDetail && <button className="btn ghost sm" onClick={() => setDetailModal({ userId: u.id, mode: "full" })}>详情</button>}
                {!canViewFullDetail && canViewBillingLog && <button className="btn ghost sm" onClick={() => setDetailModal({ userId: u.id, mode: "billing" })}>扣费日志</button>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="muted">无数据</td></tr>}
        </tbody>
      </table>
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <button className="btn ghost sm" onClick={() => load(page - 1)} disabled={loading || page <= 1}>上一页</button>
        <span className="muted">第 {page} / {totalPages} 页 · 共 {total} 人</span>
        <button className="btn ghost sm" onClick={() => load(page + 1)} disabled={loading || page >= totalPages}>下一页</button>
      </div>

      <Modal open={!!adjustModal} title={adjustModal ? `调整余额 - ${adjustModal.username}` : ""} onClose={() => setAdjustModal(null)}
        footer={
          <div className="modal-footer-actions">
            <button className="btn ghost" onClick={() => setAdjustModal(null)}>取消</button>
            <button className="btn" onClick={handleAdjust} disabled={adjusting}>提交</button>
          </div>
        }>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="账户类型">
            <select value={adjustAccount} onChange={(e) => setAdjustAccount(e.target.value === "video" ? "video" : "points")}>
              <option value="points">算力点</option>
              <option value="video">视频点</option>
            </select>
          </Field>
          <Field label="调整数额（正加负减，整数）">
            <input type="number" value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)} placeholder="如 100 或 -50" />
          </Field>
          <Field label="调整原因">
            <textarea value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="必填" rows={3} />
          </Field>
        </div>
      </Modal>

      <Modal open={!!kbModal} title={kbModal ? `配置知识库配额 - ${kbModal.username}` : ""} onClose={() => setKbModal(null)}
        footer={
          <div className="modal-footer-actions">
            <button className="btn ghost" onClick={() => setKbModal(null)}>取消</button>
            <button className="btn" onClick={handleKbQuota} disabled={adjusting}>提交</button>
          </div>
        }>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="配额大小（字节，需>0）">
            <input type="number" value={kbBytes} onChange={(e) => setKbBytes(e.target.value)} placeholder="如 1048576" />
          </Field>
          <Field label="过期时间（可选，ISO 格式）">
            <input type="text" value={kbExpiresAt} onChange={(e) => setKbExpiresAt(e.target.value)} placeholder="如 2025-12-31T23:59:59Z" />
          </Field>
          <Field label="备注（可选）">
            <textarea value={kbNote} onChange={(e) => setKbNote(e.target.value)} rows={2} />
          </Field>
        </div>
      </Modal>
      <UserDetailModal
        userId={detailModal?.userId ?? null}
        mode={detailModal?.mode ?? "full"}
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
