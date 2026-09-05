/**
 * 浮层的键盘行为：Esc 关掉、Tab 圈在面板里、关掉之后焦点还给打开它的那个元素。
 *
 * 为什么是一个 hook 而不是把浮层都收成一个 `<Modal>`：全站九处浮层的版式各不相同
 * （居中卡片 / 右侧抽屉 / 底部抽屉），进退场动画和「点遮罩要不要关」也各有各的口径，
 * 收成同一个组件就是改设计了。所以只把这三条键盘行为提出来共用，版式留在各自那边。
 *
 * 按 WAI-ARIA 的 dialog 模式做，另外两条是本仓自己的口径：
 * - 焦点已经落在面板里就不抢（「局部改写」那个 textarea 带 `autoFocus`，抢过来光标就跑了）；
 * - 面板没真的渲染出来就不做陷阱 —— 三个抽屉是 `xl:hidden`，宽屏下它们照样挂在 DOM 里，
 *   把 Tab 圈进一个 `display:none` 的子树等于让宽屏用户按 Tab 什么都不动。
 */
import { useCallback, useEffect, useRef } from "react";

/** `input:not([disabled])` 会把 `type="hidden"` 一起带进来，单独摘掉。 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/**
 * 同时开着的浮层按打开顺序排队，Esc 只交给最上面那个 —— 记忆页把详情抽屉和
 * `useConfirm` 的确认框并排挂着，删一条记忆的时候两个都是开的。
 */
const openDialogs: object[] = [];

/**
 * `checkVisibility` 是 2024 年才铺齐的（Firefox 125 才有），jsdom 25 干脆没有；
 * 取不到就按「渲染了」算 —— 用例里陷阱照测，浏览器里拿得到的一律照准。
 */
function rendered(panel: HTMLElement): boolean {
  return typeof panel.checkVisibility === "function" ? panel.checkVisibility() : true;
}

/** Tab 到头就绕回去。中间那些顺序交给浏览器自己排，只在两头接上。 */
function trapTab(event: KeyboardEvent, panel: HTMLElement): void {
  const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!first || !last) {
    // 一个能接焦点的都没有：把 Tab 吞掉，焦点留在面板上，别让它滑到背后那一屏去
    event.preventDefault();
    panel.focus();
    return;
  }
  const active = document.activeElement;
  // 焦点不知怎么跑出去了（点过遮罩再按 Tab 就会）：先拽回来
  if (!panel.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  // 焦点还落在面板本身（刚打开那一下）：往后走本来就进第一个，往前走要接到最后一个
  if (active === panel) {
    if (!event.shiftKey) return;
    event.preventDefault();
    last.focus();
    return;
  }
  if (active !== (event.shiftKey ? first : last)) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
}

interface DialogOptions {
  readonly open: boolean;
  /** 给 `undefined` 就是「这一刻不许关」：提交中的浮层连取消按钮都是禁的，Esc 得跟着禁 */
  readonly onClose: (() => void) | undefined;
  /** 必填：没有可访问名，读屏软件念到这一层只会说一句「对话框」 */
  readonly label: string;
}

/** role / aria / tabIndex / ref 必须落在同一个元素上，所以打包成一份摊上去。 */
export interface DialogProps {
  readonly ref: (node: HTMLElement | null) => void;
  readonly role: "dialog";
  readonly "aria-modal": true;
  readonly "aria-label": string;
  /** 面板自己要能接焦点：打开时先落在它身上，读屏软件才会念出这一层的名字 */
  readonly tabIndex: -1;
}

export function useDialog({ open, onClose, label }: DialogOptions): DialogProps {
  const panelRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // 回调每渲染都是新的，放进 ref 里，免得 effect 跟着它重跑把焦点又抢一遍
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const ref = useCallback((node: HTMLElement | null) => {
    panelRef.current = node;
  }, []);

  useEffect(() => {
    if (!open) return;
    const entry = {};
    openDialogs.push(entry);
    const opener = document.activeElement;
    openerRef.current = opener instanceof HTMLElement ? opener : null;
    if (panelRef.current && !panelRef.current.contains(opener)) panelRef.current.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      // 里层自己处理掉的按键不抢（重命名输入框的 Esc 就是自己收的）
      if (event.defaultPrevented) return;
      if (openDialogs[openDialogs.length - 1] !== entry) return;
      if (event.key === "Escape") {
        const close = closeRef.current;
        if (!close) return;
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel || !rendered(panel)) return;
      trapTab(event, panel);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const index = openDialogs.indexOf(entry);
      if (index >= 0) openDialogs.splice(index, 1);
      const restore = openerRef.current;
      openerRef.current = null;
      // 焦点还在面板里（或者随面板一起被摘走了）才还回去：人自己点到别处去了就别抢
      const active = document.activeElement;
      const inside = panelRef.current?.contains(active) ?? false;
      if (restore?.isConnected && (inside || active === null || active === document.body)) restore.focus();
    };
  }, [open]);

  return { ref, role: "dialog", "aria-modal": true, "aria-label": label, tabIndex: -1 };
}
