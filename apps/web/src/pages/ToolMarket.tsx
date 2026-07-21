import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { motion } from "motion/react";
import { RippleButton, Stagger, StaggerItem, useToast } from "../motion";
import {
  installMarketTool,
  listInstalledTools,
  listToolMarketCategories,
  listToolMarketSkills,
  type InstalledTool,
  type MarketSkill,
  type ToolMarketCategory,
} from "../api";

interface ToolMarketProps {
  token: string;
}

type Notice = { type: "success" | "error"; text: string } | null;

const skillKey = (categoryKey: string, marketId: string) => `${categoryKey}:${marketId}`;

function skillDescription(skill: MarketSkill, categoryLabel: string): string {
  return `面向${categoryLabel}场景的本地 skill。安装后可在对话中挂载，用来调用 ${skill.name} 相关能力。`;
}

interface CategoryTabsProps {
  categories: ToolMarketCategory[];
  activeKey: string;
  onSelect: (key: string) => void;
  loading: boolean;
}

// 分类栏：单行横向排列。桌面端隐藏了横向滚动条，故用鼠标滚轮转横向 + 两侧箭头/渐隐兜底，
// 避免超出视口的分类（如「浏览器自动化」）被截断且鼠标够不着。
function CategoryTabs({ categories, activeKey, onSelect, loading }: CategoryTabsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const syncEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    syncEdges();
    // React onWheel 默认 passive，无法 preventDefault，改用原生非 passive 监听把垂直滚轮转横向。
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", syncEdges, { passive: true });
    // 容器宽度随视口/侧栏变化时刷新箭头显隐；测试等无 ResizeObserver 的环境降级为不监听。
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncEdges) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", syncEdges);
      observer?.disconnect();
    };
  }, [syncEdges, categories.length]);

  const scrollByStep = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(200, el.clientWidth * 0.7), behavior: "smooth" });
  };

  return (
    <section className="rounded-lg border border-gray-100 bg-white p-4">
      <div className="relative">
        {edges.left && (
          <>
            <div className="pointer-events-none absolute inset-y-0 left-0 z-[5] w-12 rounded-l-lg bg-gradient-to-r from-white to-transparent" />
            <button
              type="button"
              aria-label="向左滚动分类"
              onClick={() => scrollByStep(-1)}
              className="absolute left-0 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 shadow-sm transition "
            >
              <Icon icon="mdi:chevron-left" className="text-lg" aria-hidden />
            </button>
          </>
        )}
        <div
          ref={scrollRef}
          className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {categories.map((category) => (
            <button
              key={category.key}
              type="button"
              onClick={() => onSelect(category.key)}
              className={`h-9 flex-none rounded-full px-4 text-xs font-medium transition ${
                activeKey === category.key
                  ? "bg-gray-900 text-white"
                  : "bg-gray-50 text-gray-600 "
              }`}
            >
              {category.label}
              <span className={`ml-2 ${activeKey === category.key ? "text-white/70" : "text-gray-400"}`}>
                {category.total.toLocaleString()}
              </span>
            </button>
          ))}
          {loading && (
            <div className="flex h-9 items-center gap-2 px-2 text-xs text-gray-400">
              <Icon icon="mdi:loading" className="text-base animate-spin" aria-hidden />
              加载分类
            </div>
          )}
        </div>
        {edges.right && (
          <>
            <div className="pointer-events-none absolute inset-y-0 right-0 z-[5] w-12 rounded-r-lg bg-gradient-to-l from-white to-transparent" />
            <button
              type="button"
              aria-label="向右滚动分类"
              onClick={() => scrollByStep(1)}
              className="absolute right-0 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 shadow-sm transition "
            >
              <Icon icon="mdi:chevron-right" className="text-lg" aria-hidden />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export default function ToolMarket({ token }: ToolMarketProps) {
  const toast = useToast();
  const [categories, setCategories] = useState<ToolMarketCategory[]>([]);
  const [activeCategoryKey, setActiveCategoryKey] = useState("");
  const [skillsByCategory, setSkillsByCategory] = useState<Record<string, MarketSkill[]>>({});
  const [installedTools, setInstalledTools] = useState<InstalledTool[]>([]);
  const [currentDeviceOnline, setCurrentDeviceOnline] = useState(false);
  const [query, setQuery] = useState("");
  const [pageLoading, setPageLoading] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [installingKey, setInstallingKey] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const activeCategory = categories.find((category) => category.key === activeCategoryKey);
  const activeSkills = activeCategoryKey ? skillsByCategory[activeCategoryKey] ?? [] : [];

  const installedToolsBySkillKey = useMemo(() => {
    const tools = new Map<string, InstalledTool>();
    for (const tool of installedTools) {
      if (tool.categoryKey && tool.marketId) tools.set(skillKey(tool.categoryKey, tool.marketId), tool);
    }
    return tools;
  }, [installedTools]);
  const currentAvailableCount = installedTools.filter((tool) => tool.availableOnCurrentDevice).length;

  const normalizedQuery = query.trim().toLowerCase();
  const filteredSkills = useMemo(() => {
    return activeSkills.filter((skill) => {
      if (!normalizedQuery) return true;
      return skill.name.toLowerCase().includes(normalizedQuery) || skill.id.includes(normalizedQuery);
    });
  }, [activeSkills, normalizedQuery]);
  const visibleSkills = filteredSkills.slice(0, 180);

  const hiddenMatchCount = Math.max(0, filteredSkills.length - visibleSkills.length);

  useEffect(() => {
    let cancelled = false;
    setPageLoading(true);
    setNotice(null);
    Promise.all([listToolMarketCategories(token), listInstalledTools(token)])
      .then(([categoryData, toolsData]) => {
        if (cancelled) return;
        setCategories(categoryData);
        setInstalledTools(toolsData.installed);
        setCurrentDeviceOnline(toolsData.currentDeviceOnline);
        setActiveCategoryKey((current) => current || categoryData[0]?.key || "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setNotice({ type: "error", text: err instanceof Error ? err.message : "加载工具市场失败" });
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!activeCategoryKey || skillsByCategory[activeCategoryKey]) return;
    let cancelled = false;
    setSkillsLoading(true);
    setNotice(null);
    listToolMarketSkills(token, activeCategoryKey)
      .then((category) => {
        if (!cancelled) {
          setSkillsByCategory((prev) => ({ ...prev, [activeCategoryKey]: category.skills }));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setNotice({ type: "error", text: err instanceof Error ? err.message : "加载分类工具失败" });
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCategoryKey, skillsByCategory, token]);

  const handleInstall = async (skill: MarketSkill) => {
    if (!activeCategoryKey) return;
    const key = skillKey(activeCategoryKey, skill.id);
    const existingTool = installedToolsBySkillKey.get(key);
    if (installingKey || existingTool?.availableOnCurrentDevice) return;
    setInstallingKey(key);
    setNotice(null);
    try {
      const installed = await installMarketTool(token, { categoryKey: activeCategoryKey, marketId: skill.id });
      setInstalledTools((prev) => [
        installed,
        ...prev.filter((tool) => tool.categoryKey !== installed.categoryKey || tool.marketId !== installed.marketId),
      ]);
      setCurrentDeviceOnline(true);
      const msg = existingTool ? `${skill.name} 已同步到当前电脑` : `${skill.name} 已安装`;
      setNotice({ type: "success", text: msg });
      toast.show("ok", msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "安装工具失败";
      setNotice({ type: "error", text: msg });
      toast.show("err", msg);
    } finally {
      setInstallingKey("");
    }
  };

  return (
    <div className="min-h-full bg-[#f5f7fa] px-4 py-5 lg:px-8 lg:py-7">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <section className="rounded-lg border border-gray-100 bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600">
                <Icon icon="mdi:toolbox-outline" className="text-base" aria-hidden />
                {categories.length.toLocaleString()} 个分类 · {installedTools.length.toLocaleString()} 个账号已安装 ·{" "}
                {currentAvailableCount.toLocaleString()} 个当前电脑可用
              </div>
              <h1 className="text-2xl font-bold tracking-normal text-gray-900">工具市场</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
                账号安装记录会保存在云端；skill 包体需要同步到当前电脑，可用后才会出现在对话输入框的工具按钮里。内置工具不在这里展示。
              </p>
            </div>
            <div className="relative w-full lg:w-96">
              <Icon icon="mdi:magnify" className="absolute left-3 top-1/2 -translate-y-1/2 text-lg text-gray-400" aria-hidden />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-11 w-full rounded-lg border border-gray-200 bg-white pl-10 pr-3 text-sm text-gray-800 outline-none transition focus:border-brand/50 focus:ring-2 focus:ring-brand/10"
                placeholder="搜索当前分类的 skill"
              />
            </div>
          </div>
        </section>

        {notice && (
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              notice.type === "error"
                ? "border-red-100 bg-red-50 text-red-700"
                : "border-brand/30 bg-brand-soft text-brand-ink"
            }`}
          >
            {notice.text}
          </div>
        )}

        <CategoryTabs
          categories={categories}
          activeKey={activeCategoryKey}
          loading={pageLoading}
          onSelect={(key) => {
            setActiveCategoryKey(key);
            setQuery("");
          }}
        />

        <section className="min-h-[32rem]">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-900">{activeCategory?.label || "技能列表"}</h2>
              <p className="mt-1 text-xs text-gray-500">
                已显示 {visibleSkills.length.toLocaleString()} 个
                {hiddenMatchCount > 0 ? `，继续搜索可缩小 ${hiddenMatchCount.toLocaleString()} 个未显示项` : ""}
              </p>
            </div>
            {skillsLoading && (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Icon icon="mdi:loading" className="text-base animate-spin" aria-hidden />
                加载 skill
              </div>
            )}
          </div>

          {visibleSkills.length > 0 ? (
            <Stagger className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visibleSkills.map((skill) => {
                const key = skillKey(activeCategoryKey, skill.id);
                const installedTool = installedToolsBySkillKey.get(key);
                const accountInstalled = Boolean(installedTool);
                const currentAvailable = installedTool?.availableOnCurrentDevice === true;
                const installing = installingKey === key;
                const actionText = currentAvailable
                  ? "可用"
                  : installing
                    ? accountInstalled
                      ? "同步中"
                      : "安装中"
                    : accountInstalled
                      ? "在本机安装/同步"
                      : "安装";
                return (
                  <StaggerItem key={key}>
                    <motion.article
                      className="flex min-h-52 flex-col rounded-lg border border-gray-100 bg-white p-4 shadow-sm"
                      whileHover={{ y: -4, boxShadow: "0 12px 32px rgba(15, 23, 42, 0.15)" }}
                      transition={{ duration: 0.3, type: "spring", stiffness: 260, damping: 32 }}
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-gray-50 text-gray-600">
                          <Icon icon="mdi:hammer-wrench" className="text-xl" aria-hidden />
                        </div>
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-gray-900">{skill.name}</h3>
                          <p className="mt-1 text-xs text-gray-400">#{skill.id}</p>
                        </div>
                      </div>
                      <p className="mt-4 line-clamp-3 text-sm leading-6 text-gray-500">
                        {skillDescription(skill, activeCategory?.label || "工具")}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs ${
                            accountInstalled ? "bg-brand-soft text-brand-ink" : "bg-gray-50 text-gray-500"
                          }`}
                        >
                          {accountInstalled ? "账号已安装" : "账号未安装"}
                        </span>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs ${
                            currentAvailable
                              ? "bg-brand/10 text-brand-ink"
                              : accountInstalled
                                ? "bg-amber-50 text-amber-700"
                                : "bg-gray-50 text-gray-500"
                          }`}
                        >
                          {currentAvailable ? "当前电脑可用" : accountInstalled ? "当前电脑缺包" : "当前电脑未安装"}
                        </span>
                      </div>
                      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                        <span className="min-w-0 truncate rounded-full bg-gray-50 px-2.5 py-1 text-xs text-gray-500">
                          {activeCategory?.label || "工具"}
                        </span>
                        <RippleButton
                          type="button"
                          onClick={() => void handleInstall(skill)}
                          disabled={currentAvailable || installing || Boolean(installingKey)}
                          title={!currentDeviceOnline && !currentAvailable ? "当前没有唯一在线的本机 Connector，点击后需要先连接本机" : undefined}
                          className={`h-9 min-w-32 rounded-lg px-3 text-xs font-medium transition ${
                            currentAvailable
                              ? "bg-brand-soft text-brand-ink"
                              : "bg-gray-900 text-white disabled:bg-gray-200 disabled:text-gray-400"
                          }`}
                        >
                          {actionText}
                        </RippleButton>
                      </div>
                    </motion.article>
                  </StaggerItem>
                );
              })}
            </Stagger>
          ) : (
            <div className="flex min-h-[28rem] flex-col items-center justify-center rounded-lg border border-dashed border-gray-200 bg-white px-6 text-center">
              <Icon icon={skillsLoading || pageLoading ? "mdi:loading" : "mdi:database-search-outline"} className={`text-3xl text-gray-300 ${skillsLoading || pageLoading ? "animate-spin" : ""}`} aria-hidden />
              <p className="mt-3 text-sm font-semibold text-gray-900">
                {skillsLoading || pageLoading ? "正在加载" : "暂无匹配 skill"}
              </p>
              {!skillsLoading && !pageLoading && (
                <p className="mt-1 text-xs text-gray-500">换一个关键词或分类再试。</p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
