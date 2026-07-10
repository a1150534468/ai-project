import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Field, Panel, Modal, Pill } from "../ui.js";

export function ResellersPage() {
  const [rows, setRows] = useState<api.ResellerRow[]>([]);
  const { show, node: toastNode } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryData, setSummaryData] = useState<api.ChannelSummary | null>(null);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editRateOpen, setEditRateOpen] = useState(false);
  const [editRate, setEditRate] = useState<number>(0);

  const load = async () => {
    try {
      setRows(await api.listResellers());
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleViewSummary = async (channelId: string) => {
    try {
      const data = await api.resellerSummary(channelId);
      setSummaryData(data);
      setSummaryOpen(true);
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  const handleEditRate = (channelId: string, currentRate: number) => {
    setEditingChannelId(channelId);
    setEditRate(currentRate);
    setEditRateOpen(true);
  };

  const submitEditRate = async () => {
    if (!editingChannelId) return;
    try {
      await api.updateReseller(editingChannelId, { commissionRate: editRate });
      show("已更新分成比例");
      setEditRateOpen(false);
      void load();
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  const handleToggleEnabled = async (channelId: string, currentEnabled: boolean) => {
    try {
      await api.updateReseller(channelId, { enabled: !currentEnabled });
      show(currentEnabled ? "已禁用" : "已启用");
      void load();
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  return (
    <div>
      {toastNode}
      <Panel
        title="分销代理"
        actions={
          <button className="btn sm" onClick={() => setCreateOpen(true)}>
            新建代理
          </button>
        }
      >
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>用户名</th>
                <th>渠道码</th>
                <th>分成比例</th>
                <th>启用</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.channelId}>
                  <td>{r.username || "-"}</td>
                  <td>{r.code}</td>
                  <td>{((r.commissionRate || 0) * 100).toFixed(1)}%</td>
                  <td>
                    <Pill kind={r.enabled ? "g" : "n"}>
                      {r.enabled ? "是" : "否"}
                    </Pill>
                  </td>
                  <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="row" style={{ margin: 0 }}>
                    <button
                      className="btn ghost sm"
                      onClick={() => handleEditRate(r.channelId, r.commissionRate || 0)}
                    >
                      改比例
                    </button>
                    <button
                      className="btn ghost sm"
                      onClick={() => void handleToggleEnabled(r.channelId, r.enabled)}
                    >
                      {r.enabled ? "禁用" : "启用"}
                    </button>
                    <button
                      className="btn ghost sm"
                      onClick={() => void handleViewSummary(r.channelId)}
                    >
                      查看汇总
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="muted">暂无代理</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
      <CreateResellerModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          show("代理创建成功");
          setCreateOpen(false);
          void load();
        }}
        onErr={(m) => show(m, "err")}
      />
      {summaryOpen && summaryData && (
        <Modal
          open={true}
          title="代理汇总"
          onClose={() => setSummaryOpen(false)}
          footer={
            <div className="modal-footer-actions">
              <button className="btn" onClick={() => setSummaryOpen(false)}>
                关闭
              </button>
            </div>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div><span className="muted">用户数：</span> <strong>{summaryData.totalUsers}</strong></div>
            <div><span className="muted">总充值（元）：</span> <strong>{(summaryData.totalRechargeFen / 100).toFixed(2)}</strong></div>
            <div><span className="muted">分成累计（元）：</span> <strong>{(summaryData.commissionFen / 100).toFixed(2)}</strong></div>
          </div>
        </Modal>
      )}
      {editRateOpen && (
        <Modal
          open={true}
          title="修改分成比例"
          onClose={() => setEditRateOpen(false)}
          footer={
            <div className="modal-footer-actions">
              <button className="btn ghost" onClick={() => setEditRateOpen(false)}>
                取消
              </button>
              <button className="btn" onClick={submitEditRate}>
                保存
              </button>
            </div>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="分成比例（0-1之间，例如0.1表示10%）">
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={editRate}
                onChange={(e) => setEditRate(parseFloat(e.target.value) || 0)}
              />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface CreateResellerModalProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onErr: (m: string) => void;
}

function CreateResellerModal({ open, onClose, onDone, onErr }: CreateResellerModalProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [commissionRate, setCommissionRate] = useState<number>(0.1);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!code.match(/^[A-Z]{2}$/)) {
      onErr("渠道码必须是2位大写字母");
      return;
    }
    setBusy(true);
    try {
      await api.createReseller({ username, password, code, commissionRate });
      setUsername("");
      setPassword("");
      setCode("");
      setCommissionRate(0.1);
      onDone();
    } catch (e) {
      onErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    setUsername("");
    setPassword("");
    setCode("");
    setCommissionRate(0.1);
    onClose();
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCode(e.target.value.toUpperCase());
  };

  return (
    <Modal
      open={open}
      title="新建代理"
      onClose={handleClose}
      footer={
        <div className="modal-footer-actions">
          <button className="btn ghost" onClick={handleClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn"
            disabled={busy || !username || !password || !code || code.length !== 2}
            onClick={submit}
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="用户名">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="密码">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="渠道码（2位大写字母，如AB）">
          <input
            value={code}
            onChange={handleCodeChange}
            disabled={busy}
            maxLength={2}
            placeholder="AB"
          />
        </Field>
        <Field label="分成比例（0-1之间，例如0.1表示10%）">
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={commissionRate}
            onChange={(e) => setCommissionRate(parseFloat(e.target.value) || 0)}
            disabled={busy}
          />
        </Field>
      </div>
    </Modal>
  );
}
