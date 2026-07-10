import { useEffect, useState } from "react";
import * as api from "../api.js";
import { can, loadSession } from "../auth.js";
import { errMsg, Field, Modal, Pill, useToast } from "../ui.js";

type RmbPricing = Pick<
  api.ModelRow,
  "inputPriceRmbPerMillion" | "outputPriceRmbPerMillion" | "cacheInputPriceRmbPerMillion" | "cacheOutputPriceRmbPerMillion"
>;

type ModelMetaDraft = Pick<
  api.ModelRow,
  "displayName" | "description" | "useCases" | "sortOrder" | "showInMarketplace" | "enabled" | "maxOutputTokens"
> & {
  newModel: string;
};

const emptyPricing: RmbPricing = {
  inputPriceRmbPerMillion: 0,
  outputPriceRmbPerMillion: 0,
  cacheInputPriceRmbPerMillion: 0,
  cacheOutputPriceRmbPerMillion: 0,
};

export function ModelsPage() {
  const session = loadSession();
  const [rows, setRows] = useState<api.ModelRow[]>([]);
  const [editPricing, setEditPricing] = useState<{ row: api.ModelRow; pricing: RmbPricing } | null>(null);
  const [editMeta, setEditMeta] = useState<{ row: api.ModelRow; draft: ModelMetaDraft } | null>(null);
  const [stats, setStats] = useState<api.ModelStatsRow | null>(null);
  const [rechargeRatio, setRechargeRatio] = useState<number | null>(null);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const [models, ratio] = await Promise.all([
        api.listModels(),
        api.getRechargeRatio().catch(() => null),
      ]);
      setRows(models);
      setRechargeRatio(ratio);
    } catch (error) {
      show(errMsg(error), "err");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openEditPricing = (row: api.ModelRow) => {
    setEditPricing({ row, pricing: rmbPricingFromRow(row, rechargeRatio) });
  };

  const openEditMeta = (row: api.ModelRow) => {
    setEditMeta({
      row,
      draft: {
        newModel: row.model,
        displayName: row.displayName,
        description: row.description ?? "",
        useCases: row.useCases ?? "",
        sortOrder: row.sortOrder ?? 0,
        showInMarketplace: row.showInMarketplace,
        enabled: row.enabled,
        maxOutputTokens: row.maxOutputTokens ?? 0,
      },
    });
  };

  const savePricing = async () => {
    if (!editPricing) return;
    if (!isValidPricing(editPricing.pricing)) {
      show("价格需填写非负数字", "err");
      return;
    }
    try {
      await api.updateModelPricing(editPricing.row.model, editPricing.pricing);
      show("已更新计费");
      setEditPricing(null);
      void load();
    } catch (error) {
      show(errMsg(error), "err");
    }
  };

  const saveMeta = async () => {
    if (!editMeta) return;
    const { row, draft } = editMeta;
    const nextModel = draft.newModel.trim();
    if (!nextModel) {
      show("模型 ID 不能为空", "err");
      return;
    }
    try {
      await api.updateModelDisplay(row.model, draft.displayName.trim(), draft.enabled, {
        description: draft.description.trim(),
        useCases: draft.useCases.trim(),
        sortOrder: draft.sortOrder,
        showInMarketplace: draft.showInMarketplace,
        maxOutputTokens: draft.maxOutputTokens,
      });
      if (nextModel !== row.model) {
        await api.updateModelIdentity({
          model: row.model,
          newModel: nextModel,
          displayName: draft.displayName.trim(),
          enabled: draft.enabled,
        });
      }
      show("已更新模型");
      setEditMeta(null);
      void load();
    } catch (error) {
      show(errMsg(error), "err");
    }
  };

  const openStats = async (row: api.ModelRow) => {
    try {
      setStats(await api.getModelStats(row.model));
    } catch (error) {
      show(errMsg(error), "err");
    }
  };

  const removeModel = async (row: api.ModelRow) => {
    if (!globalThis.confirm(`确认删除模型配置“${row.displayName || row.model}”？历史扣费记录会保留。`)) return;
    try {
      await api.deleteModel(row.model);
      show("已删除模型配置");
      void load();
    } catch (error) {
      show(errMsg(error), "err");
    }
  };

  return (
    <div>
      {node}
      <div className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
        当前充值汇率：{rechargeRatio === null ? "—" : `${rechargeRatio} 算力点 / 元`}；模型只填写人民币价格，算力点价格自动换算。
      </div>
      {can(session, "MODEL_MANAGE") && (
        <UpsertModel
          rechargeRatio={rechargeRatio}
          onDone={() => {
            show("已保存");
            void load();
          }}
          onErr={(message) => show(message, "err")}
        />
      )}
      <table className="tbl">
        <thead>
          <tr>
            <th>模型</th>
            <th>广场</th>
            <th>适用场景</th>
            <th className="num">输入价格</th>
            <th className="num">输出价格</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const pricing = rmbPricingFromRow(row, rechargeRatio);
            return (
              <tr key={row.model}>
                <td>
                  <div style={{ display: "grid", gap: 4 }}>
                    <strong>{row.displayName || "未命名模型"}</strong>
                    <span className="muted">{row.model}</span>
                    {row.description ? <span className="muted">{clip(row.description, 56)}</span> : null}
                  </div>
                </td>
                <td>
                  <div style={{ display: "grid", gap: 4 }}>
                    <Pill kind={row.showInMarketplace ? "g" : "n"}>{row.showInMarketplace ? "已上架" : "未上架"}</Pill>
                    <Pill kind={row.enabled ? "g" : "n"}>{row.enabled ? "启用" : "停用"}</Pill>
                  </div>
                </td>
                <td>
                  <div style={{ display: "grid", gap: 4 }}>
                    <span>{row.useCases ? clip(row.useCases, 56) : "未配置适用场景"}</span>
                  </div>
                </td>
                <td className="num">{formatPricePair(pricing.inputPriceRmbPerMillion, row.inputPricePerMillion)}</td>
                <td className="num">{formatPricePair(pricing.outputPriceRmbPerMillion, row.outputPricePerMillion)}</td>
                <td>
                  <div className="row" style={{ margin: 0 }}>
                    {can(session, "MODEL_MANAGE") && <button className="btn ghost sm" type="button" onClick={() => openStats(row)}>详情</button>}
                    {can(session, "MODEL_MANAGE") && <button className="btn ghost sm" type="button" onClick={() => openEditMeta(row)}>编辑</button>}
                    {can(session, "PRICING_MANAGE") && <button className="btn sm" type="button" onClick={() => openEditPricing(row)}>改计费</button>}
                    {can(session, "MODEL_MANAGE") && <button className="btn danger sm" type="button" onClick={() => removeModel(row)}>删除</button>}
                  </div>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">无数据</td>
            </tr>
          )}
        </tbody>
      </table>

      <Modal
        open={!!editPricing}
        title="编辑模型计费"
        onClose={() => setEditPricing(null)}
        footer={
          <div className="modal-footer-actions">
            <button className="btn ghost" type="button" onClick={() => setEditPricing(null)}>取消</button>
            <button className="btn" type="button" onClick={savePricing}>保存</button>
          </div>
        }
      >
        {editPricing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Field label="模型">
              <span style={{ color: "var(--ink)" }}>{editPricing.row.displayName || "未命名模型"}</span>
            </Field>
            <div className="muted" style={{ fontSize: 12 }}>
              当前模型广场信息将保持不变，计费调整不会清空 metadata。
            </div>
            <PricingFields
              value={editPricing.pricing}
              onChange={(pricing) => setEditPricing((current) => current ? { ...current, pricing } : current)}
            />
          </div>
        )}
      </Modal>

      <Modal
        open={!!editMeta}
        title="编辑模型信息"
        onClose={() => setEditMeta(null)}
        width="760px"
        footer={
          <div className="modal-footer-actions">
            <button className="btn ghost" type="button" onClick={() => setEditMeta(null)}>取消</button>
            <button className="btn" type="button" onClick={saveMeta}>保存</button>
          </div>
        }
      >
        {editMeta && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
            <Field label="模型 ID">
              <input value={editMeta.draft.newModel} onChange={(event) => setEditMeta(withMetaDraft(editMeta, { newModel: event.target.value }))} />
            </Field>
            <Field label="显示名">
              <input value={editMeta.draft.displayName} onChange={(event) => setEditMeta(withMetaDraft(editMeta, { displayName: event.target.value }))} />
            </Field>
            <Field label="排序">
              <input type="number" value={editMeta.draft.sortOrder} onChange={(event) => setEditMeta(withMetaDraft(editMeta, { sortOrder: Number(event.target.value || "0") }))} />
            </Field>
            <Field label="最大输出 token（0=用默认）">
              <input type="number" min={0} value={editMeta.draft.maxOutputTokens} onChange={(event) => setEditMeta(withMetaDraft(editMeta, { maxOutputTokens: Number(event.target.value || "0") }))} />
            </Field>
            <Field label="上架广场">
              <input type="checkbox" checked={editMeta.draft.showInMarketplace} onChange={(event) => setEditMeta(withMetaDraft(editMeta, { showInMarketplace: event.target.checked }))} />
            </Field>
            <Field label="启用">
              <input type="checkbox" checked={editMeta.draft.enabled} onChange={(event) => setEditMeta(withMetaDraft(editMeta, { enabled: event.target.checked }))} />
            </Field>
            <Field label="模型介绍">
              <textarea rows={4} value={editMeta.draft.description} onChange={(event) => setEditMeta(withMetaDraft(editMeta, { description: event.target.value }))} />
            </Field>
            <Field label="适用场景">
              <textarea rows={4} value={editMeta.draft.useCases} onChange={(event) => setEditMeta(withMetaDraft(editMeta, { useCases: event.target.value }))} />
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={!!stats}
        title="模型详情"
        onClose={() => setStats(null)}
        footer={
          <div className="modal-footer-actions">
            <button className="btn" type="button" onClick={() => setStats(null)}>关闭</button>
          </div>
        }
      >
        {stats && (
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="模型名"><span style={{ color: "var(--ink)" }}>{stats.displayName || "未命名模型"}</span></Field>
            <Field label="模型 ID"><code>{stats.model}</code></Field>
            <div className="card" style={{ margin: 0 }}>
              <div className="row" style={{ gap: 24 }}>
                <Metric label="累计消耗" value={`${stats.totalPoints.toLocaleString()} 点`} />
                <Metric label="调用次数" value={stats.usageCount.toLocaleString()} />
                <Metric label="使用用户" value={stats.userCount.toLocaleString()} />
              </div>
            </div>
            <div className="card" style={{ margin: 0 }}>
              <div className="row" style={{ gap: 24 }}>
                <Metric label="输入 token" value={stats.inputTokens.toLocaleString()} />
                <Metric label="输出 token" value={stats.outputTokens.toLocaleString()} />
                <Metric label="缓存创建" value={stats.cacheInputTokens.toLocaleString()} />
                <Metric label="缓存读取" value={stats.cacheOutputTokens.toLocaleString()} />
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function UpsertModel({
  rechargeRatio,
  onDone,
  onErr,
}: {
  rechargeRatio: number | null;
  onDone: () => void;
  onErr: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [useCases, setUseCases] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [maxOutputTokens, setMaxOutputTokens] = useState(0);
  const [showInMarketplace, setShowInMarketplace] = useState(false);
  const [pricing, setPricing] = useState<RmbPricing>({
    inputPriceRmbPerMillion: 20,
    outputPriceRmbPerMillion: 20,
    cacheInputPriceRmbPerMillion: 0,
    cacheOutputPriceRmbPerMillion: 0,
  });
  const [enabled, setEnabled] = useState(true);

  const reset = () => {
    setOpen(false);
    setModel("");
    setDisplayName("");
    setDescription("");
    setUseCases("");
    setSortOrder(0);
    setMaxOutputTokens(0);
    setShowInMarketplace(false);
    setPricing({
      inputPriceRmbPerMillion: 20,
      outputPriceRmbPerMillion: 20,
      cacheInputPriceRmbPerMillion: 0,
      cacheOutputPriceRmbPerMillion: 0,
    });
    setEnabled(true);
  };

  const submit = async () => {
    if (!model.trim()) {
      onErr("模型 ID 不能为空");
      return;
    }
    if (!isValidPricing(pricing)) {
      onErr("价格需填写非负数字");
      return;
    }
    try {
      await api.upsertModel({
        model: model.trim(),
        displayName: displayName.trim(),
        enabled,
        description: description.trim(),
        useCases: useCases.trim(),
        sortOrder,
        maxOutputTokens,
        showInMarketplace,
        ...pricing,
      });
      reset();
      onDone();
    } catch (error) {
      onErr(errMsg(error));
    }
  };

  if (!open) {
    return (
      <div className="row">
        <button className="btn gray" type="button" onClick={() => setOpen(true)}>+ 新增模型</button>
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
        <Field label="模型 ID"><input value={model} onChange={(event) => setModel(event.target.value)} /></Field>
        <Field label="显示名"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
        <Field label="排序"><input type="number" value={sortOrder} onChange={(event) => setSortOrder(Number(event.target.value || "0"))} /></Field>
        <Field label="最大输出 token（0=用默认）"><input type="number" min={0} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(Number(event.target.value || "0"))} /></Field>
        <Field label="上架广场"><input type="checkbox" checked={showInMarketplace} onChange={(event) => setShowInMarketplace(event.target.checked)} /></Field>
        <Field label="模型介绍"><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="适用场景"><textarea rows={3} value={useCases} onChange={(event) => setUseCases(event.target.value)} /></Field>
        <PricingFields value={pricing} onChange={setPricing} />
        <Field label="换算预览"><span className="muted">{previewPoints(pricing, rechargeRatio)}</span></Field>
        <Field label="启用"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /></Field>
        <div className="row" style={{ alignItems: "end", gap: 8 }}>
          <button className="btn" type="button" disabled={!model.trim()} onClick={submit}>保存</button>
          <button className="btn gray" type="button" onClick={reset}>取消</button>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ marginTop: 4, color: "var(--ink)", fontSize: 20, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function PricingFields({
  value,
  onChange,
}: {
  value: RmbPricing;
  onChange: (value: RmbPricing) => void;
}) {
  const set = (key: keyof RmbPricing, next: number) => onChange({ ...value, [key]: next });
  return (
    <>
      <Field label="输入（元/100W token）"><input type="number" step="0.0001" min="0" value={value.inputPriceRmbPerMillion} onChange={(event) => set("inputPriceRmbPerMillion", Number(event.target.value || "0"))} /></Field>
      <Field label="输出（元/100W token）"><input type="number" step="0.0001" min="0" value={value.outputPriceRmbPerMillion} onChange={(event) => set("outputPriceRmbPerMillion", Number(event.target.value || "0"))} /></Field>
      <Field label="缓存创建（元/100W token）"><input type="number" step="0.0001" min="0" value={value.cacheInputPriceRmbPerMillion} onChange={(event) => set("cacheInputPriceRmbPerMillion", Number(event.target.value || "0"))} /></Field>
      <Field label="缓存读取（元/100W token）"><input type="number" step="0.0001" min="0" value={value.cacheOutputPriceRmbPerMillion} onChange={(event) => set("cacheOutputPriceRmbPerMillion", Number(event.target.value || "0"))} /></Field>
    </>
  );
}

function rmbPricingFromRow(row: api.ModelRow, ratio: number | null): RmbPricing {
  const divisor = ratio && ratio > 0 ? ratio : 1;
  return {
    inputPriceRmbPerMillion: row.inputPriceRmbPerMillion ?? ((row.inputPricePerMillion ?? 0) / divisor),
    outputPriceRmbPerMillion: row.outputPriceRmbPerMillion ?? ((row.outputPricePerMillion ?? 0) / divisor),
    cacheInputPriceRmbPerMillion: row.cacheInputPriceRmbPerMillion ?? ((row.cacheInputPricePerMillion ?? 0) / divisor),
    cacheOutputPriceRmbPerMillion: row.cacheOutputPriceRmbPerMillion ?? ((row.cacheOutputPricePerMillion ?? 0) / divisor),
  };
}

function isValidPricing(pricing: RmbPricing): boolean {
  return Object.values(pricing).every((value) => Number.isFinite(value) && value >= 0);
}

function formatRate(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function formatRmb(value: number): string {
  return `¥${Number(value.toFixed(6))}`;
}

function formatPricePair(rmb: number, points: number): string {
  return `${formatRmb(rmb)} / ${formatRate(points)} 点`;
}

function previewPoints(value: RmbPricing, ratio: number | null): string {
  if (!ratio) return "汇率不可用";
  return `输入 ${formatRate(value.inputPriceRmbPerMillion * ratio)} 点，输出 ${formatRate(value.outputPriceRmbPerMillion * ratio)} 点`;
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function withMetaDraft(
  state: { row: api.ModelRow; draft: ModelMetaDraft },
  patch: Partial<ModelMetaDraft>,
): { row: api.ModelRow; draft: ModelMetaDraft } {
  return { ...state, draft: { ...state.draft, ...patch } };
}
