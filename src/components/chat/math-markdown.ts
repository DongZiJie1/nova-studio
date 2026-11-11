/** Normalize LaTeX delimiters before Markdown consumes their backslashes. */
export function normalizeMathDelimiters(content: string): string {
  // Keep fenced and inline code verbatim, including examples of math syntax.
  return content.split(/(`{3,}[^\n]*\n[\s\S]*?(?:\n`{3,}[^\n]*(?=\n|$)|$)|~{3,}[^\n]*\n[\s\S]*?(?:\n~{3,}[^\n]*(?=\n|$)|$)|`+[^`\n]*`+)/g)
    .map((part, index) => index % 2 ? part : part
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
      .replace(/\\\(([^\n]*?)\\\)/g, (_, math: string) => `$${math}$`)
      // Some pasted notes have already lost the escaping around display brackets.
      .replace(/^\s*\[\s*([^\n]*\\[a-zA-Z]+[^\n]*)\s*\]\s*$/gm,
        (_, math: string) => `$$\n${math.trim()}\n$$`))
    .join("");
}
