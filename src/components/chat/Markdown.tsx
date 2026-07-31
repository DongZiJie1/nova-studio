import { Children, isValidElement, type ReactNode } from "react";
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
  if (!isValidElement(first) || typeof first.type !== "string" || first.type !== "code") {
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

interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ pre: PreBlock }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
