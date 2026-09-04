import { useEffect, useState } from "react";
import * as api from "../api.js";
import { errMsg, Modal, Stat, StatStrip } from "../ui.js";

interface UserDetailModalProps {
  userId: string | null;
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

export function UserDetailModal({ userId, onClose, onError }: UserDetailModalProps) {
  const [detail, setDetail] = useState<api.UserDetail | null>(null);
  const [expandedTimeline, setExpandedTimeline] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) {
      setDetail(null);
      setExpandedTimeline(new Set());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setExpandedTimeline(new Set());
    api.getUserDetail(userId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
      })
      .catch((e) => onError(errMsg(e)))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, onError]);

  const titleUser = detail?.user.username;

  const toggleTimeline = (key: string) => {
    setExpandedTimeline((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Modal open={!!userId} title={titleUser ? `用户详情 - ${titleUser}` : "用户详情"} onClose={onClose} width="960px">
      {loading && <div className="muted">加载中…</div>}
      {!loading && detail && (
        <div className="user-detail">
          <StatStrip>
            <Stat label="今日登录" value={detail.kpis.loginCountToday} />
            <Stat label="今日使用 Agent" value={detail.kpis.todayAgent} />
          </StatStrip>

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
