import { useEffect, useState } from "react";
import * as api from "../api.js";
import { can, loadSession } from "../auth.js";
import { errMsg, Field, Panel, Pill, Stat, StatStrip, useToast } from "../ui.js";

const PAGE_SIZE = 50;

interface OrderFilters {
  user: string;
  tradeNo: string;
  status: string;
  kind: string;
  paymentMethod: string;
  from: string;
  to: string;
}

const initialFilters: OrderFilters = {
  user: "",
  tradeNo: "",
  status: "",
  kind: "",
  paymentMethod: "",
  from: "",
  to: "",
};

export function OrdersPage() {
  const session = loadSession();
  if (!can(session, "ORDER_MANAGE")) return <div className="card muted">无权限访问此功能</div>;

  const [filters, setFilters] = useState<OrderFilters>(initialFilters);
  const [rows, setRows] = useState<api.OrderRow[]>([]);
  const [summary, setSummary] = useState<api.OrderSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const { show, node } = useToast();

  const load = async (nextOffset = offset, nextFilters = filters) => {
    setLoading(true);
    try {
      const result = await api.listOrders({
        user: nextFilters.user.trim() || undefined,
        tradeNo: nextFilters.tradeNo.trim() || undefined,
        status: nextFilters.status || undefined,
        kind: nextFilters.kind || undefined,
        paymentMethod: nextFilters.paymentMethod || undefined,
        from: nextFilters.from || undefined,
        to: nextFilters.to || undefined,
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      setRows(result.data);
      setSummary(result.summary);
      setTotal(result.total);
      setOffset(nextOffset);
    } catch (e) {
      show(errMsg(e), "err");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(0, initialFilters);
  }, []);

  const updateFilter = (key: keyof OrderFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const search = () => {
    void load(0);
  };

  const reset = () => {
    setFilters(initialFilters);
    void load(0, initialFilters);
  };

  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div>
      {node}
      <Panel
        title="订单管理"
        actions={
          <div className="row" style={{ margin: 0, gap: 8 }}>
            <button className="btn ghost sm" onClick={reset} disabled={loading}>
              重置
            </button>
            <button className="btn sm" onClick={search} disabled={loading}>
              {loading ? "加载中…" : "筛选"}
            </button>
          </div>
        }
      >
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
          <Field label="用户">
            <input
              value={filters.user}
              onChange={(e) => updateFilter("user", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="UID / 用户名 / 用户ID"
            />
          </Field>
          <Field label="交易号">
            <input
              value={filters.tradeNo}
              onChange={(e) => updateFilter("tradeNo", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="yc..."
            />
          </Field>
          <Field label="状态">
            <select value={filters.status} onChange={(e) => updateFilter("status", e.target.value)}>
              <option value="">全部</option>
              <option value="success">成功</option>
              <option value="pending">待支付</option>
              <option value="closed">已关闭</option>
            </select>
          </Field>
          <Field label="类型">
            <select value={filters.kind} onChange={(e) => updateFilter("kind", e.target.value)}>
              <option value="">全部</option>
              <option value="points">算力点充值</option>
              <option value="video_points">视频点充值</option>
              <option value="membership">月卡</option>
            </select>
          </Field>
          <Field label="支付方式">
            <select value={filters.paymentMethod} onChange={(e) => updateFilter("paymentMethod", e.target.value)}>
              <option value="">全部</option>
              <option value="alipay">支付宝</option>
              <option value="wxpay">微信</option>
            </select>
          </Field>
          <Field label="创建起始日">
            <input type="date" value={filters.from} onChange={(e) => updateFilter("from", e.target.value)} />
          </Field>
          <Field label="创建结束日">
            <input type="date" value={filters.to} onChange={(e) => updateFilter("to", e.target.value)} />
          </Field>
        </div>

        <StatStrip>
          <Stat label="订单总数" value={summary?.total ?? total} />
          <Stat label="成功订单" value={summary?.successCount ?? 0} />
          <Stat label="待支付" value={summary?.pendingCount ?? 0} />
          <Stat label="成功实付" value={formatFen(summary?.successAmountFen ?? 0)} />
          <Stat label="到账点数" value={(summary?.successPoints ?? 0).toLocaleString()} />
          <Stat label="付费用户" value={summary?.payingUsers ?? 0} />
        </StatStrip>

        <div className="row" style={{ justifyContent: "space-between", marginTop: 16 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            显示 {total === 0 ? 0 : offset + 1} - {Math.min(offset + rows.length, total)} / {total}
          </span>
          <span className="row" style={{ margin: 0, gap: 8 }}>
            <button className="btn ghost sm" disabled={!canPrev || loading} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}>
              上一页
            </button>
            <button className="btn ghost sm" disabled={!canNext || loading} onClick={() => void load(offset + PAGE_SIZE)}>
              下一页
            </button>
          </span>
        </div>

        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>交易号</th>
                <th>用户</th>
                <th style={{ textAlign: "right" }}>金额</th>
                <th style={{ textAlign: "right" }}>到账点数</th>
                <th>类型</th>
                <th>状态</th>
                <th>支付方式</th>
                <th>创建时间</th>
                <th>支付时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12 }}>{row.tradeNo}</td>
                  <td>{formatUser(row)}</td>
                  <td className="num">{formatFen(row.amountFen)}</td>
                  <td className="num">{row.points.toLocaleString()}</td>
                  <td>{formatKind(row.kind)}</td>
                  <td><OrderStatusPill status={row.status} /></td>
                  <td>{formatPayment(row.paymentMethod)}</td>
                  <td className="muted">{formatDate(row.createdAt)}</td>
                  <td className="muted">{row.paidAt ? formatDate(row.paidAt) : "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted" style={{ textAlign: "center" }}>
                    {loading ? "加载中…" : "无订单"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function formatFen(fen: number): string {
  return `¥${(fen / 100).toFixed(2)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return date.toLocaleString();
}

function formatUser(row: api.OrderRow): string {
  if (!row.user) return row.userId;
  return `${row.user.username} (${row.user.uid})`;
}

function formatKind(kind: string): string {
  if (kind === "membership") return "月卡";
  if (kind === "video_points") return "视频点充值";
  if (kind === "points" || kind === "") return "算力点充值";
  return kind;
}

function formatPayment(method: string): string {
  if (method === "alipay") return "支付宝";
  if (method === "wxpay") return "微信";
  return method || "—";
}

function OrderStatusPill({ status }: { status: string }) {
  if (status === "success") return <Pill kind="g">成功</Pill>;
  if (status === "pending") return <Pill kind="w">待支付</Pill>;
  if (status === "closed") return <Pill kind="b">已关闭</Pill>;
  return <Pill kind="n">{status || "未知"}</Pill>;
}
