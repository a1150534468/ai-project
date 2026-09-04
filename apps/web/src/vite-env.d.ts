/// <reference types="vite/client" />

/*
 * 只剩这一行。图片模块（*.png / *.jpg / *.jpeg / *.gif / *.svg）的
 * `const src: string; export default src` 声明 `vite/client` 自带一份，
 * 原先在这里又抄了五份一模一样的 —— 删掉，`import logo from "../assets/brand-logo.svg"` 照样过。
 * 真要加的是 vite 没覆盖的扩展名（比如 *.woff2 之类），别再把它已有的抄回来。
 */
