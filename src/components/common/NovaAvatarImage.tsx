import { agentAvatarSrc, type AgentAvatarId } from "../../lib/agent-avatars";
import { useSettingsStore } from "../../stores/settings-store";

export function NovaAvatarImage({ avatarId, fallbackSrc, alt = "Nova" }: { avatarId?: AgentAvatarId; fallbackSrc?: string; alt?: string }) {
  const customAvatar = useSettingsStore((state) => state.novaAvatar);
  return <img src={customAvatar ?? fallbackSrc ?? agentAvatarSrc(avatarId ?? "nova-light")} alt={alt} data-custom-avatar={customAvatar ? "true" : undefined} />;
}
