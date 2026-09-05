/**
 * 设置页：账号信息 / 外观 / 默认模型 / 登出 四张卡。
 *
 * 重写时收掉的几处：
 *  - **本页不再存一份「选中的模型」**。原来 `selectedModel` 是本地 state，还自己读写
 *    `localStorage["preferredModel"]`（App.tsx 里另有一份同名键）。记住的模型不在列表里时
 *    本页把第一个勾上、却没往上报，于是「设置页显示 A、对话页发 B」。现在勾选状态直接读
 *    `preferredModel` 这个 prop，落选兜底与对话页共用 `pickInitialModel` 并报上去，
 *    写盘的活只留在 App 那一处。
 *  - **加载态收成一个状态机**。原来 `loading` / `isSaving` 两个 state 只写不读，
 *    「加载中」与「空列表」共用 `models.length > 0` 一个判断：`listModels` 拉挂了
 *    （断网才抛，服务端报错它自己回空列表）就永远转圈。现在 loading / failed / ready
 *    三档各有各的话说，拉取本身与模型广场共用 `app/useModelCatalog`。
 *  - **底部那条 `message` 横幅去掉**：跟 toast 是同一句话，而且没有任何地方清空它，
 *    弹出来就一直压在页面底部。
 *  - **两个 `setTimeout` 去掉**（模型 200ms、登出 400ms）：都没有清理函数，先卸载就在
 *    死组件上 setState，而且延迟本身没在等任何东西。登出提示随之改成「已登出」。
 *  - **「跟随系统」换成 `components/ui/Switch`**：几何（44×24）与暗色下的滑块色归一到那一份。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { motion } from "motion/react";
import { useModelCatalog } from "../app/useModelCatalog";
import { pickInitialModel } from "../chatState";
import { Switch, cx } from "../components/ui";
import { RippleButton, spring, useToast } from "../motion";
import {
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  getThemePreference,
  preferredTheme,
  saveThemePreference,
  type ThemePreference,
} from "../theme";

interface SettingsPageProps {
  readonly uid?: string;
  readonly userName?: string;
  /** 勾选哪个模型完全由这个 prop 决定，本页不留副本 */
  readonly preferredModel?: string;
  readonly onPreferredModelChange?: (model: string) => void;
  readonly onLogout?: () => void;
}

/** 四张卡共用的外壳。图标默认品牌色，登出那张要的是中性灰。 */
function SectionCard({
  icon,
  title,
  quiet = false,
  children,
}: {
  readonly icon: string;
  readonly title: string;
  readonly quiet?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className="rounded-xl2 border border-hairline-subtle bg-surface p-6 shadow-sm">
      <h2 className="mb-6 flex items-center gap-3 text-lg font-bold text-ink">
        <Icon icon={icon} aria-hidden className={cx("text-2xl", quiet ? "text-ink-tertiary" : "text-brand")} />
        {title}
      </h2>
      {children}
    </section>
  );
}

/** 账号信息那两行。`<dl>` 里用 `<div>` 分组，读屏会把标签和值念成一对。 */
function InfoRow({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div className="border-b border-hairline-subtle pb-4 last:border-0">
      <dt className="mb-2 text-xs font-medium uppercase text-ink-secondary">{label}</dt>
      <dd className={cx("text-sm text-ink", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

/** 模型卡的三种「没得选」：加载中 / 拉挂了 / 服务端没给，都只有一个图标加一句话。 */
function Notice({ icon, text, spinning = false }: { readonly icon: string; readonly text: string; readonly spinning?: boolean }) {
  return (
    <p className="py-8 text-center text-sm text-ink-secondary">
      <Icon icon={icon} aria-hidden className={cx("mx-auto mb-2 block text-2xl", spinning && "animate-spin")} />
      {text}
    </p>
  );
}

export default function SettingsPage({
  uid = "未知用户",
  userName = "用户",
  preferredModel = "",
  onPreferredModelChange,
  onLogout,
}: SettingsPageProps) {
  const { show } = useToast();
  const catalog = useModelCatalog();
  const [themePreference, setThemePreference] = useState<ThemePreference>(getThemePreference);

  /**
   * 记住的模型不在列表里（第一次进来 / 那个模型下线了）就把兜底的那个报上去。规则与对话页
   * 共用 `pickInitialModel`，不然两处各判一次迟早分叉；报上去而不是在本页留一份，
   * 是因为「本页勾着的」和「对话页发出去的」必须是同一个值。上层没给回调时不勾任何一条 ——
   * 那种情况下本页说什么都不作数，与其显示一个假的选中态，不如什么都不显示。
   */
  useEffect(() => {
    if (catalog.status !== "ready" || catalog.models.length === 0) return;
    const fallback = pickInitialModel(catalog.models, preferredModel);
    if (fallback !== preferredModel) onPreferredModelChange?.(fallback);
  }, [catalog, preferredModel, onPreferredModelChange]);

  /** 主题偏好可能被别处改（别的标签页、系统深色开关），所以只信事件，不在本页另存一份判断。 */
  useEffect(() => {
    const sync = () => setThemePreference(getThemePreference());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) sync();
    };
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const chooseModel = useCallback(
    (model: string) => {
      onPreferredModelChange?.(model);
      show("ok", "默认模型已保存");
    },
    [onPreferredModelChange, show],
  );

  /** 关掉「跟随系统」就把当下看到的那个模式钉住，不然一关开关页面颜色就跳。 */
  const toggleSystemTheme = () => {
    // 只写不 setState：saveThemePreference 同步派发 THEME_CHANGE_EVENT，上面那个监听器是唯一入口
    saveThemePreference(themePreference === "system" ? preferredTheme() : "system");
  };

  const logout = () => {
    show("ok", "已登出");
    onLogout?.();
  };

  return (
    <div className="min-h-screen bg-surface">
      <header className="border-b border-hairline-subtle">
        <div className="mx-auto max-w-6xl px-8 py-8">
          <h1 className="mb-2 text-3xl font-bold text-ink">设置</h1>
          <p className="text-ink-secondary">管理账号信息和偏好设置</p>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <SectionCard icon="mdi:account-circle-outline" title="账号信息">
          <dl className="space-y-4">
            <InfoRow label="用户 ID" value={uid} mono />
            <InfoRow label="用户名" value={userName} />
          </dl>
        </SectionCard>

        <SectionCard icon="mdi:theme-light-dark" title="外观">
          <Switch
            checked={themePreference === "system"}
            label="跟随系统"
            description="使用设备或浏览器的显示模式"
            onToggle={toggleSystemTheme}
            className="min-h-14 w-full rounded-lg border border-hairline-subtle px-4 py-3 focus-visible:ring-2 focus-visible:ring-brand/30"
          />
        </SectionCard>

        <SectionCard icon="mdi:robot-outline" title="默认模型">
          {catalog.status === "loading" && <Notice icon="mdi:loading" text="加载模型列表中…" spinning />}
          {catalog.status === "failed" && (
            <Notice icon="mdi:alert-circle-outline" text={`模型列表加载失败：${catalog.reason}`} />
          )}
          {catalog.status === "ready" &&
            (catalog.models.length === 0 ? (
              <Notice icon="mdi:cloud-off-outline" text="服务端没有给出可选模型，新对话会用它自己的默认模型" />
            ) : (
              <fieldset className="space-y-3">
                <legend className="sr-only">默认模型</legend>
                {catalog.models.map((option) => {
                  const checked = option.model === preferredModel;

                  return (
                    <label
                      key={option.model}
                      className="flex cursor-pointer items-center gap-3 rounded-lg border border-hairline-subtle p-4 transition-colors"
                    >
                      <motion.input
                        type="radio"
                        name="preferred-model"
                        value={option.model}
                        checked={checked}
                        onChange={() => chooseModel(option.model)}
                        className="size-4 cursor-pointer accent-brand"
                        initial={false}
                        animate={{ scale: checked ? 1.2 : 1 }}
                        transition={spring.snappy}
                      />
                      <span className="flex-1 text-sm font-medium text-ink">{option.displayName}</span>
                      {checked && (
                        <motion.span
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={spring.bouncy}
                        >
                          <Icon icon="mdi:check-circle" aria-hidden className="text-lg text-brand" />
                        </motion.span>
                      )}
                    </label>
                  );
                })}
                <p className="pt-1 text-xs text-ink-secondary">
                  <Icon icon="mdi:information-outline" aria-hidden className="mr-1 inline" />
                  所选模型已保存到本地，用于新对话时的默认选择
                </p>
              </fieldset>
            ))}
        </SectionCard>

        <SectionCard icon="mdi:logout-variant" title="登出" quiet>
          <p className="mb-4 text-sm text-ink-secondary">登出后需要重新输入用户名和密码才能登录</p>
          <RippleButton
            onClick={logout}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-danger/10 px-4 py-2.5 font-medium text-danger-ink transition-colors"
          >
            <Icon icon="mdi:logout-variant" aria-hidden />
            退出登录
          </RippleButton>
        </SectionCard>
      </div>
    </div>
  );
}
