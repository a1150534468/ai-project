/**
 * 营销落地页：未登录用户进站先看到它（而非直接进应用，也非跳登录）。
 * 两个出口——「开始使用」直接进应用外壳（匿名浏览，仅当前页面会话有效），
 * 「登录」进外壳并弹登录框。
 *
 * v1 内容静态：主张 + 数据条 + 功能四格 + 怎么用三步 + 工作流一览 + FAQ + 页脚 CTA。
 * 样张后续可改成从公开目录接口（/api/models、/portraits/options）拉取；这一版先保证
 * 稳定、可测、零请求。
 *
 * **不写任何收费/价格内容**（分档、单价、计费方式、免费对比都不写）——
 * 计价口径随模型和分辨率变，静态页上怎么写都会和模型广场对不上。
 *
 * 页内锚点跳转走 `scrollIntoView` 而不是真 hash：落地页显示时 `useClientNavigation`
 * 仍处于挂载状态（hook 排在登录闸门前面），写 hash 会和它的路由归一化互相覆盖。
 *
 * 根节点必须是 **定高 `h-dvh` + `overflow-y-auto`**，不能写 `min-h-dvh`：全局
 * `body { overflow: hidden }`（见 index.css，整页不滚、滚动条一律由内部面板自己管），
 * 用 min-height 的话内容一超出视口只会把自身撑高、溢出到 body 上被裁掉，页面就滚不动了。
 */
import { Icon } from "@iconify/react";
import { BrandLogo, RippleButton } from "../../motion";
import { ThemeToggle } from "../ThemeToggle";

interface LandingProps {
  readonly onEnter: () => void;
  readonly onLogin: () => void;
}

/** 顶栏锚点。id 对应下面各 section 的 DOM id。 */
const NAV_LINKS: readonly { readonly id: string; readonly label: string }[] = [
  { id: "features", label: "功能" },
  { id: "how", label: "怎么用" },
  { id: "showcase", label: "工作流" },
  { id: "faq", label: "常见问题" },
];

const STATS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "10+", label: "可选模型" },
  { value: "6", label: "大创作工作流" },
  { value: "免登录", label: "先逛后决定" },
];

const FEATURES: readonly { readonly icon: string; readonly title: string; readonly desc: string }[] = [
  { icon: "mdi:chat-outline", title: "智能对话", desc: "多模型、多 Agent，随手就能开一轮对话" },
  { icon: "mdi:view-dashboard-outline", title: "创作工作流", desc: "形象照、试穿、美甲、商品图、小说、文章，一站搞定" },
  { icon: "mdi:database-search-outline", title: "知识库", desc: "挂上你的资料，让回答有据可依" },
  { icon: "mdi:folder-multiple-image", title: "素材库", desc: "生成的作品自动归档，随取随用" },
];

const STEPS: readonly { readonly icon: string; readonly title: string; readonly desc: string }[] = [
  {
    icon: "mdi:compass-outline",
    title: "免登录随便逛",
    desc: "不注册也能浏览模型广场和全部工作流，先看看这里有什么、别人在生成什么。",
  },
  {
    icon: "mdi:chat-processing-outline",
    title: "挑个模型开聊",
    desc: "对话页选模型、选 Agent；知识库挂上你的资料，回答有据可依。",
  },
  {
    icon: "mdi:login-variant",
    title: "登录后生成",
    desc: "生成的作品自动归档进素材库，随取随用。",
  },
];

const SHOWCASE: readonly { readonly icon: string; readonly title: string; readonly desc: string }[] = [
  { icon: "mdi:account-tie", title: "商务形象照", desc: "上传一张自拍，生成多风格证件与商务形象" },
  { icon: "mdi:tshirt-crew", title: "AI 试穿", desc: "换装先看效果，不用等衣服寄到" },
  { icon: "mdi:hand-back-right", title: "美甲试甲", desc: "先试色再上手，款式随便挑" },
  { icon: "mdi:shopping", title: "商品主图", desc: "白底图、场景图，电商上架一套搞定" },
  { icon: "mdi:book-open-page-variant", title: "小说创作", desc: "从大纲到章节，长文创作有工作流兜底" },
  { icon: "mdi:post-outline", title: "多平台图文", desc: "选题到成稿，多平台文案一站生成" },
];

const FAQS: readonly { readonly q: string; readonly a: string }[] = [
  { q: "不登录能用吗？", a: "能。浏览模型广场和全部工作流不用登录；生成作品需要先登录。" },
  { q: "作品保存在哪里？", a: "自动归档到素材库，随取随用；清理浏览器数据前建议先下载到本地。" },
  { q: "我的素材安全吗？", a: "仅本人账号可见。请仅使用本人或已获授权的素材生成内容。" },
];

const SAMPLES: readonly { readonly icon: string; readonly label: string }[] = [
  { icon: "mdi:account-tie", label: "商务形象照" },
  { icon: "mdi:tshirt-crew", label: "AI 试穿" },
  { icon: "mdi:hand-back-right", label: "美甲试甲" },
  { icon: "mdi:shopping", label: "商品主图" },
  { icon: "mdi:book-open-page-variant", label: "小说创作" },
];

/** 主 CTA 与次 CTA 的样式，Hero / 页脚 CTA 共用。 */
const CTA_PRIMARY = "rounded-full bg-brand px-7 py-3 font-medium text-white transition-transform active:scale-[0.98]";
const CTA_GHOST =
  "rounded-full border border-hairline px-7 py-3 font-medium text-ink transition-colors hover:bg-surface";
const SECTION_TITLE = "mb-3 text-center text-2xl font-bold";
const SECTION_SUB = "mb-10 text-center text-ink-secondary";

export default function Landing({ onEnter, onLogin }: LandingProps) {
  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="h-dvh overflow-y-auto overscroll-contain bg-surface-muted text-ink" data-testid="landing-root">
      {/* 顶栏：毛玻璃吸顶，锚点导航 + 双出口。窄屏只留品牌和CTA，锚点收进Hero下面的分区 */}
      <header className="sticky top-0 z-10 border-b border-hairline-subtle bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-3">
            <BrandLogo size={32} />
            <span className="text-lg font-semibold">AI 助手</span>
          </div>
          <nav className="hidden items-center gap-6 md:flex" aria-label="页面导航">
            {NAV_LINKS.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => scrollTo(link.id)}
                className="text-sm text-ink-secondary transition-colors hover:text-ink"
              >
                {link.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <ThemeToggle compact />
            <button type="button" onClick={onLogin} className="text-sm font-medium text-ink-secondary hover:text-ink">
              登录
            </button>
            <RippleButton onClick={onEnter} className={`${CTA_PRIMARY} px-5 py-2 text-sm`}>
              开始使用
            </RippleButton>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        {/* Hero */}
        <section className="flex flex-col items-center gap-6 py-20 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-hairline-subtle bg-surface px-4 py-1.5 text-xs font-medium text-ink-secondary">
            <Icon icon="mdi:sparkles" className="text-brand" aria-hidden />
            AI 创作工作台 · 免登录随便逛
          </span>
          <h1 className="max-w-3xl text-4xl font-bold leading-tight sm:text-5xl">先看见，再决定怎样被看见</h1>
          <p className="max-w-2xl text-lg text-ink-secondary">
            一个全能 AI 创作平台：对话、形象照、试穿、商品图、小说、文章——先免登录随便逛，想生成时再登录。
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <RippleButton onClick={onEnter} className={CTA_PRIMARY}>
              开始使用
            </RippleButton>
            <button type="button" onClick={onLogin} className={CTA_GHOST}>
              登录
            </button>
          </div>
          {/* 能力样例 */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {SAMPLES.map((sample) => (
              <span
                key={sample.label}
                className="inline-flex items-center gap-2 rounded-full border border-hairline-subtle bg-surface px-4 py-2 text-sm text-ink-secondary"
              >
                <Icon icon={sample.icon} className="text-brand" aria-hidden />
                {sample.label}
              </span>
            ))}
          </div>
          {/* 数据条 */}
          <dl className="mt-6 grid w-full max-w-2xl grid-cols-3 gap-4">
            {STATS.map((stat) => (
              <div key={stat.label} className="rounded-xl2 border border-hairline-subtle bg-surface px-4 py-5 shadow-sm">
                <dt className="sr-only">{stat.label}</dt>
                <dd>
                  <span className="block text-2xl font-bold text-brand">{stat.value}</span>
                  <span className="mt-1 block text-xs text-ink-secondary">{stat.label}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* 功能四格 */}
        <section id="features" className="scroll-mt-20 pb-20">
          <h2 className={SECTION_TITLE}>一个工作台，装下整个创作流</h2>
          <p className={SECTION_SUB}>从对话到成品，中间不用切换第二个应用</p>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="rounded-xl2 border border-hairline-subtle bg-surface p-6 shadow-sm">
                <Icon icon={feature.icon} className="mb-4 block text-3xl text-brand" aria-hidden />
                <h3 className="mb-2 text-lg font-semibold">{feature.title}</h3>
                <p className="text-sm text-ink-secondary">{feature.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 怎么用 */}
        <section id="how" className="scroll-mt-20 pb-20">
          <h2 className={SECTION_TITLE}>三步就能开始</h2>
          <p className={SECTION_SUB}>先逛后生成，每一步都没有门槛</p>
          <ol className="grid gap-5 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="rounded-xl2 border border-hairline-subtle bg-surface p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex size-9 flex-none items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                    {index + 1}
                  </span>
                  <Icon icon={step.icon} className="text-2xl text-brand" aria-hidden />
                </div>
                <h3 className="mb-2 text-lg font-semibold">{step.title}</h3>
                <p className="text-sm text-ink-secondary">{step.desc}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* 工作流一览 */}
        <section id="showcase" className="scroll-mt-20 pb-20">
          <h2 className={SECTION_TITLE}>六大工作流，随点随用</h2>
          <p className={SECTION_SUB}>每一个都是从真实需求里长出来的，不是 Demo 摆设</p>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {SHOWCASE.map((item) => (
              <div
                key={item.title}
                className="flex gap-4 rounded-xl2 border border-hairline-subtle bg-surface p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <Icon icon={item.icon} className="mt-0.5 flex-none text-3xl text-brand" aria-hidden />
                <div>
                  <h3 className="mb-1 text-base font-semibold">{item.title}</h3>
                  <p className="text-sm text-ink-secondary">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-20 pb-20">
          <h2 className={SECTION_TITLE}>常见问题</h2>
          <p className={SECTION_SUB}>没想起来的，进去随便逛一圈就明白了</p>
          <div className="mx-auto max-w-3xl space-y-3">
            {FAQS.map((faq) => (
              <details
                key={faq.q}
                className="group rounded-xl2 border border-hairline-subtle bg-surface px-6 py-4 shadow-sm"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left font-medium">
                  {faq.q}
                  <Icon
                    icon="mdi:chevron-down"
                    className="flex-none text-ink-tertiary transition-transform group-open:rotate-180"
                    aria-hidden
                  />
                </summary>
                <p className="mt-3 text-sm text-ink-secondary">{faq.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* 页脚 CTA */}
        <section className="flex flex-col items-center gap-4 border-t border-hairline-subtle py-16 text-center">
          <h2 className="text-2xl font-bold">现在就进去逛逛</h2>
          <p className="text-ink-secondary">浏览全部功能无需登录，想生成作品时再登录即可。</p>
          <RippleButton onClick={onEnter} className={CTA_PRIMARY}>
            开始使用
          </RippleButton>
        </section>
      </main>

      <footer className="mx-auto max-w-6xl px-6 pb-10">
        <div className="flex flex-col items-center gap-4 border-t border-hairline-subtle pt-8 text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {NAV_LINKS.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => scrollTo(link.id)}
                className="text-sm text-ink-secondary transition-colors hover:text-ink"
              >
                {link.label}
              </button>
            ))}
          </div>
          <p className="max-w-2xl text-xs text-ink-tertiary">
            AI 生成预览，不等同于真实拍摄或身份凭证；请仅使用本人或已获授权的素材。
          </p>
        </div>
      </footer>
    </div>
  );
}
