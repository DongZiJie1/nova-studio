import { useEffect, useRef } from "react";
import type { SlashCommand } from "../../lib/slash-commands";

export function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
}: {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className="slash-command-menu" role="listbox" aria-label="Slash commands">
      <div className="slash-command-menu-scroll">
        {commands.map((command, index) => (
          <button
            key={command.name}
            ref={index === selectedIndex ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            className={`slash-command-option ${index === selectedIndex ? "slash-command-option-selected" : ""}`}
            onMouseEnter={() => onSelectedIndexChange(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(command)}
          >
            <span className="slash-command-name">/{command.name}</span>
            <span className="slash-command-description">{command.description}</span>
          </button>
        ))}
      </div>
      <div className="slash-command-hint">↑↓ 选择 · Tab / Enter 补全 · Esc 关闭</div>
    </div>
  );
}
