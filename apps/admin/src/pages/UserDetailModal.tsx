/**
 * 用户详情弹窗：两枚 KPI + 活跃度表 + 时间线。
 *
 * 重写时收掉的几处：
 * 1. `detail.timeline.slice(0, 16)` —— 服务端一次回 80 条（`buildAdminUserDetail` 里切的），
 *    这里再切 16 条，剩下 64 条无声丢掉，页面上也不说「只显示前 16 条」。现在全渲染。
 * 2. 加载失败原来往父组件的 toast 喊一句 `onError(errMsg(e))`，而 `onError` 是父组件
 *    每次渲染新建的闭包、又进了本组件 effect 的依赖 —— 父组件一渲染就重新拉一次详情。
 *    现在失败就在弹窗自己的正文里显示，带一个重试键，那个 prop 整个不要了。
 * 3. `.catch()` 里没看 `cancelled`：弹窗关掉之后失败的请求照样弹一条错。
 * 4. 时间线的类型原样显示英文 `session` / `message`，现在按中文口径映射。
 * 5. loading / detail 两个互斥状态原来是两个 useState，用 `!loading && detail &&` 拼出来；
 *    现在是一个判别联合，四种相位互斥由类型保证。
 */
import { useEffect, useState } from "react";
import * as api from "../api.js";
import { errMsg, Modal, Stat, StatStrip } from "../ui.js";

/** 超过这个长度（或含换行）的标题折起来，给一个展开键。 */
const PREVIEW_CHARS = 120;

const PERIOD_LABEL: Record<string, string> = {
  today: "今日",
  week: "近 7 日",
  month: "近 30 日",
  total: "累计",
};

/** 服务端时间线的五类事件，见 `buildAdminUserDetail`。认不出的原样显示。 */
const EVENT_LABEL: Record<string, string> = {
  session: "会话",
  message: "消息",
  agent: "Agent",
  kb: "知识库",
  image: "生图",
};

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly detail: api.UserDetail };

export function UserDetailModal({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  // 重试键靠它把 effect 再踢一遍
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setPhase({ kind: "loading" });
    setExpanded(new Set());
    api
      .getUserDetail(userId)
      .then((detail) => {
        if (!cancelled) setPhase({ kind: "ready", detail });
      })
      .catch((error) => {
        // 关掉弹窗之后失败的请求不该再冒出来
        if (!cancelled) setPhase({ kind: "error", message: errMsg(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [userId, attempt]);

  const user = phase.kind === "ready" ? phase.detail.user.username : null;

  function toggle(index: number) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  }

  return (
    <Modal open={userId !== null} title={user ? `用户详情 - ${user}` : "用户详情"} onClose={onClose} width="960px">
      {phase.kind === "loading" && <div className="muted">加载中…</div>}
      {phase.kind === "error" && (
        <div className="row" style={{ marginBottom: 0 }}>
          <span className="muted">加载失败：{phase.message}</span>
          <button className="btn ghost sm" type="button" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
      {phase.kind === "ready" && (
        <div className="user-detail">
          <StatStrip>
            <Stat label="今日登录" value={phase.detail.kpis.loginCountToday} />
            <Stat label="今日使用 Agent" value={phase.detail.kpis.todayAgent} />
          </StatStrip>

          <section className="detail-section">
            <h4>活跃与内容粒度</h4>
            <ActivityTable rows={phase.detail.activity} />
          </section>

          <section className="detail-section">
            <h4>用户时间线（{phase.detail.timeline.length} 条）</h4>
            <div className="timeline-list">
              {phase.detail.timeline.map((item, index) => (
                <div className="timeline-item" key={`${item.at}:${item.type}:${index}`}>
                  <span className="muted">{new Date(item.at).toLocaleString()}</span>
                  <strong>{EVENT_LABEL[item.type] ?? item.type}</strong>
                  <TimelineText item={item} expanded={expanded.has(index)} onToggle={() => toggle(index)} />
                </div>
              ))}
              {phase.detail.timeline.length === 0 && <div className="muted">无时间线事件</div>}
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}

/**
 * 活跃度表：列名与取值放在一张表里，表头与单元格都从它出。
 * 原来是 7 个手写 `<th>` 对着 7 个手写 `<td>`，加一列要改两处、还得自己数对不对齐。
 */
const ACTIVITY_COLUMNS: readonly { readonly label: string; readonly of: (row: api.UserActivityPeriod) => number }[] = [
  { label: "会话", of: (row) => row.sessions },
  { label: "消息", of: (row) => row.messages },
  { label: "Agent 创建", of: (row) => row.agents },
  { label: "知识库", of: (row) => row.knowledgeBases },
  { label: "文档", of: (row) => row.kbDocuments },
  { label: "图片任务", of: (row) => row.imageTasks },
];

function ActivityTable({ rows }: { rows: readonly api.UserActivityPeriod[] }) {
  return (
    <table className="tbl compact">
      <thead>
        <tr>
          <th>维度</th>
          {ACTIVITY_COLUMNS.map((column) => (
            <th className="num" key={column.label}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{PERIOD_LABEL[row.key] ?? row.key}</td>
            {ACTIVITY_COLUMNS.map((column) => (
              <td className="num" key={column.label}>
                {column.of(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 时间线的正文：长标题折起来，展开键的文案按事件类型换一档。 */
function TimelineText({
  item,
  expanded,
  onToggle,
}: {
  item: api.UserTimelineItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const foldable = item.title.length > PREVIEW_CHARS || item.title.includes("\n");
  return (
    <span className="timeline-title">
      <span className="timeline-title-text">
        {foldable && !expanded ? `${item.title.slice(0, PREVIEW_CHARS)}...` : item.title}
      </span>
      {foldable && (
        <button type="button" className="link-btn timeline-toggle" onClick={onToggle}>
          {expanded ? "收起" : item.type === "message" ? "展开完整聊天记录" : "展开完整记录"}
        </button>
      )}
    </span>
  );
}
