/**
 * 后台外壳：没会话给登录页，有会话是「深色侧栏 + 顶栏 + 内容区」。
 *
 * 重写时收掉的几处：
 * 1. 登录框里按回车绕过了按钮的禁用条件 —— 用户名或密码空着也能发出一次请求。
 *    现在回车与点击走同一张真 `<form>` 的提交，条件只写一处。
 * 2. `getNavIcon()` 在函数体里现建一张含 7 枚内联 SVG 的表，每渲染一个导航项就重建一次。
 *    图标改成模块级常量；顺带发现表里的 `models` 没有任何 tab 用得上，
 *    而「用户」和「管理员」用的是同一枚图标（侧栏两项看着一模一样）。
 * 3. 顶栏右侧的 `.top-actions` 是个空 `<div>`，连 index.css 里那条规则一起收掉。
 * 4. 导航分组原来是「嵌套的组表 + flatMap 展平 + 再按可见项过滤回去」三步。
 *    现在 tab 表是平的，每条自带组名，分组按出现顺序推出来。
 *
 * 可达性上补的：当前项带 `aria-current`，窄屏抽屉的汉堡键带 `aria-expanded`/`aria-controls`，
 * 抽屉开着时按 Esc 收起 —— 原来只能点遮罩，键盘用不了。
 */
import { type FormEvent, type ReactNode, useState } from "react";
import * as api from "./api.js";
import { can, clearSession, loadSession, saveSession, type Permission, type Session } from "./auth.js";
import { AdminsPage } from "./pages/Admins.js";
import { AnnouncementsPage } from "./pages/Announcements.js";
import { AuditPage } from "./pages/Audit.js";
import { ClientMenusPage } from "./pages/ClientMenus.js";
import { KnowledgePage } from "./pages/Knowledge.js";
import { UsersPage } from "./pages/Users.js";
import { errMsg, useEscapeKey, useToast } from "./ui.js";

/* ——— 导航图标 ———
 * 都是 24 格坐标系里的纯几何图元（圆 / 矩形 / 折线 / 圆弧），16px 下比细笔画的线稿更清楚。
 * 一律 aria-hidden：紧挨着就是 .nav-label 的文字，读屏念一遍就够。
 */

const SVG = { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", "aria-hidden": true } as const;

/** 一前一后两个人形：前面整个头 + 肩，后面只露半个头和一段肩。 */
const ICON_USERS = (
  <svg {...SVG}>
    <circle cx="9.5" cy="8" r="3.5" />
    <path d="M3 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 4.8a3.5 3.5 0 0 1 0 6.4" />
    <path d="M18 13.8A6.5 6.5 0 0 1 21 19.4" />
  </svg>
);

/** 六边盾 + 对勾：这一页管的是账号与权限。 */
const ICON_ADMINS = (
  <svg {...SVG}>
    <polygon points="12 2.5 19.5 6 19.5 12 12 21.5 4.5 12 4.5 6" />
    <polyline points="8.8 11.8 11.2 14.2 15.4 9.4" />
  </svg>
);

/** 喇叭：左边一截握把，右边张开的口，再加一道声波。 */
const ICON_ANNOUNCEMENT = (
  <svg {...SVG}>
    <path d="M4 9.5H7.5L14 5V19L7.5 14.5H4Z" />
    <path d="M17.5 9.8a3.5 3.5 0 0 1 0 4.4" />
  </svg>
);

/** 一页带两行字的文档。 */
const ICON_KB = (
  <svg {...SVG}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <line x1="8.5" y1="8.5" x2="15.5" y2="8.5" />
    <line x1="8.5" y1="12.5" x2="15.5" y2="12.5" />
  </svg>
);

/** 一个带侧栏的窗口 —— 管的就是用户端那排菜单。 */
const ICON_CLIENT_MENU = (
  <svg {...SVG}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <line x1="9" y1="4.5" x2="9" y2="19.5" />
  </svg>
);

/** 钟：审计日志按时间倒序排。 */
const ICON_AUDIT = (
  <svg {...SVG}>
    <circle cx="12" cy="12" r="8.5" />
    <polyline points="12 7 12 12 15.5 14.5" />
  </svg>
);

/* ——— tab 表 ——— */

interface Tab {
  readonly key: string;
  /** 侧栏分组名。同组必须相邻 —— 分组是按出现顺序推的，见 navGroups */
  readonly group: string;
  readonly label: string;
  readonly perm: Permission;
  readonly icon: ReactNode;
  readonly render: () => ReactNode;
}

const TABS: readonly Tab[] = [
  { key: "users", group: "运营", label: "用户", perm: "USER_MANAGE", icon: ICON_USERS, render: () => <UsersPage /> },
  { key: "ann", group: "运营", label: "公告", perm: "ANNOUNCEMENT_MANAGE", icon: ICON_ANNOUNCEMENT, render: () => <AnnouncementsPage /> },
  { key: "kb", group: "配置", label: "官方知识库", perm: "KNOWLEDGE_MANAGE", icon: ICON_KB, render: () => <KnowledgePage /> },
  { key: "clientmenu", group: "配置", label: "用户端菜单", perm: "ADMIN_MANAGE", icon: ICON_CLIENT_MENU, render: () => <ClientMenusPage /> },
  { key: "admins", group: "系统", label: "管理员", perm: "ADMIN_MANAGE", icon: ICON_ADMINS, render: () => <AdminsPage /> },
  { key: "audit", group: "系统", label: "审计", perm: "ADMIN_MANAGE", icon: ICON_AUDIT, render: () => <AuditPage /> },
];

interface NavGroup {
  readonly label: string;
  readonly items: Tab[];
}

/** 相邻同组名的合成一组：组名本身当 key，不用再另起一列 groupKey。 */
function navGroups(tabs: readonly Tab[]): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const tab of tabs) {
    const last = groups.at(-1);
    if (last && last.label === tab.group) last.items.push(tab);
    else groups.push({ label: tab.group, items: [tab] });
  }
  return groups;
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  if (!session) return <Login onLogin={setSession} />;
  return (
    <Shell
      session={session}
      tabs={TABS.filter((tab) => can(session, tab.perm))}
      onLogout={() => {
        clearSession();
        setSession(null);
      }}
    />
  );
}

/**
 * 登录页。用真 `<form>`：回车走的是浏览器的隐式提交，和点按钮同一条路。
 * 提交条件只有 `ready` 这一处 —— 既决定按钮禁不禁用，也在 onSubmit 里拦一次
 * （按钮禁用时隐式提交本来就不会发生，但条件写在处理器里才算真的只有一份）。
 */
function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();
  const ready = !busy && username !== "" && password !== "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const session = await api.login(username, password);
      saveSession(session);
      onLogin(session);
    } catch (error) {
      show(errMsg(error), "err");
      setBusy(false);
    }
    // 成功时不复位 busy：这一刻整棵树已经换成 Shell，setState 只会打到卸载的组件上
  }

  return (
    <div className="login-page">
      {node}
      <div className="login-container">
        <div className="login-brand">
          <div className="brand-logo">AI</div>
          <div className="brand-name">AI 助手</div>
          <div className="brand-desc">运营控制台</div>
        </div>
        <form className="login-form" onSubmit={submit}>
          {/* 视觉上只有 placeholder，读屏要靠 aria-label */}
          <input
            aria-label="管理员用户名"
            placeholder="管理员用户名"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={busy}
          />
          <input
            aria-label="密码"
            placeholder="密码"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          <button className="btn" type="submit" disabled={!ready}>
            {busy ? "登录中…" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}

/** 侧栏底部那块的两套称呼，按 role 取。原来是四个散在 JSX 里的三元。 */
const ROLE_TEXT = {
  super_admin: { badge: "超", name: "超级管理员" },
  admin: { badge: "管", name: "管理员" },
} as const;

/** 汉堡键：三条横线一笔画完。 */
const ICON_MENU = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" aria-hidden={true}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

function Shell({ session, tabs, onLogout }: { session: Session; tabs: readonly Tab[]; onLogout: () => void }) {
  const [activeKey, setActiveKey] = useState(tabs[0]?.key ?? "");
  const [drawer, setDrawer] = useState(false);
  // 抽屉是浮层，键盘用户得有出路：原来只能点遮罩
  useEscapeKey(drawer, () => setDrawer(false));

  // 权限被改小后 activeKey 可能指向一个已经看不见的 tab，退回第一个
  const current = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];
  const role = ROLE_TEXT[session.role];

  return (
    <div className="frame">
      <aside id="admin-nav" className={drawer ? "side open" : "side"}>
        <div className="brand">
          <div className="brand-logo">AI</div>
          <div className="brand-info">
            <div className="brand-name">AI 助手</div>
            <div className="brand-desc">运营控制台</div>
          </div>
        </div>

        <nav className="nav-container" aria-label="功能导航">
          {navGroups(tabs).map((group) => (
            <div className="navgrp" key={group.label}>
              <div className="navgrp-label">{group.label}</div>
              {group.items.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={tab.key === current?.key ? "nav-item active" : "nav-item"}
                  aria-current={tab.key === current?.key ? "page" : undefined}
                  onClick={() => {
                    setActiveKey(tab.key);
                    setDrawer(false);
                  }}
                >
                  <span className="nav-icon">{tab.icon}</span>
                  <span className="nav-label">{tab.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="profile-zone">
          <div className="profile-avatar">{role.badge}</div>
          <div className="profile-info">
            <div className="profile-name">{role.name}</div>
            <div className="profile-role">{session.adminId}</div>
          </div>
          <button className="profile-logout" type="button" onClick={onLogout}>
            登出
          </button>
        </div>
      </aside>

      <div className="right-col">
        <header className="top">
          <button
            className="hamburger"
            type="button"
            aria-label={drawer ? "收起导航" : "展开导航"}
            aria-expanded={drawer}
            aria-controls="admin-nav"
            onClick={() => setDrawer(!drawer)}
          >
            {ICON_MENU}
          </button>

          {/* 组名直接取自当前 tab —— 原来要拿 key 回头去组表里反查一遍 */}
          {current && (
            <div className="top-breadcrumbs">
              <span className="breadcrumb-group">{current.group}</span>
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-page">{current.label}</span>
            </div>
          )}

          <h1 className="top-title">{current?.label ?? "未选择"}</h1>
        </header>

        <main className="body">
          {current ? current.render() : <p className="muted">无可用功能（当前账号未被授予任何权限）</p>}
        </main>
      </div>

      {drawer && (
        // biome 只开了未使用 import 一条规则，但这层确实是纯装饰：Esc 才是键盘出路
        <div className="sidebar-backdrop" aria-hidden={true} onClick={() => setDrawer(false)} />
      )}
    </div>
  );
}
