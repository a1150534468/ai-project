import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Panel, Stat, StatStrip, Pill, Modal, Field } from "../ui.js";
import { can, loadSession } from "../auth.js";
import { CohortTable, RankingTable, SalesTable, TrendChart, formatBytes, formatSeconds, formatCompact } from "./AnalyticsWidgets.js";

export function AnalyticsPage() {
  const session = loadSession();
  if (!can(session, "VIEW_ANALYTICS")) return <div className="card muted">无权限访问此功能</div>;

  const [ov, setOv] = useState<api.AnalyticsOverview | null>(null);
  const [lastRolledAt, setLast] = useState<string | null>(null);
  const [daily, setDaily] = useState<api.DailyRow[]>([]);
  const [ret, setRet] = useState<api.CohortMatrix | null>(null);
  const [ltv, setLtv] = useState<api.CohortMatrix | null>(null);
  const [rankings, setRankings] = useState<api.RankingsSummary | null>(null);
  const [sales, setSales] = useState<api.SalesSummary | null>(null);
  const { show, node } = useToast();
  const [rebuildModal, setRebuildModal] = useState(false);
  const [rebuildFrom, setRebuildFrom] = useState("");
  const [rebuildTo, setRebuildTo] = useState("");

  const load = async () => {
    try {
      const o = await api.analyticsOverview();
      setOv(o.data);
      setLast(o.lastRolledAt);
      setDaily(await api.analyticsDaily(30));
      setRet(await api.analyticsRetention());
      setLtv(await api.analyticsLtv());
      setRankings(await api.analyticsRankings(30));
      setSales(await api.analyticsSales(30));
    } catch (e) {
      show(errMsg(e), "err");
    }
  };
  useEffect(() => {
    void load();
    /* eslint-disable-next-line */
  }, []);

  const rebuild = async () => {
    setRebuildModal(true);
  };

  const handleRebuild = async () => {
    if (!rebuildFrom || !rebuildTo) {
      show("请输入起始日和结束日", "err");
      return;
    }
    try {
      const r = await api.analyticsRebuild(rebuildFrom, rebuildTo);
      show(`已重算 ${r.metricDays} 天`);
      setRebuildModal(false);
      setRebuildFrom("");
      setRebuildTo("");
      void load();
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  return (
    <div>
      {node}
      <Modal
        open={rebuildModal}
        title="重算数据"
        onClose={() => setRebuildModal(false)}
        footer={
          <div className="modal-footer-actions">
            <button className="btn ghost" onClick={() => setRebuildModal(false)}>
              取消
            </button>
            <button className="btn" onClick={handleRebuild}>
              重算
            </button>
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="起始日 (YYYY-MM-DD)">
            <input value={rebuildFrom} onChange={(e) => setRebuildFrom(e.target.value)} />
          </Field>
          <Field label="结束日 (YYYY-MM-DD)">
            <input value={rebuildTo} onChange={(e) => setRebuildTo(e.target.value)} />
          </Field>
        </div>
      </Modal>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          数据截至：{lastRolledAt ? new Date(lastRolledAt).toLocaleString() : "暂无（请重算）"}
        </span>
        <button className="btn" onClick={rebuild} style={{ fontSize: 12, padding: "6px 12px" }}>
          重算/回填
        </button>
      </div>

      {!ov && <div className="card muted">暂无数据，点「重算/回填」生成快照。</div>}
      {ov && (
        <>
          <Panel title="关键指标">
            <StatStrip>
              <Stat label="累计注册" value={ov.totalRegistered} />
              <Stat label="DAU" value={ov.dau} />
              <Stat label="WAU" value={ov.wau} />
              <Stat label="MAU" value={ov.mau} />
              <Stat label="付费率" value={`${(ov.paymentRate * 100).toFixed(2)}%`} />
              <Stat label="累计实付" value={`¥${ov.totalRevenueYuan.toFixed(2)}`} />
              <Stat label="ARPU" value={`¥${ov.arpu.toFixed(2)}`} />
              <Stat label="ARPPU" value={`¥${ov.arppu.toFixed(2)}`} />
              <Stat label="算力点余额" value={ov.totalBalance === null ? "—" : formatCompact(ov.totalBalance)} />
              <Stat label="视频点余额" value={ov.videoPointsBalance === null ? "—" : formatCompact(ov.videoPointsBalance)} />
              <Stat label="有余额用户" value={ov.usersWithBalance === null ? "—" : ov.usersWithBalance} />
              <Stat label="在线设备" value={ov.onlineDevices} />
              <Stat label="今日在线时长" value={formatSeconds(ov.onlineSecondsToday)} />
            </StatStrip>
          </Panel>

          <Panel title="近 30 日趋势">
            {daily.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <TrendChart data={daily} />
              </div>
            )}
            <table className="tbl">
              <thead>
                <tr>
                  <th>日期</th>
                  <th style={{ textAlign: "right" }}>新增注册</th>
                  <th style={{ textAlign: "right" }}>DAU</th>
                  <th style={{ textAlign: "right" }}>充值(元)</th>
                  <th style={{ textAlign: "right" }}>充值人数</th>
                  <th style={{ textAlign: "right" }}>订单</th>
                  <th style={{ textAlign: "right" }}>到账积分</th>
                  <th style={{ textAlign: "right" }}>消耗积分</th>
                  <th style={{ textAlign: "right" }}>充值比</th>
                  <th style={{ textAlign: "right" }}>新增付费</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => (
                  <tr key={d.date}>
                    <td className="muted">{d.date}</td>
                    <td className="num">{d.registered}</td>
                    <td className="num">{d.dau}</td>
                    <td className="num">{d.revenueYuan.toFixed(2)}</td>
                    <td className="num">{d.payingUsers}</td>
                    <td className="num">{d.topupCount}</td>
                    <td className="num">{d.grantedPoints}</td>
                    <td className="num">{d.consumedPoints}</td>
                    <td className="num">{d.rechargeUsageRatio === null ? "—" : d.rechargeUsageRatio.toFixed(2)}</td>
                    <td className="num">{d.newPayingUsers}</td>
                  </tr>
                ))}
                {daily.length === 0 && (
                  <tr>
                    <td colSpan={10} className="muted" style={{ textAlign: "center" }}>
                      无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>

          <Panel title="内容生产">
            <StatStrip>
              <Stat label="今日图片任务" value={ov.imageTasksToday} />
              <Stat label="近 30 日图片任务" value={ov.imageTasksMonth} />
              <Stat label="累计图片任务" value={ov.imageTasksTotal} />
              <Stat label="今日生成图片" value={ov.generatedImagesToday} />
              <Stat label="近 30 日生成图片" value={ov.generatedImagesMonth} />
              <Stat label="累计生成图片" value={ov.generatedImagesTotal} />
              <Stat label="今日知识上传" value={ov.kbUploadsToday} />
              <Stat label="近 30 日知识上传" value={ov.kbUploadsMonth} />
              <Stat label="累计知识上传" value={ov.kbUploadsTotal} />
              <Stat label="累计上传大小" value={formatBytes(ov.kbUploadBytesTotal)} />
            </StatStrip>
          </Panel>

          <Panel title="队列留存">
            <CohortTable m={ret} unit="%" />
          </Panel>

          <Panel title="队列 LTV（人均实付元）">
            <CohortTable m={ltv} unit="元" />
          </Panel>

          <Panel title="近 30 日排行榜">
            <div className="analytics-grid">
              <RankingTable title="用户消费" rows={rankings?.users ?? []} />
              <RankingTable title="模型消费" rows={rankings?.models ?? []} />
              <RankingTable title="功能消费" rows={rankings?.features ?? []} />
            </div>
          </Panel>

          <Panel title="近 30 日会员 / 套餐销量">
            <div className="analytics-grid two">
              <SalesTable title="会员销量" rows={sales?.memberships ?? []} />
              <SalesTable title="充值套餐" rows={sales?.rechargePackages ?? []} />
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
