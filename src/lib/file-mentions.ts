export interface FileMention {
  start: number;
  end: number;
  query: string;
}

export function findFileMention(input: string, cursor: number): FileMention | null {
  const prefix = input.slice(0, cursor);
  const match = /(?:^| )@([^\s@]*)$/.exec(prefix);
  if (!match) return null;

  const start = prefix.lastIndexOf("@");
  return { start, end: cursor, query: match[1] };
}

export function insertFileMention(input: string, mention: FileMention, path: string): {
  value: string;
  cursor: number;
} {
  const replacement = `@${path} `;
  return {
    value: input.slice(0, mention.start) + replacement + input.slice(mention.end),
    cursor: mention.start + replacement.length,
  };
}
