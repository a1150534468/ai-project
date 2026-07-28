import { Fragment, useEffect, useState } from "react";
import * as api from "../api.js";
import { errMsg, Panel, Pill, useToast } from "../ui.js";

export function ClientMenusPage() {
  const [rows, setRows] = useState<api.ClientMenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState("");
  const [workflowExpanded, setWorkflowExpanded] = useState(true);
  const { show, node } = useToast();

  const load = async () => {
    try {
      setRows(await api.listClientMenus());
    } catch (error) {
      show(errMsg(error), "err");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (row: api.ClientMenuItem) => {
    setSavingKey(row.key);
    try {
      const updated = await api.updateClientMenu(row.key, !row.visible);
      setRows((current) => current.map((item) => item.key === row.key ? updated : item));
      show(updated.visible ? `已显示「${updated.label}」` : `已隐藏「${updated.label}」`);
    } catch (error) {
      show(errMsg(error), "err");
    } finally {
      setSavingKey("");
    }
  };

  const mainRows = rows.filter((row) => row.group === "main");
  const workflowRows = rows.filter((row) => row.group === "workflow" && !row.parentKey);
  const workflowParent = mainRows.find((row) => row.key === "nav.workflow");
  const configuredWorkflowVisible = workflowRows.filter((row) => row.visible).length;
  const tabRowsOf = (parentKey: string) =>
    rows.filter((row) => row.parentKey === parentKey);

  const status = (row: api.ClientMenuItem, parents: api.ClientMenuItem[] = []) => {
    if (parents.some((parent) => !parent.visible)) {
      return <Pill kind="w">随父级隐藏</Pill>;
    }
    return <Pill kind={row.visible ? "g" : "n"}>{row.visible ? "显示" : "隐藏"}</Pill>;
  };

  const action = (row: api.ClientMenuItem) => (
    <button
      className="btn ghost sm"
      disabled={savingKey === row.key}
      onClick={() => void toggle(row)}
    >
      {savingKey === row.key ? "保存中…" : row.visible ? "隐藏" : "显示"}
    </button>
  );

  return (
    <div>
      {node}
      <Panel title="用户端菜单管理">
        <p className="muted" style={{ marginTop: 0 }}>
          这里按用户端真实菜单层级展示。隐藏一级菜单“工作流”时，全部二级菜单会随父级隐藏，
          但二级菜单各自的开关配置会保留。生图模块的三个页内 tab（通用生图 / 电商生图 / 形象照）
          可单独开关；全部关闭时生图模块入口也会隐藏。
        </p>
        <div style={{ overflowX: "auto", marginTop: 16 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>菜单层级</th>
                <th>配置标识</th>
                <th>用户端实际状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {mainRows.map((row) => {
                const isWorkflow = row.key === "nav.workflow";
                return (
                  <Fragment key={row.key}>
                    <tr style={isWorkflow ? { background: "var(--surface2)" } : undefined}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                          {isWorkflow ? (
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => setWorkflowExpanded((value) => !value)}
                              aria-label={workflowExpanded ? "收起工作流子菜单" : "展开工作流子菜单"}
                              style={{ minWidth: 28, padding: "3px 7px" }}
                            >
                              {workflowExpanded ? "▾" : "▸"}
                            </button>
                          ) : (
                            <span style={{ width: 28, textAlign: "center", color: "var(--ink3)" }}>◆</span>
                          )}
                          <span>{row.label}</span>
                          <Pill kind="n">一级菜单</Pill>
                          {isWorkflow && (
                            <span className="muted">
                              {configuredWorkflowVisible}/{workflowRows.length} 个子菜单已开启
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="muted"><code>{row.key}</code></td>
                      <td>{status(row)}</td>
                      <td>{action(row)}</td>
                    </tr>
                    {isWorkflow && workflowExpanded && workflowRows.map((child, index) => {
                      const tabRows = tabRowsOf(child.key);
                      const allTabsHidden = tabRows.length > 0 && tabRows.every((tab) => !tab.visible);
                      return (
                        <Fragment key={child.key}>
                          <tr>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 44 }}>
                                <span
                                  aria-hidden
                                  style={{
                                    width: 20,
                                    color: "var(--ink3)",
                                    fontFamily: "monospace",
                                  }}
                                >
                                  {index === workflowRows.length - 1 ? "└─" : "├─"}
                                </span>
                                <span>{child.label}</span>
                                <Pill kind="n">二级菜单</Pill>
                                {tabRows.length > 0 && (
                                  <span className="muted">
                                    {tabRows.filter((tab) => tab.visible).length}/{tabRows.length} 个页内 tab 已开启
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="muted"><code>{child.key}</code></td>
                            <td>
                              {allTabsHidden && child.visible
                                ? <Pill kind="w">tab 全关，入口隐藏</Pill>
                                : status(child, workflowParent ? [workflowParent] : [])}
                            </td>
                            <td>{action(child)}</td>
                          </tr>
                          {tabRows.map((tab, tabIndex) => (
                            <tr key={tab.key}>
                              <td>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 88 }}>
                                  <span
                                    aria-hidden
                                    style={{ width: 20, color: "var(--ink3)", fontFamily: "monospace" }}
                                  >
                                    {tabIndex === tabRows.length - 1 ? "└─" : "├─"}
                                  </span>
                                  <span>{tab.label}</span>
                                  <Pill kind="n">页内 tab</Pill>
                                </div>
                              </td>
                              <td className="muted"><code>{tab.key}</code></td>
                              <td>
                                {status(
                                  tab,
                                  workflowParent ? [workflowParent, child] : [child],
                                )}
                              </td>
                              <td>{action(tab)}</td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={4} className="muted">暂无菜单配置</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <p className="muted">正在加载菜单配置…</p>}
      </Panel>
    </div>
  );
}
