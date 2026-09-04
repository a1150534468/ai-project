/**
 * 品牌 logo。宽高都跟着 `size` 走并显式写在属性上（而不是只给 CSS）——
 * 图还没下载完时浏览器就能按这个尺寸占好位，侧栏不会先塌一下再弹开。
 */
import logo from "../assets/brand-logo.svg";

export function BrandLogo({ size = 40 }: { size?: number }) {
  return <img src={logo} alt="AI 助手" width={size} height={size} style={{ borderRadius: 11 }} />;
}
