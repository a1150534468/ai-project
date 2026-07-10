import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Field, useConfirm, Pill } from "../ui.js";

export function CodesPage() {
  const [rows, setRows] = useState<api.CodeRow[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const { show, node: toastNode } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  const load = async () => {
    try { setRows(await api.listCodes(statusFilter ? { status: statusFilter } : {})); }
    catch (e) { show(errMsg(e), "err"); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter]);

  const handleDisable = async (code: string) => {
    const confirmed = await confirm({
      title: "停用兑换码",
      message: `确认停用码 ${code}?`,
      confirmText: "停用",
      danger: true
    });
    if (!confirmed) return;
    try { await api.disableCode(code); show("已停用"); void load(); }
    catch (e) { show(errMsg(e), "err"); }
  };

  const getStatusPill = (status: string): "g" | "w" | "b" | "n" => {
    if (status === "unused") return "g";
    if (status === "used") return "w";
    if (status === "disabled") return "b";
    return "n";
  };

  return (
    <div>
      {toastNode}
      {confirmNode}
      <GenForm onDone={(codes) => { show(`已生成 ${codes.length} 个`); void load(); }} onErr={(m) => show(m, "err")} />
      <div className="row">
        <Field label="状态筛选">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">全部</option><option value="unused">未使用</option><option value="used">已使用</option><option value="disabled">已停用</option>
          </select>
        </Field>
        <button className="btn ghost" onClick={load}>刷新</button>
      </div>
      <table>
        <thead><tr><th>码</th><th>类型</th><th>载荷</th><th>状态</th><th>批次</th><th>过期</th><th>操作</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.code}>
              <td style={{ fontFamily: "monospace", fontSize: "12px" }}>{c.code}</td>
              <td>{c.grantType}</td>
              <td className="muted" style={{ fontSize: "12px" }}>{c.grantPayload}</td>
              <td><Pill kind={getStatusPill(c.status)}>{c.status}</Pill></td>
              <td className="muted" style={{ fontSize: "12px" }}>{c.batchID}</td>
              <td className="muted">{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "—"}</td>
              <td>{c.status === "unused" && <button className="btn danger sm" onClick={() => handleDisable(c.code)}>停用</button>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="muted">无数据</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function GenForm({ onDone, onErr }: { onDone: (codes: string[]) => void; onErr: (m: string) => void }) {
  const [grantType, setGrantType] = useState("BALANCE");
  const [points, setPoints] = useState(100);
  const [tier, setTier] = useState("pro");
  const [days, setDays] = useState(30);
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[]>([]);

  const submit = async () => {
    let grantPayload = "";
    if (grantType === "BALANCE") grantPayload = JSON.stringify({ points });
    else if (grantType === "MEMBERSHIP") grantPayload = JSON.stringify({ tier, days });
    else { onErr("v1 仅支持 BALANCE / MEMBERSHIP"); return; }
    setBusy(true);
    try {
      const codes = await api.generateCodes({ grantType, grantPayload, points: grantType === "BALANCE" ? points : undefined, count });
      setResult(codes); onDone(codes);
    } catch (e) { onErr(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <strong>批量生成兑换码</strong>
      <div className="row" style={{ marginTop: 12 }}>
        <Field label="类型">
          <select value={grantType} onChange={(e) => setGrantType(e.target.value)}>
            <option value="BALANCE">积分(BALANCE)</option><option value="MEMBERSHIP">会员(MEMBERSHIP)</option>
          </select>
        </Field>
        {grantType === "BALANCE" && <Field label="积分数"><input type="number" value={points} onChange={(e) => setPoints(Number(e.target.value))} /></Field>}
        {grantType === "MEMBERSHIP" && <><Field label="档位"><select value={tier} onChange={(e) => setTier(e.target.value)}><option value="pro">pro</option><option value="enterprise">enterprise</option><option value="free">free</option></select></Field><Field label="天数"><input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field></>}
        <Field label="数量"><input type="number" value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
        <button className="btn" disabled={busy || count < 1} onClick={submit}>{busy ? "生成中…" : "生成"}</button>
      </div>
      {result.length > 0 && (
        <textarea readOnly rows={Math.min(result.length, 8)} style={{ width: "100%", marginTop: 8, fontFamily: "monospace" }} value={result.join("\n")} />
      )}
    </div>
  );
}
