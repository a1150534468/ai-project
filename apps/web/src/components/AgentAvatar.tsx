import { Icon } from "@iconify/react";
import { cx } from "./ui";

const FALLBACK_ICON = "mdi:robot-outline";

/** 小头像里 2px 描边会糊成一团，28px 及以下加粗到 2.5 */
const THIN_STROKE_MAX = 28;

/** 线稿 / iconify 图标在方框里各自占的比例 */
const SVG_RATIO = 0.62;
const ICON_RATIO = 0.6;

const BOX = "flex flex-none items-center justify-center overflow-hidden rounded-lg bg-brand-soft text-brand";

/** 三种画法互斥，选中哪种连同它需要的数据一起带出来。 */
type AvatarSource =
  | { readonly kind: "photo"; readonly url: string }
  | { readonly kind: "line"; readonly markup: string }
  | { readonly kind: "glyph"; readonly slug: string };

interface AgentAvatarProps {
  avatarUrl?: string | null;
  avatarSvg?: string | null;
  icon?: string;
  size: number;
  name: string;
  className?: string;
}

/**
 * 头像来源优先级（与后端 spec 一致，唯一定义）：
 *   avatarUrl → avatarSvg → iconify slug → mdi:robot-outline
 *
 * 空串与 null 都算「没有」，所以一路用真值判断：后端把「没画出来」写成 null，
 * 而表单清空过的字段会留下 ""。
 */
function pickSource(url: string | null | undefined, markup: string | null | undefined, slug?: string): AvatarSource {
  if (url) return { kind: "photo", url };
  if (markup) return { kind: "line", markup };
  return { kind: "glyph", slug: slug || FALLBACK_ICON };
}

/**
 * Agent 头像。外层方框固定，里面按来源换画法 —— 三种来源共用同一个圆角裁切框，
 * 换头像时尺寸不会跳。
 *
 * avatarSvg 是服务端 sanitize 过的线稿子树（白名单只放行 8 个绘图标签 + 描边属性，
 * 没有 fill/stroke/style/href/on*）。颜色由外层 stroke="currentColor" + CSS 决定。
 * 不要在别处直接渲染任何未经后端 sanitizeAgentSvg 的字符串。
 */
export function AgentAvatar({ avatarUrl, avatarSvg, icon, size, name, className = "" }: AgentAvatarProps) {
  const source = pickSource(avatarUrl, avatarSvg, icon);
  return (
    <span style={{ width: size, height: size }} className={cx(BOX, className)}>
      {source.kind === "photo" && <img src={source.url} alt={name} className="h-full w-full object-cover" />}
      {source.kind === "line" && (
        <svg
          role="img"
          aria-label={name}
          viewBox="0 0 24 24"
          width={size * SVG_RATIO}
          height={size * SVG_RATIO}
          fill="none"
          stroke="currentColor"
          strokeWidth={size <= THIN_STROKE_MAX ? 2.5 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          dangerouslySetInnerHTML={{ __html: source.markup }}
        />
      )}
      {source.kind === "glyph" && (
        // data-icon 把 slug 摊在 DOM 上：iconify 异步取图，测试与排查都只能靠它认人
        <span data-icon={source.slug}>
          <Icon icon={source.slug} style={{ fontSize: size * ICON_RATIO }} aria-label={name} />
        </span>
      )}
    </span>
  );
}
