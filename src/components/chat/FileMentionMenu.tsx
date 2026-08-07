import { useEffect, useRef } from "react";
import { File } from "lucide-react";

function fileParts(path: string): { name: string; directory: string } {
  const separator = path.lastIndexOf("/");
  return separator === -1
    ? { name: path, directory: "" }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator) };
}

export function FileMentionMenu({
  files,
  loading,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
}: {
  files: string[];
  loading: boolean;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onSelect: (path: string) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className="slash-command-menu file-mention-menu" role="listbox" aria-label="Project files">
      <div className="file-mention-title">项目文件</div>
      <div className="slash-command-menu-scroll">
        {files.map((path, index) => {
          const parts = fileParts(path);
          return (
            <button
              key={path}
              ref={index === selectedIndex ? selectedRef : undefined}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={`file-mention-option ${index === selectedIndex ? "slash-command-option-selected" : ""}`}
              onMouseEnter={() => onSelectedIndexChange(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(path)}
            >
              <File size={13} className="file-mention-icon" />
              <span className="file-mention-name">{parts.name}</span>
              {parts.directory && <span className="file-mention-directory">{parts.directory}</span>}
            </button>
          );
        })}
        {files.length === 0 && (
          <div className="file-mention-empty">{loading ? "正在查找文件…" : "没有匹配的文件"}</div>
        )}
      </div>
      <div className="slash-command-hint">↑↓ 选择 · Tab / Enter 插入 · Esc 关闭</div>
    </div>
  );
}
