import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  /** Detected language (without the `language-` prefix) */
  language?: string;
  /** Raw code text used for the copy button */
  code: string;
  /** Rendered children (highlighted tokens or plain text) */
  children?: ReactNode;
}

export function CodeBlock({ language, code, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; ignore.
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language || "code"}</span>
        <button
          className="code-block-copy"
          onClick={handleCopy}
          title="Copy code"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-block-pre">
        <code className={`hljs${language ? ` language-${language}` : ""}`}>
          {children}
        </code>
      </pre>
    </div>
  );
}
