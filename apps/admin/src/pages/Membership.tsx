import { useEffect, useMemo, useState } from "react";
import * as api from "../api.js";
import { errMsg, Field, Modal, Panel, Pill, useConfirm, useToast } from "../ui.js";
import { can, loadSession } from "../auth.js";

type MembershipTab = "cards" | "vip";

type CardDraft = {
  id?: number;
  name: string;
  priceFen: number;
  durationDays: number;
  cadence: "DAILY" | "WEEKLY" | "MONTHLY";
  grantPoints: number;
  kbQuotaBytes?: number;
  enabled: boolean;
};

type VipDraft = {
  id?: number;
  name: string;
  sortOrder: number;
  thresholdYuan: string;
  discountRate: string;
  enabled: boolean;
  upgradeEnabled: boolean;
};

const emptyCardDraft = (): CardDraft => ({
  name: "",
  priceFen: 0,
  durationDays: 30,
  cadence: "DAILY",
  grantPoints: 0,
  kbQuotaBytes: 0,
  enabled: true,
});

const emptyVipDraft = (): VipDraft => ({
  name: "",
  sortOrder: 0,
  thresholdYuan: "0",
  discountRate: "10",
  enabled: true,
  upgradeEnabled: true,
});

export function MembershipPage() {
  const session = loadSession();
  if (!can(session, "MEMBERSHIP_MANAGE")) return <div className="card muted">无权限访问此功能</div>;

  const [activeTab, setActiveTab] = useState<MembershipTab>("cards");
  const [cardRows, setCardRows] = useState<api.MembershipCardRow[]>([]);
  const [vipRows, setVipRows] = useState<api.VipLevelRow[]>([]);
  const [cardEditor, setCardEditor] = useState<CardDraft | null>(null);
  const [vipEditor, setVipEditor] = useState<VipDraft | null>(null);
  const { show, node } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  const load = async () => {
    const [cardsResult, levelsResult] = await Promise.allSettled([
      api.listMembershipCards(),
      api.listVipLevels(),
    ]);
    if (cardsResult.status === "fulfilled") setCardRows(cardsResult.value);
    if (levelsResult.status === "fulfilled") setVipRows(levelsResult.value);
    const firstError = cardsResult.status === "rejected" ? cardsResult.reason : levelsResult.status === "rejected" ? levelsResult.reason : null;
    if (firstError) show(errMsg(firstError), "err");
  };

  useEffect(() => {
    void load();
  }, []);

  const vipSummary = useMemo(() => {
    const enabledCount = vipRows.filter((row) => row.enabled).length;
    const marketplaceDiscountCount = vipRows.filter((row) => row.discountBps < 10000).length;
    return { enabledCount, marketplaceDiscountCount };
  }, [vipRows]);

  const handleDeleteCard = async (row: api.MembershipCardRow) => {
    const ok = await confirm({
      title: "删除月卡",
      message: `确定删除“${row.name}”吗？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteMembershipCard(row.id);
      show("已删除");
      void load();
    } catch (error) {
      show(errMsg(error), "err");
    }
  };

  const handleDeleteVipLevel = async (row: api.VipLevelRow) => {
    const ok = await confirm({
      title: "删除 VIP 等级",
      message: `确定删除“${row.name}”吗？`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteVipLevel(row.id);
      show("已删除");
      void load();
    } catch (error) {
      show(errMsg(error), "err");
    }
  };

  return (
    <div>
      {node}
      {confirmNode}
      <div className="subtabs" style={{ marginBottom: 16 }}>
        <button
          className={`subtab ${activeTab === "cards" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("cards")}
        >
          月卡管理
        </button>
        <button
          className={`subtab ${activeTab === "vip" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("vip")}
        >
          VIP 等级
        </button>
      </div>

      {activeTab === "cards" ? (
        <Panel
          title="月卡管理"
          actions={
            <button className="btn sm" type="button" onClick={() => setCardEditor(emptyCardDraft())}>
              + 新建月卡
            </button>
          }
        >
          {cardRows.length === 0 ? (
            <div className="muted" style={{ textAlign: "center", padding: "40px 20px" }}>
              暂无月卡数据
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>名称</th>
                  <th className="num">售价(元)</th>
                  <th className="num">时长(天)</th>
                  <th>周期</th>
                  <th className="num">每期点数</th>
                  <th className="num">知识库额度</th>
                  <th>启用</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {cardRows.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.name}</strong></td>
                    <td className="num">{(row.priceFen / 100).toFixed(2)}</td>
                    <td className="num">{row.durationDays}</td>
                    <td><Pill kind="g">{cadenceLabel(row.cadence)}</Pill></td>
                    <td className="num">{row.grantPoints}</td>
                    <td className="num">{(row.kbQuotaBytes ?? 0).toLocaleString()}</td>
                    <td><Pill kind={row.enabled ? "g" : "n"}>{row.enabled ? "启用" : "禁用"}</Pill></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn ghost sm" type="button" onClick={() => setCardEditor(cardDraftFromRow(row))}>
                        编辑
                      </button>
                      <button className="btn danger sm" type="button" style={{ marginLeft: 4 }} onClick={() => handleDeleteCard(row)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <Panel
            title="VIP 等级"
            actions={
              <button className="btn sm" type="button" onClick={() => setVipEditor(emptyVipDraft())}>
                + 新建等级
              </button>
            }
          >
            <div className="stats" style={{ marginBottom: 16 }}>
              <div className="stat">
                <div className="k">启用等级</div>
                <div className="v">{vipSummary.enabledCount}</div>
              </div>
              <div className="stat">
                <div className="k">折扣等级</div>
                <div className="v">{vipSummary.marketplaceDiscountCount}</div>
              </div>
              <div className="stat">
                <div className="k">普通会员</div>
                <div className="v">{vipRows[0]?.name ?? "—"}</div>
              </div>
            </div>
            {vipRows.length === 0 ? (
              <div className="muted" style={{ textAlign: "center", padding: "40px 20px" }}>
                暂无 VIP 等级
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>等级</th>
                    <th className="num">排序</th>
                    <th className="num">门槛(元)</th>
                    <th className="num">固化点数</th>
                    <th>折扣</th>
                    <th>启用</th>
                    <th>可升级进入</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {vipRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div style={{ display: "grid", gap: 4 }}>
                          <strong>{row.name}</strong>
                          <span className="muted">{row.savedRechargeRatio} 点 / 元固化</span>
                        </div>
                      </td>
                      <td className="num">{row.sortOrder}</td>
                      <td className="num">{(row.thresholdRmbFen / 100).toFixed(2)}</td>
                      <td className="num">{row.thresholdPoints.toLocaleString()}</td>
                      <td>{discountLabel(row.discountBps)}</td>
                      <td><Pill kind={row.enabled ? "g" : "n"}>{row.enabled ? "启用" : "停用"}</Pill></td>
                      <td><Pill kind={row.upgradeEnabled ? "g" : "n"}>{row.upgradeEnabled ? "可升级" : "仅存量"}</Pill></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn ghost sm" type="button" onClick={() => setVipEditor(vipDraftFromRow(row))}>
                          编辑
                        </button>
                        <button className="btn danger sm" type="button" style={{ marginLeft: 4 }} onClick={() => handleDeleteVipLevel(row)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}

      <MembershipCardModal
        draft={cardEditor}
        onClose={() => setCardEditor(null)}
        onDone={() => {
          show("已保存");
          setCardEditor(null);
          void load();
        }}
        onError={(message) => show(message, "err")}
      />
      <VipLevelModal
        draft={vipEditor}
        onClose={() => setVipEditor(null)}
        onDone={() => {
          show("已保存");
          setVipEditor(null);
          void load();
        }}
        onError={(message) => show(message, "err")}
      />
    </div>
  );
}

function MembershipCardModal({
  draft,
  onClose,
  onDone,
  onError,
}: {
  draft: CardDraft | null;
  onClose: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<CardDraft>(emptyCardDraft);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setState(draft ?? emptyCardDraft());
  }, [draft]);

  const submit = async () => {
    if (!state.name.trim() || state.priceFen <= 0 || state.durationDays <= 0 || state.grantPoints < 0) {
      onError("请填写完整有效的月卡信息");
      return;
    }
    try {
      setSubmitting(true);
      await api.upsertMembershipCard({
        ...state,
        name: state.name.trim(),
      });
      onDone();
    } catch (error) {
      onError(errMsg(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={!!draft}
      title={state.id ? "编辑月卡" : "新建月卡"}
      onClose={onClose}
      width="640px"
      footer={
        <div className="modal-footer-actions">
          <button className="btn ghost" type="button" onClick={onClose} disabled={submitting}>取消</button>
          <button className="btn" type="button" onClick={submit} disabled={submitting}>{submitting ? "保存中…" : "保存"}</button>
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
        <Field label="名称">
          <input value={state.name} onChange={(event) => setState({ ...state, name: event.target.value })} />
        </Field>
        <Field label="售价(元)">
          <input
            type="number"
            step="0.01"
            value={state.priceFen === 0 ? "" : String(state.priceFen / 100)}
            onChange={(event) => setState({ ...state, priceFen: Math.round(Number(event.target.value || "0") * 100) })}
          />
        </Field>
        <Field label="有效期(天)">
          <input type="number" min="1" value={state.durationDays} onChange={(event) => setState({ ...state, durationDays: Number(event.target.value || "0") })} />
        </Field>
        <Field label="周期">
          <select value={state.cadence} onChange={(event) => setState({ ...state, cadence: event.target.value as CardDraft["cadence"] })}>
            <option value="DAILY">每日</option>
            <option value="WEEKLY">每周</option>
            <option value="MONTHLY">每月</option>
          </select>
        </Field>
        <Field label="每期发点(点数)">
          <input type="number" min="0" value={state.grantPoints} onChange={(event) => setState({ ...state, grantPoints: Number(event.target.value || "0") })} />
        </Field>
        <Field label="知识库额度(字节)">
          <input type="number" min="0" value={state.kbQuotaBytes ?? 0} onChange={(event) => setState({ ...state, kbQuotaBytes: Number(event.target.value || "0") })} />
        </Field>
        <Field label="启用">
          <input type="checkbox" checked={state.enabled} onChange={(event) => setState({ ...state, enabled: event.target.checked })} />
        </Field>
      </div>
    </Modal>
  );
}

function VipLevelModal({
  draft,
  onClose,
  onDone,
  onError,
}: {
  draft: VipDraft | null;
  onClose: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<VipDraft>(emptyVipDraft);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setState(draft ?? emptyVipDraft());
  }, [draft]);

  const submit = async () => {
    const thresholdYuan = Number(state.thresholdYuan);
    const discountRate = Number(state.discountRate);
    if (!state.name.trim() || !Number.isFinite(thresholdYuan) || thresholdYuan < 0 || !Number.isFinite(discountRate) || discountRate <= 0 || discountRate > 10) {
      onError("请填写完整有效的 VIP 等级信息");
      return;
    }
    try {
      setSubmitting(true);
      await api.upsertVipLevel({
        id: state.id,
        name: state.name.trim(),
        sortOrder: state.sortOrder,
        thresholdRmbFen: Math.round(thresholdYuan * 100),
        discountBps: Math.round(discountRate * 1000),
        enabled: state.enabled,
        upgradeEnabled: state.upgradeEnabled,
      });
      onDone();
    } catch (error) {
      onError(errMsg(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={!!draft}
      title={state.id ? "编辑 VIP 等级" : "新建 VIP 等级"}
      onClose={onClose}
      width="640px"
      footer={
        <div className="modal-footer-actions">
          <button className="btn ghost" type="button" onClick={onClose} disabled={submitting}>取消</button>
          <button className="btn" type="button" onClick={submit} disabled={submitting}>{submitting ? "保存中…" : "保存"}</button>
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
        <Field label="等级名称">
          <input value={state.name} onChange={(event) => setState({ ...state, name: event.target.value })} />
        </Field>
        <Field label="排序">
          <input type="number" value={state.sortOrder} onChange={(event) => setState({ ...state, sortOrder: Number(event.target.value || "0") })} />
        </Field>
        <Field label="门槛(元)">
          <input type="number" min="0" step="0.01" value={state.thresholdYuan} onChange={(event) => setState({ ...state, thresholdYuan: event.target.value })} />
        </Field>
        <Field label="折扣(几折)">
          <input type="number" min="0.1" max="10" step="0.1" value={state.discountRate} onChange={(event) => setState({ ...state, discountRate: event.target.value })} />
        </Field>
        <Field label="启用">
          <input type="checkbox" checked={state.enabled} onChange={(event) => setState({ ...state, enabled: event.target.checked })} />
        </Field>
        <Field label="可升级进入">
          <input type="checkbox" checked={state.upgradeEnabled} onChange={(event) => setState({ ...state, upgradeEnabled: event.target.checked })} />
        </Field>
      </div>
      <div className="muted" style={{ marginTop: 16 }}>
        折扣按“几折”输入，例如 9 表示九折，10 表示无折扣。
      </div>
    </Modal>
  );
}

function cardDraftFromRow(row: api.MembershipCardRow): CardDraft {
  return {
    id: row.id,
    name: row.name,
    priceFen: row.priceFen,
    durationDays: row.durationDays,
    cadence: row.cadence as CardDraft["cadence"],
    grantPoints: row.grantPoints,
    kbQuotaBytes: row.kbQuotaBytes ?? 0,
    enabled: row.enabled,
  };
}

function vipDraftFromRow(row: api.VipLevelRow): VipDraft {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    thresholdYuan: (row.thresholdRmbFen / 100).toFixed(2),
    discountRate: String(Number((row.discountBps / 1000).toFixed(1))),
    enabled: row.enabled,
    upgradeEnabled: row.upgradeEnabled,
  };
}

function cadenceLabel(cadence: string): string {
  if (cadence === "DAILY") return "每日";
  if (cadence === "WEEKLY") return "每周";
  return "每月";
}

function discountLabel(discountBps: number): string {
  if (discountBps >= 10000) return "无折扣";
  return `${Number((discountBps / 1000).toFixed(1))} 折`;
}
