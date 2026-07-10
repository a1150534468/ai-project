import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Panel, Stat, StatStrip } from "../ui.js";

export function MyChannelPage() {
  const [summary, setSummary] = useState<api.ChannelSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState(false);
  const [users, setUsers] = useState<api.MyChannelUsers | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [columnKeys, setColumnKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { show, node: toastNode } = useToast();

  const loadSummary = async () => {
    try {
      const data = await api.myChannelSummary();
      setSummary(data);
      setSummaryErr(false);
    } catch (e) {
      setSummaryErr(true);
      setSummary(null);
    }
  };

  const loadUsers = async (p: number) => {
    setBusy(true);
    try {
      const data = await api.myChannelUsers(p, pageSize);
      setUsers(data);
      if (data.rows.length > 0) {
        setColumnKeys(Object.keys(data.rows[0]));
      }
    } catch (e) {
      show(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void loadSummary();
    void loadUsers(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const handlePrevPage = () => {
    if (page > 1) setPage(page - 1);
  };

  const handleNextPage = () => {
    if (users && page < Math.ceil(users.total / pageSize)) setPage(page + 1);
  };

  const formatCellValue = (key: string, value: unknown): React.ReactNode => {
    if (value === null || value === undefined) return "-";
    if (key.endsWith("Fen") || key === "totalRechargeFen") {
      return ((value as number) / 100).toFixed(2);
    }
    if (key === "createdAt" || key === "lastActiveAt") {
      return new Date(value as string).toLocaleString();
    }
    if (typeof value === "boolean") return value ? "是" : "否";
    return String(value);
  };

  return (
    <div>
      {toastNode}
      <Panel title="我的渠道 - KPI">
        {summaryErr ? (
          <p className="muted">数据暂不可用</p>
        ) : summary ? (
          <StatStrip>
            <Stat label="用户数" value={summary.totalUsers} />
            <Stat label="总充值（元）" value={(summary.totalRechargeFen / 100).toFixed(2)} />
            <Stat label="我的分成累计（元）" value={(summary.commissionFen / 100).toFixed(2)} />
          </StatStrip>
        ) : (
          <p className="muted">加载中…</p>
        )}
      </Panel>

      <Panel title="用户列表">
        {!users ? (
          <p className="muted">加载中…</p>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead>
                  <tr>
                    {columnKeys.map((key) => (
                      <th key={key}>{renderColumnHeader(key)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.rows.length > 0 ? (
                    users.rows.map((row, idx) => (
                      <tr key={idx}>
                        {columnKeys.map((key) => (
                          <td key={key} className={key.startsWith("total") || key.endsWith("Fen") ? "muted" : ""}>
                            {formatCellValue(key, (row as Record<string, unknown>)[key])}
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={columnKeys.length} className="muted">暂无用户</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 12 }}>
                第 {page} 页，共 {Math.ceil(users.total / pageSize)} 页
              </span>
              <button
                className="btn sm ghost"
                onClick={handlePrevPage}
                disabled={page === 1 || busy}
              >
                上一页
              </button>
              <button
                className="btn sm ghost"
                onClick={handleNextPage}
                disabled={page >= Math.ceil(users.total / pageSize) || busy}
              >
                下一页
              </button>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

function renderColumnHeader(key: string): string {
  const headerMap: Record<string, string> = {
    uid: "用户ID",
    username: "用户名",
    createdAt: "创建时间",
    totalRechargeFen: "总充值（元）",
    totalRechargeOrders: "充值次数",
    totalConsumptionPoints: "总消费点数",
    membership: "会员",
    lastActiveAt: "最后活跃",
  };
  return headerMap[key] || key;
}
