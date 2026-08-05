export const AGENT_AVATARS = [
  { id: "nova-light", src: "/images/nova-avatar.jpg" },
  { id: "nova-dark", src: "/images/nova-avatar-dark.jpg" },
] as const;

export type AgentAvatarId = (typeof AGENT_AVATARS)[number]["id"];

const AVATAR_ASSIGNMENTS_KEY = "nova-studio.agent-avatars";

function isAvatarId(value: unknown): value is AgentAvatarId {
  return AGENT_AVATARS.some((avatar) => avatar.id === value);
}

function readAssignments(): Record<string, AgentAvatarId> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(AVATAR_ASSIGNMENTS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, AgentAvatarId] => isAvatarId(entry[1])),
    );
  } catch {
    return {};
  }
}

export function getOrAssignAgentAvatar(agentId: string): AgentAvatarId {
  const assignments = readAssignments();
  const existing = assignments[agentId];
  if (existing) return existing;

  const selected = AGENT_AVATARS[Math.floor(Math.random() * AGENT_AVATARS.length)].id;
  assignments[agentId] = selected;
  try {
    localStorage.setItem(AVATAR_ASSIGNMENTS_KEY, JSON.stringify(assignments));
  } catch {
    // The in-memory AgentState still keeps the assignment for this app session.
  }
  return selected;
}

export function agentAvatarSrc(avatarId: AgentAvatarId): string {
  return AGENT_AVATARS.find((avatar) => avatar.id === avatarId)?.src ?? AGENT_AVATARS[0].src;
}
