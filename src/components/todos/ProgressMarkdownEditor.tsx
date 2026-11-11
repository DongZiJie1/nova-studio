import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";

/** Keep the saved format as Markdown while editing formatted blocks in place. */
export function ProgressMarkdownEditor({
  content,
  onChange,
  onComposingChange,
}: {
  content: string;
  onChange: (value: string) => void;
  onComposingChange: (value: boolean) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), TableKit, Markdown],
    content,
    contentType: "markdown",
    autofocus: "end",
    editorProps: {
      handlePaste: (_view, event): boolean => {
        const text = event.clipboardData?.getData("text/plain");
        if (!text || !editor || editor.isActive("codeBlock")) return false;
        // Native HTML paste does not interpret Markdown copied as plain text.
        // Parse recognized Markdown before the browser splits it into paragraphs.
        const markdownSyntax = /(^|\n)(?:#{1,6}\s|>\s|[-*+]\s|\d+\.\s|```|\s*\|.*\|)|\*\*[^\n]+\*\*/;
        if (!markdownSyntax.test(text)) return false;
        event.preventDefault();
        return editor.commands.insertContent(text, { contentType: "markdown" });
      },
      attributes: {
        class: "md-body todo-progress-markdown-editor",
        role: "textbox",
        "aria-label": "进展内容，支持 Markdown 输入自动排版",
        "aria-multiline": "true",
      },
      handleDOMEvents: {
        compositionstart: () => { onComposingChange(true); return false; },
        compositionend: () => { onComposingChange(false); return false; },
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.getMarkdown()),
  });

  useEffect(() => {
    // Preserve the selection and undo history on ordinary typing updates.
    if (editor && editor.getMarkdown() !== content) {
      editor.commands.setContent(content, { contentType: "markdown", emitUpdate: false });
    }
  }, [editor, content]);

  return <EditorContent editor={editor} />;
}
