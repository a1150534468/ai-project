/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 值全部来自 apps/web/src/index.css 的 --color-* 三元组，规范见 docs/design-system.md。
        // 别在这里写字面色值，否则暗色模式不会跟着切。
        brand: {
          DEFAULT: "rgb(var(--color-brand) / <alpha-value>)",
          soft: "rgb(var(--color-brand-soft) / <alpha-value>)",
          ink: "rgb(var(--color-brand-ink) / <alpha-value>)",
        },
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        ink: {
          DEFAULT: "rgb(var(--color-ink) / <alpha-value>)",
          secondary: "rgb(var(--color-ink-secondary) / <alpha-value>)",
          tertiary: "rgb(var(--color-ink-tertiary) / <alpha-value>)",
          inverse: "rgb(var(--color-ink-inverse) / <alpha-value>)",
        },
        hairline: {
          DEFAULT: "rgb(var(--color-hairline) / <alpha-value>)",
          subtle: "rgb(var(--color-hairline-subtle) / <alpha-value>)",
        },
        canvas: "rgb(var(--color-canvas) / <alpha-value>)",
        surface: {
          DEFAULT: "rgb(var(--color-surface) / <alpha-value>)",
          subtle: "rgb(var(--color-surface-subtle) / <alpha-value>)",
          muted: "rgb(var(--color-surface-muted) / <alpha-value>)",
          raised: "rgb(var(--color-surface-raised) / <alpha-value>)",
          inverse: "rgb(var(--color-surface-inverse) / <alpha-value>)",
        },
        danger: "rgb(var(--color-danger) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        info: "rgb(var(--color-info) / <alpha-value>)",
        success: "rgb(var(--color-success) / <alpha-value>)",
      },
      fontFamily: {
        sans: [
          "SF Pro Text",
          "SF Pro Display",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
          "Apple Color Emoji",
          "Segoe UI Emoji",
          "Segoe UI Symbol",
        ],
      },
      borderRadius: {
        xl2: "14px",
      },
      scale: {
        102: "1.02",
      },
    },
  },
  plugins: [],
};
