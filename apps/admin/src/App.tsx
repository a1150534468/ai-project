import { useState } from "react";
import { can, loadSession, saveSession, clearSession, type Session, type Permission } from "./auth.js";
import * as api from "./api.js";
import { useToast, errMsg } from "./ui.js";
import { UsersPage } from "./pages/Users.js";
import { OrdersPage } from "./pages/Orders.js";
import { CodesPage } from "./pages/Codes.js";
import { ModelsPage } from "./pages/Models.js";
import { AnnouncementsPage } from "./pages/Announcements.js";
import { AdminsPage } from "./pages/Admins.js";
import { AuditPage } from "./pages/Audit.js";
import { ResourcePricingPage } from "./pages/ResourcePricing.js";
import { MembershipPage } from "./pages/Membership.js";
import { KnowledgePage } from "./pages/Knowledge.js";
import { ClientMenusPage } from "./pages/ClientMenus.js";

interface TabDef { key: string; label: string; perm: Permission; render: () => React.ReactNode; }

interface TabGroup {
  groupKey: string;
  groupLabel: string;
  items: TabDef[];
}

const TAB_GROUPS: TabGroup[] = [
  {
    groupKey: "operations",
    groupLabel: "运营",
    items: [
      { key: "users", label: "用户", perm: "USER_MANAGE", render: () => <UsersPage /> },
      { key: "orders", label: "订单", perm: "ORDER_MANAGE", render: () => <OrdersPage /> },
      { key: "codes", label: "兑换码", perm: "REDEMPTION_MANAGE", render: () => <CodesPage /> },
      { key: "membership", label: "月卡", perm: "MEMBERSHIP_MANAGE", render: () => <MembershipPage /> },
      { key: "ann", label: "公告", perm: "ANNOUNCEMENT_MANAGE", render: () => <AnnouncementsPage /> },
    ],
  },
  {
    groupKey: "config",
    groupLabel: "配置",
    items: [
      { key: "models", label: "模型", perm: "MODEL_MANAGE", render: () => <ModelsPage /> },
      { key: "respricing", label: "计费配置", perm: "PRICING_MANAGE", render: () => <ResourcePricingPage /> },
      { key: "kb", label: "官方知识库", perm: "KNOWLEDGE_MANAGE", render: () => <KnowledgePage /> },
      { key: "clientmenu", label: "用户端菜单", perm: "ADMIN_MANAGE", render: () => <ClientMenusPage /> },
    ],
  },
  {
    groupKey: "system",
    groupLabel: "系统",
    items: [
      { key: "admins", label: "管理员", perm: "ADMIN_MANAGE", render: () => <AdminsPage /> },
      { key: "audit", label: "审计", perm: "ADMIN_MANAGE", render: () => <AuditPage /> },
    ],
  },
];

function getAllTabs(): TabDef[] {
  return TAB_GROUPS.flatMap(g => g.items);
}

function getNavIcon(tabKey: string): React.ReactNode {
  const iconMap: Record<string, React.ReactNode> = {
    users: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>,
    orders: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z"></path><path d="M9 7h6"></path><path d="M9 11h6"></path><path d="M9 15h4"></path></svg>,
    codes: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>,
    models: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>,
    respricing: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>,
    membership: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    kb: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>,
    clientmenu: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><circle cx="3" cy="6" r="1"></circle><circle cx="3" cy="12" r="1"></circle><circle cx="3" cy="18" r="1"></circle></svg>,
    ann: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>,
    admins: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>,
    audit: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="13" x2="8" y2="13"></line><line x1="12" y1="17" x2="8" y2="17"></line></svg>,
  };
  return iconMap[tabKey] || null;
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession());
  if (!session) return <Login onLogin={setSession} />;

  const allTabs = getAllTabs();
  const visible = allTabs.filter((t) => can(session, t.perm));
  return <Shell session={session} tabGroups={TAB_GROUPS} visibleTabs={visible} onLogout={() => { clearSession(); setSession(null); }} />;
}

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();
  const submit = async () => {
    setBusy(true);
    try {
      const s = await api.login(u, p);
      saveSession(s);
      onLogin(s);
    } catch (e) {
      show(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      {node}
      <div className="login-container">
        <div className="login-brand">
          <div className="brand-logo">AI</div>
          <div className="brand-name">AI 助手</div>
          <div className="brand-desc">运营控制台</div>
        </div>
        <div className="login-form">
          <input
            placeholder="管理员用户名"
            value={u}
            onChange={(e) => setU(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            disabled={busy}
          />
          <input
            placeholder="密码"
            type="password"
            value={p}
            onChange={(e) => setP(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            disabled={busy}
          />
          <button
            className="btn"
            disabled={busy || !u || !p}
            onClick={submit}
          >
            {busy ? "登录中…" : "登录"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Shell({
  session,
  tabGroups,
  visibleTabs,
  onLogout
}: {
  session: Session;
  tabGroups: TabGroup[];
  visibleTabs: TabDef[];
  onLogout: () => void;
}) {
  const [active, setActive] = useState(visibleTabs[0]?.key ?? "");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const cur = visibleTabs.find((t) => t.key === active) ?? visibleTabs[0];

  const visibleGroups = tabGroups
    .map(g => ({
      ...g,
      items: g.items.filter(item => visibleTabs.some(v => v.key === item.key))
    }))
    .filter(g => g.items.length > 0);

  const breadcrumbs = (() => {
    if (!cur) return null;
    const group = visibleGroups.find(g => g.items.some(i => i.key === cur.key));
    return { groupLabel: group?.groupLabel, itemLabel: cur.label };
  })();

  return (
    <div className="frame">
      <aside className={`side ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-logo">AI</div>
          <div className="brand-info">
            <div className="brand-name">AI 助手</div>
            <div className="brand-desc">运营控制台</div>
          </div>
        </div>

        <nav className="nav-container">
          {visibleGroups.map(group => (
            <div key={group.groupKey} className="navgrp">
              <div className="navgrp-label">{group.groupLabel}</div>
              {group.items.map(item => (
                <button
                  key={item.key}
                  className={`nav-item ${item.key === active ? "active" : ""}`}
                  onClick={() => {
                    setActive(item.key);
                    setSidebarOpen(false);
                  }}
                >
                  <span className="nav-icon">{getNavIcon(item.key)}</span>
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="profile-zone">
          <div className="profile-avatar">
            {session.role === "super_admin" ? "超" : "管"}
          </div>
          <div className="profile-info">
            <div className="profile-name">{session.role === "super_admin" ? "超级管理员" : "管理员"}</div>
            <div className="profile-role">{session.adminId}</div>
          </div>
          <button className="profile-logout" onClick={onLogout}>登出</button>
        </div>
      </aside>

      <div className="right-col">
        <header className="top">
          <button className="hamburger" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor">
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>

          <div className="top-breadcrumbs">
            {breadcrumbs && (
              <>
                <span className="breadcrumb-group">{breadcrumbs.groupLabel}</span>
                <span className="breadcrumb-sep">/</span>
                <span className="breadcrumb-page">{breadcrumbs.itemLabel}</span>
              </>
            )}
          </div>

          <h1 className="top-title">{cur?.label ?? "未选择"}</h1>

          <div className="top-actions">
          </div>
        </header>

        <main className="body">
          {cur ? cur.render() : <p className="muted">无可用功能（当前账号未被授予任何权限）</p>}
        </main>
      </div>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
    </div>
  );
}
