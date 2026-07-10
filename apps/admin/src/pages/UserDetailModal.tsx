import { useEffect, useState } from "react";
import * as api from "../api.js";
import { errMsg, Modal, Pill, Stat, StatStrip } from "../ui.js";

export type UserDetailMode = "full" | "billing";

interface UserDetailModalProps {
  userId: string | null;
  mode: UserDetailMode;
  onClose: () => void;
  onError: (message: string) => void;
}

const TIMELINE_PREVIEW_CHARS = 120;

const periodLabel: Record<string, string> = {
  today: "今日",
  week: "近 7 日",
  month: "近 30 日",
  total: "累计",
};

export function UserDetailModal({ userId, mode, onClose, onError }: UserDetailModalProps) {
  const [detail, setDetail] = useState<api.UserDetail | null>(null);
  const [billingLog, setBillingLog] = useState<api.UserBillingLog | null>(null);
  const [expandedTimeline, setExpandedTimeline] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) {
      setDetail(null);
      setBillingLog(null);
      setExpandedTimeline(new Set());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setExpandedTimeline(new Set());
    const request = mode === "full"
      ? api.getUserDetail(userId).then((data) => {
        if (cancelled) return;
        setDetail(data);
        setBillingLog(null);
      })
      : api.getUserBillingLog(userId).then((data) => {
        if (cancelled) return;
        setBillingLog(data);
        setDetail(null);
      });
    request
      .catch((e) => onError(errMsg(e)))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, mode, onError]);

  const titleUser = detail?.user.username ?? billingLog?.user.username;
  const titlePrefix = mode === "full" ? "用户详情" : "扣费日志";

  const toggleTimeline = (key: string) => {
    setExpandedTimeline((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Modal open={!!userId} title={titleUser ? `${titlePrefix} - ${titleUser}` : titlePrefix} onClose={onClose} width="960px">
      {loading && <div className="muted">加载中…</div>}
      {!loading && mode === "billing" && billingLog && (
        <div className="user-detail">
          <VipSummarySection vipSummary={billingLog.vipSummary} />
          <ConsumptionRecordsTable title="单用户扣费日志" records={billingLog.consumptionRecords} />
        </div>
      )}
      {!loading && mode === "full" && detail && (
        <div className="user-detail">
          <StatStrip>
            <Stat label="今日在线" value={detail.kpis.onlineToday ? "在线" : "离线"} />
            <Stat label="今日登录" value={detail.kpis.loginCountToday} />
            <Stat label="今日 Token" value={detail.kpis.todayToken} />
            <Stat label="今日使用 Agent" value={detail.kpis.todayAgent} />
            <Stat label="累计 Token" value={detail.kpis.totalToken} />
            <Stat label="今日充值" value={`¥${detail.kpis.todayRechargeYuan.toFixed(2)}`} />
            <Stat label="今日消费" value={detail.kpis.todayConsumptionPoints} />
            <Stat label="累计充值" value={`¥${detail.kpis.totalRechargeYuan.toFixed(2)}`} />
            <Stat label="累计消费" value={detail.kpis.totalConsumptionPoints} />
            <Stat label="余额" value={detail.kpis.balance ?? "—"} />
          </StatStrip>

          <div className="detail-section">
            <h4>当前会员 / 套餐</h4>
            <div className="row" style={{ margin: 0 }}>
              {detail.kpis.currentMemberships.length > 0 ? (
                detail.kpis.currentMemberships.map((item, idx) => <Pill key={idx} kind="g">{membershipName(item)}</Pill>)
              ) : <span className="muted">无有效会员</span>}
            </div>
          </div>

          <VipSummarySection vipSummary={detail.vipSummary} />

          <div className="detail-section">
            <h4>活跃与内容粒度</h4>
            <table className="tbl compact">
              <thead><tr><th>维度</th><th className="num">会话</th><th className="num">消息</th><th className="num">Agent 创建</th><th className="num">知识库</th><th className="num">文档</th><th className="num">图片任务</th></tr></thead>
              <tbody>
                {detail.activity.map((row) => (
                  <tr key={row.key}>
                    <td>{periodLabel[row.key] ?? row.key}</td>
                    <td className="num">{row.sessions}</td>
                    <td className="num">{row.messages}</td>
                    <td className="num">{row.agents}</td>
                    <td className="num">{row.knowledgeBases}</td>
                    <td className="num">{row.kbDocuments}</td>
                    <td className="num">{row.imageTasks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="detail-grid">
            <ConsumptionRecordsTable title="消费记录" records={detail.consumptionRecords} limit={8} />
            <DeviceTable devices={detail.devices} />
          </div>

          <div className="detail-section">
            <h4>用户时间线</h4>
            <div className="timeline-list">
              {detail.timeline.slice(0, 16).map((item) => {
                const key = `${item.type}:${item.meta}:${item.at}`;
                return (
                <div className="timeline-item" key={key}>
                  <span className="muted">{new Date(item.at).toLocaleString()}</span>
                  <strong>{item.type}</strong>
                  <TimelineTitle item={item} expanded={expandedTimeline.has(key)} onToggle={() => toggleTimeline(key)} />
                </div>
                );
              })}
              {detail.timeline.length === 0 && <div className="muted">无时间线事件</div>}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ConsumptionRecordsTable({ title, records, limit }: { title: string; records: api.UserConsumptionRecord[]; limit?: number }) {
  const visibleRecords = limit ? records.slice(0, limit) : records;
  return (
    <div className="detail-section">
      <h4>{title}</h4>
      <table className="tbl compact">
        <thead><tr><th>类型</th><th>对象</th><th>VIP</th><th className="num">原扣</th><th className="num">实扣</th><th className="num">成长</th><th className="num">Token</th></tr></thead>
        <tbody>
          {visibleRecords.map((row) => (
            <tr key={row.operationId}>
              <td>{row.type}</td>
              <td>{row.displayName || row.model}</td>
              <td>
                <div style={{ display: "grid", gap: 4 }}>
                  <span>{row.vipLevelName || "普通会员"}</span>
                  <span className="muted">{discountText(row.vipDiscountBps)}</span>
                </div>
              </td>
              <td className="num">{row.originalPoints}</td>
              <td className="num">{row.actualPoints}</td>
              <td className="num">{row.vipGrowthPoints}</td>
              <td className="num">{formatUsageTokens(row)}</td>
            </tr>
          ))}
          {visibleRecords.length === 0 && <tr><td colSpan={7} className="muted">无消费记录</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function VipSummarySection({ vipSummary }: { vipSummary: api.VipSummary | null }) {
  return (
    <div className="detail-section">
      <h4>VIP 状态</h4>
      {vipSummary ? (
        <div className="stats">
          <div className="stat">
            <div className="k">当前等级</div>
            <div className="v" style={{ fontSize: 20 }}>{vipSummary.levelName}</div>
          </div>
          <div className="stat">
            <div className="k">当前折扣</div>
            <div className="v" style={{ fontSize: 20 }}>{discountText(vipSummary.discountBps)}</div>
          </div>
          <div className="stat">
            <div className="k">成长点</div>
            <div className="v" style={{ fontSize: 20 }}>{vipSummary.growthPoints.toLocaleString()}</div>
          </div>
          <div className="stat">
            <div className="k">{vipSummary.highestLevel ? "等级进度" : `距 ${vipSummary.nextLevelName || "下一级"}`}</div>
            <div className="v" style={{ fontSize: 20 }}>
              {vipSummary.highestLevel ? "已满级" : vipSummary.pointsToNextLevel.toLocaleString()}
            </div>
          </div>
        </div>
      ) : (
        <div className="muted">暂无 VIP 信息</div>
      )}
    </div>
  );
}

function DeviceTable({ devices }: { devices: api.UserDetail["devices"] }) {
  return (
    <div className="detail-section">
      <h4>设备在线</h4>
      <table className="tbl compact">
        <thead><tr><th>类型</th><th>对象</th><th className="num">点数/状态</th><th className="num">Token/时长</th></tr></thead>
        <tbody>
          {devices.map((row) => (
            <tr key={row.id}>
              <td>{row.name ?? row.platform}</td>
              <td><Pill kind={row.online ? "g" : "n"}>{row.online ? "在线" : "离线"}</Pill></td>
              <td className="num">{formatSeconds(row.onlineSecondsToday)}</td>
              <td className="muted">{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : "—"}</td>
            </tr>
          ))}
          {devices.length === 0 && <tr><td colSpan={4} className="muted">无设备</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function TimelineTitle({ item, expanded, onToggle }: { item: api.UserDetail["timeline"][number]; expanded: boolean; onToggle: () => void }) {
  const canExpand = item.title.length > TIMELINE_PREVIEW_CHARS || item.title.includes("\n");
  const text = canExpand && !expanded ? `${item.title.slice(0, TIMELINE_PREVIEW_CHARS)}...` : item.title;
  const toggleLabel = expanded ? "收起" : item.type === "message" ? "展开完整聊天记录" : "展开完整记录";
  return (
    <span className="timeline-title">
      <span className="timeline-title-text">{text}</span>
      {canExpand && (
        <button type="button" className="link-btn timeline-toggle" onClick={onToggle}>
          {toggleLabel}
        </button>
      )}
    </span>
  );
}

function membershipName(item: unknown): string {
  const name = item && typeof item === "object" ? Object.getOwnPropertyDescriptor(item, "name")?.value : undefined;
  if (typeof name === "string") return name;
  const cardId = item && typeof item === "object" ? Object.getOwnPropertyDescriptor(item, "cardId")?.value : undefined;
  if (cardId !== undefined) return `套餐 #${String(cardId)}`;
  return "会员";
}

function formatUsageTokens(row: api.UserConsumptionRecord): number {
  return row.inputTokens + row.outputTokens + row.cacheInputTokens + row.cacheOutputTokens;
}

function formatSeconds(seconds: number): string {
  if (seconds <= 0) return "0 分";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}时${minutes}分` : `${minutes}分`;
}

function discountText(discountBps: number): string {
  if (discountBps >= 10000) return "无折扣";
  return `${Number((discountBps / 1000).toFixed(1))} 折`;
}
