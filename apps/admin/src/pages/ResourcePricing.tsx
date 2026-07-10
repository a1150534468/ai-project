import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Field } from "../ui.js";
import { can, loadSession } from "../auth.js";
import {
  DUB_RESOURCE_PRICING_CONFIGS,
  ECOM_MAIN_IMAGE_PRICING_CONFIGS,
  ECOM_RESOURCE_PRICING_CONFIGS,
  EcomResourcePricingPanel,
  ImageGenerationPricingPanel,
  LOCAL_BUSINESS_PROMO_PRICING_CONFIGS,
  NOVEL_COVER_RESOURCE_KEY,
  NovelCoverPricingPanel,
  NOVEL_TEXT_RESOURCE_KEY,
  NovelTextPricingPanel,
  VIDEO_ANALYZE_PRICING_CONFIGS,
  VideoGenerationPricingPanel,
} from "./ResourcePricingPanels.js";
import { ARTICLE_WORKFLOW_PRICING_CONFIGS } from "./articleWorkflowPricing.js";

function nonBlankResourceRows(rows: api.ResourcePriceRow[]): api.ResourcePriceRow[] {
  return rows.filter((row) => row.resourceKey?.trim());
}

export function ResourcePricingPage() {
  const session = loadSession();
  if (!can(session, "PRICING_MANAGE")) return <div className="card muted">无权限访问此功能</div>;
  const [rows, setRows] = useState<api.ResourcePriceRow[]>([]);
  const [ratio, setRatio] = useState(100);
  const [rechargePackages, setRechargePackages] = useState<api.RechargePackageRow[]>([]);
  const { show, node } = useToast();
  const load = async () => {
    try {
      setRows(nonBlankResourceRows(await api.listResourcePrices()));
      setRatio(await api.getRechargeRatio());
      setRechargePackages(await api.listRechargePackages());
    } catch (e) {
      show(errMsg(e), "err");
    }
  };
  useEffect(() => {
    void load();
    /* eslint-disable-next-line */
  }, []);

  const saveRatio = async () => {
    if (!Number.isInteger(ratio) || ratio <= 0) {
      show("汇率须正整数", "err");
      return;
    }
    try {
      await api.setRechargeRatio(ratio);
      show("已更新汇率");
    } catch (e) {
      show(errMsg(e), "err");
    }
  };
  const ratioPreviewPoints = Number.isFinite(ratio) && ratio > 0 ? ratio * 100 : 0;

  return (
    <div>
      {node}
      <div className="card">
        <div className="row">
          <Field label="充值汇率（算力点 / 元）">
            <input type="number" value={ratio} onChange={(e) => setRatio(Number(e.target.value))} />
          </Field>
          <div className="muted" style={{ alignSelf: "end", paddingBottom: 10 }}>
            100 元预计到账：<b>{ratioPreviewPoints.toLocaleString()}</b> 算力点
          </div>
          <button className="btn" onClick={saveRatio}>
            保存汇率
          </button>
        </div>
      </div>
      <RechargePackagesPanel
        packages={rechargePackages}
        ratio={ratio}
        onChange={setRechargePackages}
        onSave={async () => {
          try {
            await api.setRechargePackages(rechargePackages);
            show("已保存充值套餐");
            void load();
          } catch (e) {
            show(errMsg(e), "err");
          }
        }}
      />
      <ImageGenerationPricingPanel
        rows={rows}
        onDone={() => {
          show("已保存图片生成价格");
          void load();
        }}
        onErr={(m) => show(m, "err")}
      />
      <VideoGenerationPricingPanel
        rows={rows}
        onDone={() => {
          show("已保存视频生成价格");
          void load();
        }}
        onErr={(m) => show(m, "err")}
      />
      <NovelTextPricingPanel
        row={rows.find((row) => row.resourceKey === NOVEL_TEXT_RESOURCE_KEY)}
        onDone={() => {
          show("已保存小说价格");
          void load();
        }}
        onErr={(m) => show(m, "err")}
      />
      <NovelCoverPricingPanel
        row={rows.find((row) => row.resourceKey === NOVEL_COVER_RESOURCE_KEY)}
        onDone={() => {
          show("已保存小说封面价格");
          void load();
        }}
        onErr={(m) => show(m, "err")}
      />
      {ECOM_RESOURCE_PRICING_CONFIGS.map((config) => (
        <EcomResourcePricingPanel
          key={config.resourceKey}
          config={config}
          row={rows.find((row) => row.resourceKey === config.resourceKey)}
          onDone={() => {
            show(`已保存${config.displayName}价格`);
            void load();
          }}
          onErr={(m) => show(m, "err")}
        />
      ))}
      {VIDEO_ANALYZE_PRICING_CONFIGS.map((config) => (
        <EcomResourcePricingPanel
          key={config.resourceKey}
          config={config}
          row={rows.find((row) => row.resourceKey === config.resourceKey)}
          onDone={() => {
            show(`已保存${config.displayName}价格`);
            void load();
          }}
          onErr={(m) => show(m, "err")}
        />
      ))}
      {DUB_RESOURCE_PRICING_CONFIGS.map((config) => (
        <EcomResourcePricingPanel
          key={config.resourceKey}
          config={config}
          row={rows.find((row) => row.resourceKey === config.resourceKey)}
          onDone={() => {
            show(`已保存${config.displayName}价格`);
            void load();
          }}
          onErr={(m) => show(m, "err")}
        />
      ))}
      {ECOM_MAIN_IMAGE_PRICING_CONFIGS.map((config) => (
        <EcomResourcePricingPanel
          key={config.resourceKey}
          config={config}
          row={rows.find((row) => row.resourceKey === config.resourceKey)}
          onDone={() => {
            show(`已保存${config.displayName}价格`);
            void load();
          }}
          onErr={(m) => show(m, "err")}
        />
      ))}
      {LOCAL_BUSINESS_PROMO_PRICING_CONFIGS.map((config) => (
        <EcomResourcePricingPanel
          key={config.resourceKey}
          config={config}
          row={rows.find((row) => row.resourceKey === config.resourceKey)}
          onDone={() => {
            show(`已保存${config.displayName}价格`);
            void load();
          }}
          onErr={(m) => show(m, "err")}
        />
      ))}
      {ARTICLE_WORKFLOW_PRICING_CONFIGS.map((config) => (
        <EcomResourcePricingPanel
          key={config.resourceKey}
          config={config}
          row={rows.find((row) => row.resourceKey === config.resourceKey)}
          onDone={() => {
            show(`已保存${config.displayName}价格`);
            void load();
          }}
          onErr={(m) => show(m, "err")}
        />
      ))}
    </div>
  );
}

function RechargePackagesPanel({
  packages,
  ratio,
  onChange,
  onSave,
}: {
  packages: api.RechargePackageRow[];
  ratio: number;
  onChange: (rows: api.RechargePackageRow[]) => void;
  onSave: () => Promise<void>;
}) {
  const update = (idx: number, patch: Partial<api.RechargePackageRow>) => {
    onChange(packages.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };
  const add = () => {
    onChange([
      ...packages,
      {
        id: `pkg_${Date.now()}`,
        name: "新套餐",
        amountFen: 1000,
        points: 1000,
        enabled: true,
        sortOrder: (packages.length + 1) * 10,
      },
    ]);
  };
  const remove = (idx: number) => {
    onChange(packages.filter((_, i) => i !== idx));
  };
  const ratioPoints = (amountFen: number) => Math.floor((amountFen * ratio) / 100);
  const yuanPerPoint = (amountFen: number, points: number) => {
    if (amountFen <= 0 || points <= 0) return "—";
    return `${(amountFen / 100 / points).toFixed(4)} 元/点`;
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>快速充值套餐</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            最多配置 10 个；用户端大屏每行最多显示 5 个；自定义充值仍按上方汇率换算算力点。
          </p>
        </div>
        <div className="row">
          <button className="btn" disabled={packages.length >= 10} onClick={add}>
            新增套餐
          </button>
          <button className="btn" onClick={onSave}>
            保存套餐
          </button>
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>ID</th>
            <th>名称</th>
            <th>支付价格（元）</th>
            <th>发放算力点数</th>
            <th>实时折算</th>
            <th>排序</th>
            <th>启用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {packages.map((p, idx) => (
            <tr key={`${p.id}-${idx}`}>
              <td>
                <input value={p.id} onChange={(e) => update(idx, { id: e.target.value })} />
              </td>
              <td>
                <input value={p.name} onChange={(e) => update(idx, { name: e.target.value })} />
              </td>
              <td>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={(p.amountFen / 100).toFixed(2)}
                  onChange={(e) => update(idx, { amountFen: Math.round(Number(e.target.value) * 100) })}
                />
              </td>
              <td>
                <input type="number" value={p.points} onChange={(e) => update(idx, { points: Number(e.target.value) })} />
              </td>
              <td className="muted">
                <div>{yuanPerPoint(p.amountFen, p.points)}</div>
                <div style={{ fontSize: 12 }}>
                  按汇率：{ratioPoints(p.amountFen).toLocaleString()} 点
                </div>
              </td>
              <td>
                <input type="number" value={p.sortOrder} onChange={(e) => update(idx, { sortOrder: Number(e.target.value) })} />
              </td>
              <td>
                <input type="checkbox" checked={p.enabled} onChange={(e) => update(idx, { enabled: e.target.checked })} />
              </td>
              <td>
                <button className="btn danger sm" onClick={() => remove(idx)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {packages.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                暂无套餐，用户端只保留自定义充值
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
