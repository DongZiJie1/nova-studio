export interface SlashCommand {
  name: string;
  description: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select a model" },
  { name: "scoped-models", description: "Configure model cycling" },
  { name: "export", description: "Export this session" },
  { name: "import", description: "Import a JSONL session" },
  { name: "share", description: "Share as a secret GitHub gist" },
  { name: "name", description: "Set the session name" },
  { name: "session", description: "Show session info and stats" },
  { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "fork", description: "Fork from an earlier message" },
  { name: "clone", description: "Duplicate this session" },
  { name: "tree", description: "Navigate session branches" },
  { name: "trust", description: "Configure project trust" },
  { name: "login", description: "Configure provider login" },
  { name: "logout", description: "Remove provider login" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact the session context" },
  { name: "resume", description: "Resume another session" },
  { name: "reload", description: "Reload Nova resources" },
  { name: "quit", description: "Quit Nova" },
];

export function matchingSlashCommands(input: string): SlashCommand[] {
  const match = input.match(/^\/([^\s/]*)$/);
  if (!match) return [];

  const query = match[1].toLowerCase();
  return BUILTIN_SLASH_COMMANDS
    .filter((command) => command.name.includes(query))
    .sort((left, right) => {
      const leftStarts = left.name.startsWith(query);
      const rightStarts = right.name.startsWith(query);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}
