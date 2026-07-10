import { Icon } from "@iconify/react";

const DEFAULT_ICON = "mdi:robot-outline";
const SMALL_THRESHOLD = 28;

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
 * avatarSvg 是服务端 sanitize 过的线稿子树（白名单只放行 8 个绘图标签 + 描边属性，
 * 没有 fill/stroke/style/href/on*）。颜色由外层 stroke="currentColor" + CSS 决定。
 * 不要在别处直接渲染任何未经后端 sanitizeAgentSvg 的字符串。
 */
export function AgentAvatar({ avatarUrl, avatarSvg, icon, size, name, className = "" }: AgentAvatarProps) {
  const box = `flex-none rounded-lg bg-brand-soft text-brand flex items-center justify-center overflow-hidden ${className}`;
  const style = { width: size, height: size };

  if (avatarUrl) {
    return <img src={avatarUrl} alt={name} style={style} className={`${box} object-cover`} />;
  }

  if (avatarSvg) {
    return (
      <span style={style} className={box}>
        <svg
          viewBox="0 0 24 24"
          width={size * 0.62}
          height={size * 0.62}
          fill="none"
          stroke="currentColor"
          strokeWidth={size <= SMALL_THRESHOLD ? 2.5 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-label={name}
          role="img"
          dangerouslySetInnerHTML={{ __html: avatarSvg }}
        />
      </span>
    );
  }

  const activeIcon = icon || DEFAULT_ICON;
  return (
    <span style={style} className={box}>
      <span data-icon={activeIcon}>
        <Icon icon={activeIcon} style={{ fontSize: size * 0.6 }} aria-label={name} />
      </span>
    </span>
  );
}
