import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  readonly content: string;
  readonly variant?: "chat" | "report";
}

export function MarkdownMessage({ content, variant = "chat" }: MarkdownMessageProps) {
  const headingClass = variant === "report"
    ? {
      h1: "mb-4 text-2xl font-bold leading-tight text-[#1d1d1f]",
      h2: "mb-3 mt-6 text-xl font-semibold leading-snug text-[#1d1d1f]",
      h3: "mb-2 mt-5 text-base font-semibold leading-snug text-[#1d1d1f]",
    }
    : {
      h1: "mb-3 text-xl font-semibold leading-snug text-[#1d1d1f]",
      h2: "mb-2 mt-4 text-lg font-semibold leading-snug text-[#1d1d1f]",
      h3: "mb-2 mt-3 text-base font-semibold leading-snug text-[#1d1d1f]",
    };

  return (
    <div className="markdown-message text-sm leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          h1: ({ children }) => <h1 className={headingClass.h1}>{children}</h1>,
          h2: ({ children }) => <h2 className={headingClass.h2}>{children}</h2>,
          h3: ({ children }) => <h3 className={headingClass.h3}>{children}</h3>,
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-brand underline underline-offset-2 "
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="mb-2 ml-5 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 ml-5 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-4 border-brand/30 pl-3 text-gray-600">{children}</blockquote>
          ),
          code: ({ className, children }) => {
            const isBlock = Boolean(className);
            if (isBlock) {
              return <code className={className}>{children}</code>;
            }
            return (
              <code className="rounded bg-white px-1.5 py-0.5 text-[0.92em] text-gray-800 border border-gray-200">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto rounded-lg border border-gray-200 bg-white p-3 text-xs leading-5 text-gray-800">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="min-w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-t border-gray-100 px-3 py-2 align-top">{children}</td>,
          hr: () => <hr className="my-3 border-gray-200" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
