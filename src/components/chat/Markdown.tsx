import { Children, isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CodeBlock } from "./CodeBlock";

/** Recursively pull plain text out of rendered (possibly highlighted) children. */
function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (isValidElement(children)) {
    const props = children.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return "";
}

/** Renders a markdown code block into a CodeBlock, everything else as normal. */
function PreBlock({ children }: { children?: ReactNode }) {
  const first = Children.toArray(children)[0];
  if (!isValidElement(first)) {
    return <pre>{children}</pre>;
  }

  const props = first.props as { className?: string; children?: ReactNode };
  const className = String(props.className ?? "");
  const match = /language-(\w+)/.exec(className);
  const rawText = extractText(props.children);

  return (
    <CodeBlock language={match?.[1]} code={rawText}>
      {props.children}
    </CodeBlock>
  );
}

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const text = extractText(children).trim();
  const isFilePath = !className && (
    /(?:^|[\\/])[^\\/]+\.[a-z0-9]{1,8}$/i.test(text) ||
    /^(?:Desktop|Users|src|public|app|packages)[\\/]/i.test(text)
  );

  return (
    <code className={[className, isFilePath ? "md-file-path" : ""].filter(Boolean).join(" ")}>
      {children}
    </code>
  );
}

interface MarkdownProps {
  content: string;
  highlightCode?: boolean;
}

export const Markdown = memo(function Markdown({ content, highlightCode = true }: MarkdownProps) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={highlightCode ? [rehypeHighlight] : []}
        components={{ pre: PreBlock, code: MarkdownCode }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
