import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Panel, Pill } from "../ui.js";
import { can, loadSession } from "../auth.js";

const ACTION_LABELS: Record<string, { label: string; kind: "g" | "w" | "b" | "n" }> = {
  create: { label: "创建", kind: "g" },
  update: { label: "更新", kind: "w" },
  delete: { label: "删除", kind: "b" },
  disable: { label: "禁用", kind: "b" },
  enable: { label: "启用", kind: "g" },
  login: { label: "登录", kind: "g" }
};

export function AuditPage() {
  const session = loadSession();
  if (!can(session, "ADMIN_MANAGE")) return <div className="card muted">无权限访问此功能</div>;
  const [rows, setRows] = useState<api.AuditRow[]>([]);
  const { show, node: toastNode } = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setRows(await api.listAudit(200));
      } catch (e) {
        show(errMsg(e), "err");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {toastNode}
      <Panel title="审计日志">
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>管理员</th>
                <th>目标</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const actionInfo = ACTION_LABELS[a.action] || { label: a.action, kind: "n" };
                return (
                  <tr key={a.id}>
                    <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
                    <td>
                      <Pill kind={actionInfo.kind}>{actionInfo.label}</Pill>
                    </td>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{a.adminId}</td>
                    <td className="muted">{a.target ?? "—"}</td>
                    <td>
                      {a.detail ? (
                        <div>
                          <code style={{ fontSize: 11, color: "var(--ink3)" }}>
                            {JSON.stringify(a.detail).substring(0, 50)}
                            {JSON.stringify(a.detail).length > 50 ? "..." : ""}
                          </code>
                          {expandedId === a.id && (
                            <pre style={{ fontSize: 11, margin: "4px 0 0 0", padding: "4px", backgroundColor: "var(--surface2)", borderRadius: 4, overflow: "auto", maxHeight: 200 }}>
                              {JSON.stringify(a.detail, null, 2)}
                            </pre>
                          )}
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={5} className="muted">暂无审计日志</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
