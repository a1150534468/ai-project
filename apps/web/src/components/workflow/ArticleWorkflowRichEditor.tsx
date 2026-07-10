import "@wangeditor/editor/dist/css/style.css";
import type { IDomEditor, IEditorConfig, IToolbarConfig } from "@wangeditor/editor";
import type { ComponentType, CSSProperties, FocusEventHandler } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import "./articleWorkflowRichEditor.css";

interface ArticleWorkflowRichEditorProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly syncKey: string;
  readonly onChange: (value: string) => void;
  readonly onBlurCommit?: (value: string) => void;
}

export function ArticleWorkflowRichEditor(props: ArticleWorkflowRichEditorProps) {
  const [components, setComponents] = useState<{
    readonly Editor: ComponentType<{
      readonly value?: string;
      readonly defaultConfig: Partial<IEditorConfig>;
      readonly mode?: string;
      readonly style?: CSSProperties;
      readonly className?: string;
      readonly onCreated?: (editor: IDomEditor) => void;
      readonly onChange: (editor: IDomEditor) => void;
    }>;
    readonly Toolbar: ComponentType<{
      readonly editor: IDomEditor | null;
      readonly defaultConfig: Partial<IToolbarConfig>;
      readonly mode?: string;
      readonly style?: CSSProperties;
      readonly className?: string;
    }>;
  } | null>(null);
  const [editor, setEditor] = useState<IDomEditor | null>(null);
  const [localValue, setLocalValue] = useState(props.value);
  const timerRef = useRef<number | null>(null);
  const lastEmittedRef = useRef(props.value);
  const editorRef = useRef<IDomEditor | null>(null);

  useEffect(() => {
    lastEmittedRef.current = props.value;
    setLocalValue(props.value);
  }, [props.syncKey, props.value]);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      editorRef.current?.destroy();
      editorRef.current = null;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    void import("@wangeditor/editor-for-react").then((module) => {
      if (!active) return;
      setComponents({
        Editor: module.Editor as ComponentType<{
          readonly value?: string;
          readonly defaultConfig: Partial<IEditorConfig>;
          readonly mode?: string;
          readonly style?: CSSProperties;
          readonly className?: string;
          readonly onCreated?: (editor: IDomEditor) => void;
          readonly onChange: (editor: IDomEditor) => void;
        }>,
        Toolbar: module.Toolbar as ComponentType<{
          readonly editor: IDomEditor | null;
          readonly defaultConfig: Partial<IToolbarConfig>;
          readonly mode?: string;
          readonly style?: CSSProperties;
          readonly className?: string;
        }>,
      });
    });
    return () => {
      active = false;
    };
  }, []);

  const editorConfig = useMemo<Partial<IEditorConfig>>(() => ({
    placeholder: props.placeholder ?? "开始编辑正文",
  }), [props.placeholder]);

  const toolbarConfig = useMemo<Partial<IToolbarConfig>>(() => ({}), []);

  const emitChange = (value: string, immediate = false) => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    if (value === lastEmittedRef.current) return;
    const commit = () => {
      lastEmittedRef.current = value;
      props.onChange(value);
    };
    if (immediate) {
      commit();
      return;
    }
    timerRef.current = window.setTimeout(commit, 240);
  };

  const handleChange = (nextEditor: IDomEditor) => {
    const value = nextEditor.getHtml();
    setLocalValue(value);
    emitChange(value, false);
  };

  const handleCreated = (nextEditor: IDomEditor) => {
    editorRef.current = nextEditor;
    setEditor(nextEditor);
  };

  const handleBlurCapture: FocusEventHandler<HTMLDivElement> = () => {
    window.setTimeout(() => {
      const value = editorRef.current?.getHtml() ?? localValue;
      setLocalValue(value);
      emitChange(value, true);
      props.onBlurCommit?.(value);
    }, 0);
  };

  if (!components) {
    return (
      <div className="article-workflow-rich-editor">
        <div className="grid min-h-[560px] place-items-center bg-white text-sm text-[#6b7280]">
          正在准备编辑器...
        </div>
      </div>
    );
  }

  return (
    <div className="article-workflow-rich-editor" onBlurCapture={handleBlurCapture}>
      <div className="article-workflow-rich-editor__toolbar">
        <components.Toolbar editor={editor} defaultConfig={toolbarConfig} mode="simple" />
      </div>
      <div className="article-workflow-rich-editor__body">
        <components.Editor
          value={localValue}
          defaultConfig={editorConfig}
          mode="simple"
          onCreated={handleCreated}
          onChange={handleChange}
        />
      </div>
    </div>
  );
}
