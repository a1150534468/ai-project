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
        // 每个状态色都是「填充 X / 弱底 X/10 / 底上文字 X-ink」三件套，和 brand 一致。
        // X 本身当文字放在 X/10 上只有 3~4:1，不够 AA，所以文字必须用 X-ink。
        danger: {
          DEFAULT: "rgb(var(--color-danger) / <alpha-value>)",
          ink: "rgb(var(--color-danger-ink) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--color-warning) / <alpha-value>)",
          ink: "rgb(var(--color-warning-ink) / <alpha-value>)",
        },
        info: {
          DEFAULT: "rgb(var(--color-info) / <alpha-value>)",
          ink: "rgb(var(--color-info-ink) / <alpha-value>)",
        },
        success: {
          DEFAULT: "rgb(var(--color-success) / <alpha-value>)",
          ink: "rgb(var(--color-success-ink) / <alpha-value>)",
        },
        // 两个「不随主题翻转」的角色：遮罩恒深，控制台面板恒深。
        scrim: "rgb(var(--color-scrim) / <alpha-value>)",
        console: {
          DEFAULT: "rgb(var(--color-console) / <alpha-value>)",
          ink: "rgb(var(--color-console-ink) / <alpha-value>)",
        },
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
