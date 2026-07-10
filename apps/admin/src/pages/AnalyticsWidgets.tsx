import * as api from "../api.js";

export function formatSeconds(seconds: number): string {
  if (seconds <= 0) return "0 分";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}时${minutes}分` : `${minutes}分`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toFixed(value >= 10 || unit === 0 ? 0 : 1))} ${units[unit]}`;
}

/** 大数字紧凑缩写：1234 → 1.2K，344742901 → 344.7M（K/M/B）。小于 1000 原样。 */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  const units = [
    { v: 1e9, s: "B" },
    { v: 1e6, s: "M" },
    { v: 1e3, s: "K" },
  ];
  for (const u of units) {
    if (abs >= u.v) return `${Number((n / u.v).toFixed(1))}${u.s}`;
  }
  return String(n);
}

export function TrendChart({ data }: { data: api.DailyRow[] }) {
  if (data.length === 0) return null;
  const values = data.map((d) => d.revenueYuan);
  const maxValue = Math.max(...values, 1);
  const width = Math.max(400, Math.min(800, 16 * data.length));
  const height = 160;
  const padding = { top: 20, right: 20, bottom: 30, left: 40 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const points = data.map((d, i) => {
    const x = padding.left + (i / Math.max(1, data.length - 1)) * plotWidth;
    const y = padding.top + plotHeight - (d.revenueYuan / maxValue) * plotHeight;
    return { x, y };
  });
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ marginBottom: 12 }}>
      <defs>
        <pattern id="grid" width="50" height="1" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2={plotHeight} stroke="var(--line)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x={padding.left} y={padding.top} width={plotWidth} height={plotHeight} fill="url(#grid)" />
      <line x1={padding.left} y1={padding.top + plotHeight} x2={width - padding.right} y2={padding.top + plotHeight} stroke="var(--border)" strokeWidth="1" />
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + plotHeight} stroke="var(--border)" strokeWidth="1" />
      <text x={padding.left - 8} y={padding.top + 4} fontSize="11" textAnchor="end" fill="var(--ink3)">¥{maxValue.toFixed(0)}</text>
      <text x={padding.left - 8} y={padding.top + plotHeight} fontSize="11" textAnchor="end" fill="var(--ink3)">¥0</text>
      <path d={pathD} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="3" fill="var(--accent)" />)}
      {data.map((d, i) => {
        const showLabel = i === 0 || i === data.length - 1 || i % Math.ceil(data.length / 4) === 0;
        if (!showLabel) return null;
        const x = padding.left + (i / Math.max(1, data.length - 1)) * plotWidth;
        return <text key={i} x={x} y={height - 8} fontSize="10" textAnchor="middle" fill="var(--ink3)">{d.date.slice(5)}</text>;
      })}
    </svg>
  );
}

export function RankingTable({ title, rows }: { title: string; rows: api.RankingRow[] }) {
  return (
    <div>
      <h4 style={{ margin: "0 0 10px", fontSize: 13 }}>{title}</h4>
      <table className="tbl compact">
        <thead><tr><th>对象</th><th className="num">点数</th><th className="num">Token</th><th className="num">次数</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.key}><td className="muted">{row.key}</td><td className="num">{row.points}</td><td className="num">{row.tokens}</td><td className="num">{row.count}</td></tr>)}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">无数据</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function SalesTable({ title, rows }: { title: string; rows: api.SalesRow[] }) {
  return (
    <div>
      <h4 style={{ margin: "0 0 10px", fontSize: 13 }}>{title}</h4>
      <table className="tbl compact">
        <thead><tr><th>名称</th><th className="num">订单</th><th className="num">人数</th><th className="num">金额</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.key}><td>{row.name}</td><td className="num">{row.orders}</td><td className="num">{row.users}</td><td className="num">¥{(row.revenueFen / 100).toFixed(2)}</td></tr>)}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">无数据</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function CohortTable({ m, unit }: { m: api.CohortMatrix | null; unit: string }) {
  if (!m || m.cohorts.length === 0) return <div className="muted" style={{ textAlign: "center", padding: "16px" }}>无数据</div>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>队列日</th>
          <th style={{ textAlign: "right" }}>规模</th>
          {m.offsets.map((o) => <th key={o} style={{ textAlign: "right" }}>{o}日</th>)}
        </tr>
      </thead>
      <tbody>
        {m.cohorts.map((c) => (
          <tr key={c.cohortDate}>
            <td className="muted">{c.cohortDate}</td>
            <td className="num">{c.cohortSize}</td>
            {m.offsets.map((o) => {
              const v = c.cells[o];
              return <td key={o} className="num">{v === null || v === undefined ? "—" : unit === "%" ? `${(v * 100).toFixed(1)}%` : v.toFixed(2)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
