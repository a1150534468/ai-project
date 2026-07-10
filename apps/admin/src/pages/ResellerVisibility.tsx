import { useEffect, useState } from "react";
import * as api from "../api.js";
import { useToast, errMsg, Field, Panel } from "../ui.js";

export function ResellerVisibilityPage() {
  const [config, setConfig] = useState<api.ResellerVisibility | null>(null);
  const { show, node: toastNode } = useToast();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const data = await api.getResellerVisibility();
      setConfig(data);
    } catch (e) {
      show(errMsg(e), "err");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (key: keyof api.ResellerVisibility, value: boolean) => {
    if (!config) return;
    setConfig({ ...config, [key]: value });
  };

  const handleSave = async () => {
    if (!config) return;
    setBusy(true);
    try {
      await api.setResellerVisibility(config);
      show("配置已保存");
    } catch (e) {
      show(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  };

  if (!config) {
    return <Panel title="代理可见项"><p className="muted">加载中…</p></Panel>;
  }

  return (
    <div>
      {toastNode}
      <Panel title="代理可见项配置">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p className="muted" style={{ fontSize: 13 }}>
            控制所有代理在自己后台能看到哪些数据列。聊天内容永不开放。
          </p>
          <Field label="允许查看充值记录">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={config.showRecharge}
                onChange={(e) => handleChange("showRecharge", e.target.checked)}
                disabled={busy}
              />
              <span>显示充值相关数据</span>
            </label>
          </Field>
          <Field label="允许查看消费记录">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={config.showConsumption}
                onChange={(e) => handleChange("showConsumption", e.target.checked)}
                disabled={busy}
              />
              <span>显示消费相关数据</span>
            </label>
          </Field>
          <Field label="允许查看会员信息">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={config.showMembership}
                onChange={(e) => handleChange("showMembership", e.target.checked)}
                disabled={busy}
              />
              <span>显示会员等级信息</span>
            </label>
          </Field>
          <Field label="允许查看最后活跃时间">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={config.showLastActive}
                onChange={(e) => handleChange("showLastActive", e.target.checked)}
                disabled={busy}
              />
              <span>显示用户最后活跃时间</span>
            </label>
          </Field>
          <div style={{ marginTop: 8 }}>
            <button className="btn" onClick={handleSave} disabled={busy}>
              {busy ? "保存中…" : "保存配置"}
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
