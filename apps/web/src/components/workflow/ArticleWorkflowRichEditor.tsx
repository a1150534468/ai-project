import type { FocusEventHandler } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import type Squire from "squire-rte";
import { articleWorkflowSanitizeToFragment } from "./articleWorkflowHtmlSanitizer";
import "./articleWorkflowRichEditor.css";

interface ArticleWorkflowRichEditorProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly syncKey: string;
  readonly onChange: (value: string) => void;
  readonly onBlurCommit?: (value: string) => void;
}

/**
 * 公众号正文编辑器。
 *
 * 用 Squire 而非 schema 型编辑器（wangEditor / Slate、Tiptap / ProseMirror）：
 * 那类编辑器把 HTML 解析成内部模型再吐回来，模型里没声明的东西载入时就被剥掉。
 * 公众号正文是 `section` 套 `section` 加纯内联样式，正好全在模型之外——
 * 实测结果是打开编辑器就把版式拍平、图片槽位丢光，自动保存再写回库里冲掉成品。
 *
 * Squire 拿 DOM 当真源，白名单内的标签、内联样式、data-* 原样保留。
 * 放行范围由 packages/article-workflow 的共用词汇表定义，跟服务端 guard 同一份。
 */
export function ArticleWorkflowRichEditor(props: ArticleWorkflowRichEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Squire | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastEmittedRef = useRef(props.value);
  /** 载入后编辑器自己整理过的那一版。用来判断 input 事件到底改没改东西 */
  const loadedHtmlRef = useRef(props.value);
  /**
   * 灌进来的原始字符串，跟库里的字节一致。
   *
   * Squire 载入时会做等价改写（strong→b、em→i，空块补 br），这层改写不是用户意图。
   * 所以「用户没动过」的时候必须把原字符串交回去，否则失焦提交会把改写结果写进库。
   */
  const originalValueRef = useRef(props.value);
  const onChangeRef = useRef(props.onChange);
  const [ready, setReady] = useState(false);
  const [empty, setEmpty] = useState(!props.value.trim());

  onChangeRef.current = props.onChange;

  const emitChange = useCallback((value: string, immediate = false) => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    if (value === lastEmittedRef.current) return;
    const commit = () => {
      lastEmittedRef.current = value;
      onChangeRef.current(value);
    };
    if (immediate) {
      commit();
      return;
    }
    timerRef.current = window.setTimeout(commit, 240);
  }, []);

  // Squire 直接操作 DOM，不能交给 React 渲染，因此只在挂载时建一次
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let disposed = false;
    let instance: Squire | null = null;

    void import("squire-rte").then((module) => {
      if (disposed || !rootRef.current) return;
      const SquireCtor = module.default;
      instance = new SquireCtor(rootRef.current, {
        blockTag: "P",
        // 别自动把输入的网址变成链接：那是编辑器擅自改内容
        addLinks: false,
        sanitizeToDOMFragment: (html: string) => articleWorkflowSanitizeToFragment(html),
        didError: (error: unknown) => {
          console.warn("[article-workflow] 编辑器内部错误", error);
        },
      });
      editorRef.current = instance;
      // setHTML 内部会置 _ignoreChange，不会触发 input 事件
      instance.setHTML(props.value);
      loadedHtmlRef.current = instance.getHTML();
      originalValueRef.current = props.value;
      lastEmittedRef.current = props.value;

      instance.addEventListener("input", () => {
        const current = editorRef.current;
        if (!current) return;
        const html = current.getHTML();
        setEmpty(!current.getRoot().textContent?.trim() && !html.includes("<img"));
        // 只有内容真的跟载入那版不同才往上报。Squire 不做规范化重写，
        // 所以这里基本等于「用户确实动了东西」，但留着这层判断更保险。
        if (html === loadedHtmlRef.current) return;
        emitChange(html, false);
      });
      setReady(true);
    });

    return () => {
      disposed = true;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      instance?.destroy();
      editorRef.current = null;
    };
    // 只跑一次：后续内容变化走下面的 syncKey effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 换行/换项目，或服务端回写了新内容时重新灌入
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance || !ready) return;
    if (props.value === lastEmittedRef.current) return;
    instance.setHTML(props.value);
    loadedHtmlRef.current = instance.getHTML();
    originalValueRef.current = props.value;
    lastEmittedRef.current = props.value;
    setEmpty(!props.value.trim());
  }, [props.syncKey, props.value, ready]);

  const handleBlurCapture: FocusEventHandler<HTMLDivElement> = () => {
    window.setTimeout(() => {
      const instance = editorRef.current;
      if (!instance) return;
      const html = instance.getHTML();
      // 没动过就把原字节交回去，让上层的哈希比对判成「没变化」，不触发保存
      if (html === loadedHtmlRef.current) {
        props.onBlurCommit?.(originalValueRef.current);
        return;
      }
      emitChange(html, true);
      props.onBlurCommit?.(html);
    }, 0);
  };

  return (
    <div className="article-workflow-rich-editor" onBlurCapture={handleBlurCapture}>
      <ArticleWorkflowRichEditorToolbar editorRef={editorRef} disabled={!ready} />
      <div className="article-workflow-rich-editor__body">
        {empty ? (
          <div className="article-workflow-rich-editor__placeholder" aria-hidden="true">
            {props.placeholder ?? "开始编辑正文"}
          </div>
        ) : null}
        <div
          ref={rootRef}
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

interface ToolbarProps {
  readonly editorRef: { current: Squire | null };
  readonly disabled: boolean;
}

/**
 * 工具栏只给运营真正会用到的几个键。
 *
 * 排版是 AI 出的，人在这一步做的是改错字、调措辞、强调重点。
 * 不放段落/对齐/列表这类布局键——它们会跟生成好的 section 结构打架。
 */
function ArticleWorkflowRichEditorToolbar({ editorRef, disabled }: ToolbarProps) {
  const run = (action: (editor: Squire) => void) => () => {
    const editor = editorRef.current;
    if (!editor) return;
    action(editor);
    editor.focus();
  };

  const toggle = (
    tag: string,
    apply: (editor: Squire) => void,
    remove: (editor: Squire) => void,
  ) => run((editor) => {
    if (editor.hasFormat(tag)) remove(editor);
    else apply(editor);
  });

  const handleLink = run((editor) => {
    if (editor.hasFormat("a")) {
      editor.removeLink();
      return;
    }
    const url = window.prompt("链接地址");
    if (!url?.trim()) return;
    editor.makeLink(url.trim(), { target: "_blank", rel: "noopener noreferrer" });
  });

  const buttons: readonly { readonly label?: string; readonly icon?: string; readonly title: string; readonly onClick: () => void }[] = [
    { label: "B", title: "加粗", onClick: toggle("b", (e) => e.bold(), (e) => e.removeBold()) },
    { label: "I", title: "斜体", onClick: toggle("i", (e) => e.italic(), (e) => e.removeItalic()) },
    { label: "U", title: "下划线", onClick: toggle("u", (e) => e.underline(), (e) => e.removeUnderline()) },
    { icon: "mdi:link-variant", title: "插入或移除链接", onClick: handleLink },
    { icon: "mdi:format-clear", title: "清除所选文字的格式", onClick: run((e) => e.removeAllFormatting()) },
    { icon: "mdi:undo", title: "撤销", onClick: run((e) => e.undo()) },
    { icon: "mdi:redo", title: "重做", onClick: run((e) => e.redo()) },
  ];

  return (
    <div className="article-workflow-rich-editor__toolbar" role="toolbar" aria-label="正文格式">
      {buttons.map((button) => (
        <button
          key={button.title}
          type="button"
          title={button.title}
          aria-label={button.title}
          disabled={disabled}
          // mousedown 就阻止默认行为，否则按钮抢焦点会先把编辑器里的选区清掉
          onMouseDown={(event) => event.preventDefault()}
          onClick={button.onClick}
          className="article-workflow-rich-editor__button"
        >
          {button.icon ? <Icon icon={button.icon} className="text-base" aria-hidden /> : button.label}
        </button>
      ))}
    </div>
  );
}
