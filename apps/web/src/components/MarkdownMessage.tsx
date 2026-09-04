import { useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/** 对话气泡窄、报告正文宽，两种场合只有标题分档不同，其余元素共用一套。 */
type Variant = "chat" | "report";

/** [h1, h2, h3] */
const HEADING: Record<Variant, readonly [string, string, string]> = {
  chat: [
    "mb-3 text-xl font-semibold leading-snug text-ink",
    "mb-2 mt-4 text-lg font-semibold leading-snug text-ink",
    "mb-2 mt-3 text-base font-semibold leading-snug text-ink",
  ],
  report: [
    "mb-4 text-2xl font-bold leading-tight text-ink",
    "mb-3 mt-6 text-xl font-semibold leading-snug text-ink",
    "mb-2 mt-5 text-base font-semibold leading-snug text-ink",
  ],
};

const LINK = "text-brand underline underline-offset-2";
const LIST = "mb-2 ml-5 space-y-1";
const QUOTE = "mb-2 border-l-4 border-brand/30 pl-3 text-ink-secondary";
const INLINE_CODE = "rounded border border-hairline-subtle bg-surface px-1.5 py-0.5 text-[0.92em] text-ink";
const CODE_BLOCK = "mb-2 overflow-x-auto rounded-lg border border-hairline-subtle bg-surface p-3 text-xs leading-5 text-ink";
const TABLE_FRAME = "mb-2 overflow-x-auto rounded-lg border border-hairline-subtle bg-surface";
const TH = "border-b border-hairline-subtle bg-surface-subtle px-3 py-2 text-left font-semibold";
const TD = "border-t border-hairline-subtle px-3 py-2 align-top";

/**
 * 代码有两种：带 class 的是代码块里的那一段（框由外面的 pre 画，这里原样透传语言 class，
 * 高亮插件才认得），裸的是行内片段，自己描个边。
 */
function Code({ className, children }: { readonly className?: string; readonly children?: ReactNode }) {
  return <code className={className || INLINE_CODE}>{children}</code>;
}

/** 表格套一层能横向滚的框：窄屏里一张宽表不该把整条消息撑出去。 */
function Table({ children }: { readonly children?: ReactNode }) {
  return (
    <div className={TABLE_FRAME}>
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  );
}

function renderers(variant: Variant): Components {
  const [h1, h2, h3] = HEADING[variant];
  return {
    h1: ({ children }) => <h1 className={h1}>{children}</h1>,
    h2: ({ children }) => <h2 className={h2}>{children}</h2>,
    h3: ({ children }) => <h3 className={h3}>{children}</h3>,
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
    a: ({ children, href }) => (
      <a href={href} target="_blank" rel="noreferrer" className={LINK}>
        {children}
      </a>
    ),
    ul: ({ children }) => <ul className={`${LIST} list-disc`}>{children}</ul>,
    ol: ({ children }) => <ol className={`${LIST} list-decimal`}>{children}</ol>,
    li: ({ children }) => <li className="pl-1">{children}</li>,
    blockquote: ({ children }) => <blockquote className={QUOTE}>{children}</blockquote>,
    code: Code,
    pre: ({ children }) => <pre className={CODE_BLOCK}>{children}</pre>,
    table: Table,
    th: ({ children }) => <th className={TH}>{children}</th>,
    td: ({ children }) => <td className={TD}>{children}</td>,
    hr: () => <hr className="my-3 border-hairline-subtle" />,
  };
}

interface MarkdownMessageProps {
  readonly content: string;
  readonly variant?: Variant;
}

/** 模型输出的 Markdown。渲染前过一遍 rehype-sanitize，模型吐出来的 HTML 不能直接进 DOM。 */
export function MarkdownMessage({ content, variant = "chat" }: MarkdownMessageProps) {
  // 这张表每渲染一次都新建的话，react-markdown 会认为组件全换了，整棵树重挂
  const components = useMemo(() => renderers(variant), [variant]);

  return (
    <div className="markdown-message break-words text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
