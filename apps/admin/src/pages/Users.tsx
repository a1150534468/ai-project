/**
 * 用户列表：搜索 / 翻页 / 封禁 / 建号 / 看详情。
 *
 * 重写时收掉的几处：
 * 1. 「初始密码」输入框没有 `type="password"` —— 建号时密码明文摆在页面上。
 * 2. 取数原来是命令式的 `load(targetPage = page, term = committedQ)`，默认参数读的是 state，
 *    调用点散在六处，过期响应靠一个自增的 `useRef` 序号丢弃。现在只有一个查询态，
 *    effect 跟着它跑，过期结果交给 effect 自己的 cleanup —— 序号计数器整个不需要了。
 * 3. 页码越界（数据被删导致总数缩水）原来在 `load` 里再 await 一次；现在只把页码挪到末页，
 *    effect 自然重跑，两次请求走同一条路径。
 * 4. 首次加载时表格里就摆着「无数据」那一行，看着像真的空；现在加载中不显示它。
 * 5. `banned ? await api.unbanUser(...) : await api.banUser(...)` —— 三元当语句用，改成 if/else。
 * 6. 建用户的提交键在请求飞行中没禁用，连点会建两个账号。
 */
import { type FormEvent, useEffect, useState } from "react";
import * as api from "../api.js";
import { can, loadSession } from "../auth.js";
import { errMsg, Pill, type ToastKind, useConfirm, useToast } from "../ui.js";
import { UserDetailModal } from "./UserDetailModal.js";

const PAGE_SIZE = 20;

/** 一次列表查询。`nonce` 只为「条件没变也要再取一次」（增删改之后刷新）而存在。 */
interface Query {
  readonly term: string;
  readonly page: number;
  readonly nonce: number;
}

export function UsersPage() {
  const session = loadSession();
  const [query, setQuery] = useState<Query>({ term: "", page: 1, nonce: 0 });
  // 输入框里还没提交的词单独放：翻页用的是已提交的那个，不会被半句话带跑
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<api.AdminUserPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  const { show, node: toastNode } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listUsers(query.term || undefined, query.page, PAGE_SIZE)
      .then((data) => {
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        // 越界页：挪到末页，让 effect 自己再跑一遍，别在这儿嵌第二个 await
        if (data.rows.length === 0 && data.total > 0 && data.page > lastPage) {
          setQuery((cur) => ({ ...cur, page: lastPage }));
          return;
        }
        setResult(data);
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        show(errMsg(error), "err");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, show]);

  const rows = result?.rows ?? [];
  const total = result?.total ?? 0;
  // 页码与总数都以服务端回的为准：它会把越界值夹回合法范围
  const page = result?.page ?? query.page;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canManage = can(session, "USER_MANAGE");
  const canViewDetail = can(session, "USER_DETAIL_VIEW");

  const reload = () => setQuery((cur) => ({ ...cur, nonce: cur.nonce + 1 }));

  async function toggleBan(user: api.AdminUser) {
    const banned = user.bannedAt !== null;
    const action = banned ? "解封" : "封禁";
    const ok = await confirm({
      title: action,
      message: `确认${action}用户 ${user.username}(${user.uid})?`,
      confirmText: action,
      danger: !banned,
    });
    if (!ok) return;
    try {
      if (banned) await api.unbanUser(user.id);
      else await api.banUser(user.id);
      show("已更新");
      reload();
    } catch (error) {
      show(errMsg(error), "err");
    }
  }

  return (
    <div>
      {toastNode}
      {confirmNode}
      <div className="row">
        <form
          className="row"
          style={{ margin: 0 }}
          onSubmit={(event) => {
            event.preventDefault();
            setQuery({ term: draft.trim(), page: 1, nonce: 0 });
          }}
        >
          <input
            aria-label="按 UID / 用户名搜索"
            placeholder="按 UID / 用户名搜索"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="btn" type="submit" disabled={loading}>
            {loading ? "加载中…" : "搜索"}
          </button>
        </form>
        {canManage && <CreateUser onCreated={reload} onNotify={show} />}
      </div>

      <table className="tbl">
        <thead>
          <tr>
            <th>UID</th>
            <th>用户名</th>
            <th>状态</th>
            <th>注册时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((user) => (
            <tr key={user.id}>
              <td>{user.uid}</td>
              <td>{user.username}</td>
              <td>
                <Pill kind={user.bannedAt ? "b" : "g"}>{user.bannedAt ? "已封禁" : "正常"}</Pill>
              </td>
              <td className="muted">{new Date(user.createdAt).toLocaleString()}</td>
              <td>
                <div style={{ display: "flex", gap: 4 }}>
                  {canManage && (
                    <button
                      className={user.bannedAt ? "btn sm ghost" : "btn sm danger"}
                      type="button"
                      onClick={() => void toggleBan(user)}
                    >
                      {user.bannedAt ? "解封" : "封禁"}
                    </button>
                  )}
                  {canViewDetail && (
                    <button className="btn ghost sm" type="button" onClick={() => setDetailId(user.id)}>
                      详情
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {/* 加载中不摆「无数据」：首屏那一瞬间看着像真的空 */}
          {rows.length === 0 && !loading && (
            <tr>
              <td colSpan={5} className="muted">
                无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="row" style={{ marginBottom: 0 }}>
        <button
          className="btn ghost sm"
          type="button"
          disabled={loading || page <= 1}
          onClick={() => setQuery((cur) => ({ ...cur, page: page - 1 }))}
        >
          上一页
        </button>
        <span className="muted">
          第 {page} / {totalPages} 页 · 共 {total} 人
        </span>
        <button
          className="btn ghost sm"
          type="button"
          disabled={loading || page >= totalPages}
          onClick={() => setQuery((cur) => ({ ...cur, page: page + 1 }))}
        >
          下一页
        </button>
      </div>

      <UserDetailModal userId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

/**
 * 建用户：收起时只是一个按钮，展开是一张两格的小表单。
 * 长度门槛（用户名 ≥3、密码 ≥8）与服务端一致，请求飞行中整张表单禁用。
 */
function CreateUser({
  onCreated,
  onNotify,
}: {
  onCreated: () => void;
  onNotify: (text: string, kind?: ToastKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !busy && username.length >= 3 && password.length >= 8;

  function close() {
    setOpen(false);
    setUsername("");
    setPassword("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await api.createUser(username, password);
      close();
      onNotify("已创建");
      onCreated();
    } catch (error) {
      onNotify(errMsg(error), "err");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn gray" type="button" onClick={() => setOpen(true)}>
        + 建用户
      </button>
    );
  }
  return (
    <form className="row" style={{ margin: 0 }} onSubmit={submit}>
      <input
        aria-label="用户名(≥3)"
        placeholder="用户名(≥3)"
        autoComplete="off"
        value={username}
        disabled={busy}
        onChange={(event) => setUsername(event.target.value)}
      />
      <input
        aria-label="初始密码(≥8)"
        placeholder="初始密码(≥8)"
        type="password"
        autoComplete="new-password"
        value={password}
        disabled={busy}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button className="btn" type="submit" disabled={!ready}>
        提交
      </button>
      <button className="btn gray" type="button" disabled={busy} onClick={close}>
        取消
      </button>
    </form>
  );
}
