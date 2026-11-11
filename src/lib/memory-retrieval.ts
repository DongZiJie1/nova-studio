export interface RetrievedFact {
  id: string;
  text: string;
}

/**
 * Parse `- [fact_...] text` lines from a `<retrieved_user_memory>` block.
 * Unknown lines (the tag, the preamble) are ignored.
 */
export function parseRetrievedFacts(content: string): RetrievedFact[] {
  const facts: RetrievedFact[] = [];
  for (const line of content.split("\n")) {
    const match = /^- \[(fact_[^\]]+)\]\s*(.*)$/.exec(line.trim());
    if (match) facts.push({ id: match[1], text: match[2] });
  }
  return facts;
}
