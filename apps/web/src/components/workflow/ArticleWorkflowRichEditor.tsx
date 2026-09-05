import { Icon } from "@iconify/react";
import { useCallback, useEffect, useRef, useState, type FocusEventHandler } from "react";
import type Squire from "squire-rte";
import { articleWorkflowSanitizeToFragment } from "./articleWorkflowHtmlSanitizer";
import "./articleWorkflowRichEditor.css";

/**
 * 公众号正文编辑器。
 *
 * 为什么用 Squire 而不是 wangEditor / Slate / Tiptap 这类 schema 编辑器：那类编辑器把 HTML 解析成
 * 自己的模型再吐回来，模型里没声明的东西载入时就被剥掉。公众号正文恰好整个在模型之外 ——
 * `section` 套 `section`、纯内联样式、图片带槽位标记。实测结果是打开编辑器就把版式拍平、槽位丢光，
 * 自动保存再把拍平的那版写回库，成品当场毁掉。Squire 拿 DOM 当真源，白名单内的标签、内联样式、
 * data-* 原样留着，放行范围与服务端 guard 共用 packages/article-workflow 那份词汇表。
 *
 * 这一版收掉四处：
 *
 *  - **载入现场收成一个对象**。原来 `loadedHtmlRef` / `originalValueRef` / `lastEmittedRef` 三个 ref
 *    要在两处各写一遍，漏一个就会「明明没动过却判成脏」。现在只有一个 `load()` 统一改口径。
 *  - **判空口径统一**。占位文案原来在载入路看 `!props.value.trim()`、在输入路看「没文字也没图」，
 *    于是服务端表示空正文的 `<p><br></p>` 算非空字符串，占位文案压根不出来。
 *  - **失焦提交先确认焦点真走了**。原来 blur 冒到外层就提交，用 Tab 从正文挪到工具栏按钮也算一次；
 *    而且那个 `setTimeout(0)` 没人回收，切平台把组件拆掉之后它还会醒过来。
 *  - **工具栏那七个按钮提到模块级**。它们与某一次渲染无关，原来每渲染一遍重建七个对象七个闭包。
 */
interface ArticleWorkflowRichEditorProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly syncKey: string;
  readonly onChange: (value: string) => void;
  readonly onBlurCommit?: (value: string) => void;
}

/** 连着敲字只在停手之后报一次。 */
const EMIT_DELAY_MS = 240;

/**
 * 载入现场。同一段正文在这里有两个身份：`raw` 是库里的字节，`normalized` 是 Squire 载入时
 * 等价改写过的样子（strong→b、em→i、空块补 br）。
 *
 * 判「用户动过没有」只能拿 `normalized` 比，因为屏幕上就是那一版；回交给上层时必须交 `raw` ——
 * 交改写结果等于把编辑器的手笔当成用户编辑，自动保存跟着把它写进库，版式就此走形。
 */
interface LoadedBody {
  readonly raw: string;
  readonly normalized: string;
}

/**
 * 「这段正文看着是空的吗」—— 只用来决定占位文案露不露。
 *
 * 单看字符串长度不行：服务端表示空正文的写法是 `<p><br></p>`，字符串非空而屏幕上什么都没有。
 * 所以剥掉标签看剩下的字，图片单独放行 —— 只有一张图没有字也算有内容。
 */
function looksBlank(html: string): boolean {
  if (/<img\b/i.test(html)) return false;
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim().length === 0;
}

/** 编辑器装好之后直接问 DOM，比再解析一遍字符串准。 */
function surfaceLooksBlank(editor: Squire): boolean {
  const root = editor.getRoot();
  return !root.querySelector("img") && !root.textContent?.trim();
}

type ToolbarAction = (editor: Squire) => void;

interface ToolbarItem {
  readonly title: string;
  readonly label?: string;
  readonly icon?: string;
  readonly run: ToolbarAction;
}

/** 行内样式键一律「有就撤、没有就加」，包一层省得七个按钮各写一遍判断。 */
function toggleInline(tag: string, apply: ToolbarAction, remove: ToolbarAction): ToolbarAction {
  return (editor) => {
    if (editor.hasFormat(tag)) remove(editor);
    else apply(editor);
  };
}

const linkAction: ToolbarAction = (editor) => {
  if (editor.hasFormat("a")) {
    editor.removeLink();
    return;
  }
  const url = window.prompt("链接地址")?.trim();
  if (url) editor.makeLink(url, { target: "_blank", rel: "noopener noreferrer" });
};

/**
 * 工具栏只给运营真正会用到的几个键：改错字、调措辞、强调重点。
 * 段落 / 对齐 / 列表这类布局键一个不放 —— 它们会跟 AI 出的 section 结构打架。
 */
const TOOLBAR: readonly ToolbarItem[] = [
  { title: "加粗", label: "B", run: toggleInline("b", (e) => e.bold(), (e) => e.removeBold()) },
  { title: "斜体", label: "I", run: toggleInline("i", (e) => e.italic(), (e) => e.removeItalic()) },
  { title: "下划线", label: "U", run: toggleInline("u", (e) => e.underline(), (e) => e.removeUnderline()) },
  { title: "插入或移除链接", icon: "mdi:link-variant", run: linkAction },
  { title: "清除所选文字的格式", icon: "mdi:format-clear", run: (editor) => editor.removeAllFormatting() },
  { title: "撤销", icon: "mdi:undo", run: (editor) => editor.undo() },
  { title: "重做", icon: "mdi:redo", run: (editor) => editor.redo() },
];

export function ArticleWorkflowRichEditor(props: ArticleWorkflowRichEditorProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  /** Squire 的监听只在挂载时挂一次，闭包里不能留住某一次渲染的 props。 */
  const latest = useRef(props);
  latest.current = props;
  const loadedRef = useRef<LoadedBody>({ raw: props.value, normalized: props.value });
  /** 已经报上去的那一版。回灌进来时对得上就说明是自己刚报的，不该再当成新内容。 */
  const emittedRef = useRef(props.value);
  const emitTimerRef = useRef<number | null>(null);
  const blurTimerRef = useRef<number | null>(null);
  // 实例进 state 而不是只放 ref：工具栏要跟着它从禁用变可用，下面那个回灌 effect 也要等它就位
  const [editor, setEditor] = useState<Squire | null>(null);
  const [blank, setBlank] = useState(() => looksBlank(props.value));

  /** 一次载入要同时改三样口径：编辑器里的内容、判改动的基准、上报去重的基准。 */
  const load = useCallback((instance: Squire, raw: string) => {
    // setHTML 内部会置 _ignoreChange，这一下不会触发 input 事件
    instance.setHTML(raw);
    loadedRef.current = { raw, normalized: instance.getHTML() };
    emittedRef.current = raw;
    setBlank(surfaceLooksBlank(instance));
  }, []);

  /** 就现在报上去，顺手把待发的那次节流取消。 */
  const emitNow = useCallback((html: string) => {
    if (emitTimerRef.current != null) window.clearTimeout(emitTimerRef.current);
    emitTimerRef.current = null;
    if (html === emittedRef.current) return;
    emittedRef.current = html;
    latest.current.onChange(html);
  }, []);

  const scheduleEmit = useCallback(
    (html: string) => {
      if (emitTimerRef.current != null) window.clearTimeout(emitTimerRef.current);
      emitTimerRef.current = window.setTimeout(() => emitNow(html), EMIT_DELAY_MS);
    },
    [emitNow],
  );

  // Squire 直接操作 DOM，不能交给 React 渲染，所以它整段生命周期由这一个 effect 独自管：
  // 挂载时动态 import 一次，卸载时销毁实例并把两个计时器一起收掉
  useEffect(() => {
    let disposed = false;
    let instance: Squire | null = null;

    void import("squire-rte").then((module) => {
      const surface = surfaceRef.current;
      if (disposed || !surface) return;
      const Editor = module.default;
      const created = new Editor(surface, {
        blockTag: "P",
        // 别把输入的网址自动变成链接：那是编辑器擅自改内容
        addLinks: false,
        sanitizeToDOMFragment: (html: string) => articleWorkflowSanitizeToFragment(html),
        didError: (error: unknown) => {
          console.warn("[article-workflow] 编辑器内部错误", error);
        },
      });
      instance = created;
      load(created, latest.current.value);

      created.addEventListener("input", () => {
        const html = created.getHTML();
        setBlank(surfaceLooksBlank(created));
        // 跟载入那版一模一样就不算改动 —— 撤销回到原点会走到这里
        if (html === loadedRef.current.normalized) return;
        scheduleEmit(html);
      });
      setEditor(created);
    });

    return () => {
      disposed = true;
      if (emitTimerRef.current != null) window.clearTimeout(emitTimerRef.current);
      if (blurTimerRef.current != null) window.clearTimeout(blurTimerRef.current);
      instance?.destroy();
    };
  }, [load, scheduleEmit]);

  /**
   * 换行、换项目，或服务端回写了新内容：重新灌一遍。
   *
   * `value` 跟自己刚报上去的那版一致时一定不能动手 —— 自动保存每存一次都会换一把 syncKey，
   * 这时候 setHTML 会把光标顶回开头，而用户正在打字。
   */
  useEffect(() => {
    if (!editor || props.value === emittedRef.current) return;
    load(editor, props.value);
  }, [editor, load, props.syncKey, props.value]);

  /**
   * 焦点离开整块编辑器才算「这一轮写完了」。
   *
   * blur 冒上来的时候新焦点还没落地，所以等一拍再看 `activeElement`：用 Tab 从正文挪到工具栏
   * 按钮不算离开。这一拍还得记下来 —— 组件在这中间被拆掉（切平台）就取消，
   * 否则回调会对着已经销毁的编辑器读 HTML。
   */
  const handleBlurCapture: FocusEventHandler<HTMLDivElement> = (event) => {
    const wrapper = event.currentTarget;
    if (blurTimerRef.current != null) window.clearTimeout(blurTimerRef.current);
    blurTimerRef.current = window.setTimeout(() => {
      blurTimerRef.current = null;
      if (!editor || wrapper.contains(document.activeElement)) return;
      const { raw, normalized } = loadedRef.current;
      const html = editor.getHTML();
      // 没动过就把原字节交回去。交编辑器整理过的那版，上层的哈希比对会判成有改动，自动保存跟着写库
      if (html === normalized) {
        latest.current.onBlurCommit?.(raw);
        return;
      }
      emitNow(html);
      latest.current.onBlurCommit?.(html);
    }, 0);
  };

  return (
    <div className="article-workflow-rich-editor" onBlurCapture={handleBlurCapture}>
      <ArticleWorkflowRichEditorToolbar editor={editor} />
      <div className="article-workflow-rich-editor__body">
        {blank && (
          <div className="article-workflow-rich-editor__placeholder" aria-hidden="true">
            {props.placeholder ?? "开始编辑正文"}
          </div>
        )}
        <div
          ref={surfaceRef}
          className="article-workflow-rich-editor__surface"
          role="textbox"
          aria-multiline="true"
          aria-label="公众号正文"
          tabIndex={0}
        />
      </div>
    </div>
  );
}

function ArticleWorkflowRichEditorToolbar({ editor }: { readonly editor: Squire | null }) {
  return (
    <div className="article-workflow-rich-editor__toolbar" role="toolbar" aria-label="正文格式">
      {TOOLBAR.map((item) => (
        <button
          key={item.title}
          type="button"
          title={item.title}
          aria-label={item.title}
          disabled={!editor}
          // mousedown 就拦下默认行为：让按钮抢到焦点会先把编辑器里的选区清掉
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!editor) return;
            item.run(editor);
            editor.focus();
          }}
          className="article-workflow-rich-editor__button"
        >
          {item.icon ? <Icon icon={item.icon} className="text-base" aria-hidden /> : item.label}
        </button>
      ))}
    </div>
  );
}
