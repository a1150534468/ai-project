import logo from "../assets/brand-logo.svg";

export function BrandLogo({ size = 40 }: { size?: number }) {
  return (
    <img
      src={logo}
      alt="AI 助手"
      width={size}
      height={size}
      style={{ borderRadius: 11 }}
    />
  );
}
