/**
 * 审计日志：服务端最近 200 条，按时间倒序。
 *
 * 重写时收掉的几处：
 * 1. `ACTION_LABELS` 的键是 `create` / `update` / `delete` / `login` 这类小写词，
 *    而服务端写进库的是 `USER_BAN` / `KB_DOC_CREATE` / `ANNOUNCEMENT_UPDATE` 这种
 *    「对象_动作」的大写码（`apps/api/src/admin/routes.ts` 里全是这么写的），
 *    于是**每一行都命中 fallback**：徽标一律灰色、文案一律原样的英文大写码。
 *    而且那张表里的 `login` 根本没有生产者 —— 登录不写审计。
 *    现在不再逐条枚举，而是把动作码按最后一个下划线拆成「对象 + 动作」两段分别翻译，
 *    服务端将来加 `XXX_DELETE` 也能自动出中文；认不出的照旧原样显示。
 * 2. 展开整段 JSON 那个 `<pre>` 是死代码 —— `setExpandedId` 从来没被调用过，
 *    所以详情永远截在 50 个字符。现在摘要本身就是展开键。
 * 3. 每行 `JSON.stringify(a.detail)` 算三遍（截断、判长度、展开各一次），现在算一遍。
 * 4. 权限门禁写在 useState 之前，分支一变 hook 数目就对不上；改成外层门禁 + 内层控制台。
 * 5. 列表没有加载态：第一帧就摆着「暂无审计日志」。
 */
import { useEffect, useState } from "react";
import * as api from "../api.js";
import { can, loadSession } from "../auth.js";
import { errMsg, Panel, Pill, type PillKind, useToast } from "../ui.js";

/** 摘要最多显示这么多字符，超了给展开键。 */
const BRIEF_CHARS = 50;

/** 动作码的后半段：做了什么。徽标颜色跟着动作走。 */
const VERBS: Record<string, { readonly label: string; readonly kind: PillKind }> = {
  CREATE: { label: "新建", kind: "g" },
  UPDATE: { label: "更新", kind: "w" },
  DELETE: { label: "删除", kind: "b" },
  BAN: { label: "封禁", kind: "b" },
  UNBAN: { label: "解封", kind: "g" },
};

/** 动作码的前半段：对谁做。 */
const SUBJECTS: Record<string, string> = {
  USER: "用户",
  ADMIN: "管理员",
  ANNOUNCEMENT: "公告",
  KB: "知识库",
  KB_DOC: "知识库文档",
  CLIENT_MENU_VISIBILITY: "用户端菜单",
};

/** `KB_DOC_CREATE` → 「新建知识库文档」。拆不开或者两段有一段认不出，就原样显示。 */
function describeAction(action: string): { label: string; kind: PillKind } {
  const cut = action.lastIndexOf("_");
  const verb = cut < 0 ? undefined : VERBS[action.slice(cut + 1)];
  const subject = cut < 0 ? undefined : SUBJECTS[action.slice(0, cut)];
  if (!verb || !subject) return { label: action, kind: "n" };
  return { label: `${verb.label}${subject}`, kind: verb.kind };
}

export function AuditPage() {
  // 门禁不拿 hook，见 Admins.tsx 同一处理
  if (!can(loadSession(), "ADMIN_MANAGE")) return <div className="card muted">无权限访问此功能</div>;
  return <AuditLog />;
}

function AuditLog() {
  const [rows, setRows] = useState<readonly api.AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { show, node: toastNode } = useToast();

  useEffect(() => {
    let cancelled = false;
    api
      .listAudit(200)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((error) => {
        if (!cancelled) show(errMsg(error), "err");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [show]);

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
              {rows.map((row) => {
                const action = describeAction(row.action);
                return (
                  <tr key={row.id}>
                    <td className="muted">{new Date(row.createdAt).toLocaleString()}</td>
                    <td>
                      <Pill kind={action.kind}>{action.label}</Pill>
                    </td>
                    <td className="audit-actor">{row.adminId}</td>
                    <td className="muted">{row.target ?? "—"}</td>
                    <td>
                      <AuditDetail detail={row.detail} />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="muted">
                    暂无审计日志
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

/** 详情列：一行摘要，长了点开看整段。JSON 只序列化一次，原来一行算三遍。 */
function AuditDetail({ detail }: { detail: unknown }) {
  const [open, setOpen] = useState(false);
  if (detail === null || detail === undefined) return <span className="muted">—</span>;

  const text = JSON.stringify(detail);
  if (text === undefined) return <span className="muted">—</span>;
  if (text.length <= BRIEF_CHARS) return <code className="audit-brief">{text}</code>;

  return (
    <div>
      <button type="button" className="link-btn audit-brief" onClick={() => setOpen(!open)}>
        {open ? "收起" : `${text.slice(0, BRIEF_CHARS)}...`}
      </button>
      {open && <pre className="audit-json">{JSON.stringify(detail, null, 2)}</pre>}
    </div>
  );
}
