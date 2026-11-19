import { invoke } from "@tauri-apps/api/core";
import type { AgentInfo } from "./rpc-types";
import type { FactMemoryState } from "./tauri-bridge";

export interface PersistentAgentRun {
  agentId: string;
  projectPath: string;
  prompt: string;
  createdAt: string;
}
export interface PersistentAgent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  skills: string[];
  createdAt: string;
  updatedAt: string;
  runs: PersistentAgentRun[];
}
export type AgentInput = Pick<
  PersistentAgent,
  "name" | "description" | "instructions" | "tools" | "skills"
> & { id?: string };
export const listPersistentAgents = () =>
  invoke<PersistentAgent[]>("list_persistent_agents");
export const savePersistentAgent = (input: AgentInput) =>
  invoke<PersistentAgent>("save_persistent_agent", { input });
export const deletePersistentAgent = (id: string) =>
  invoke<void>("delete_persistent_agent", { id });
export const runPersistentAgent = (id: string, cwd: string, prompt: string) =>
  invoke<AgentInfo>("run_persistent_agent", { id, cwd, prompt });
export const getPersistentAgentMemory = (id: string) =>
  invoke<FactMemoryState>("get_persistent_agent_memory", { id });
export const archivePersistentAgentMemory = (id: string, factId: string) =>
  invoke<void>("archive_persistent_agent_memory", { id, factId });

export interface InstalledAgentSkill {
  name: string;
  description: string;
  filePath: string;
}
export const listInstalledAgentSkills = () =>
  invoke<InstalledAgentSkill[]>("list_installed_agent_skills");

export interface AgentToolCatalogItem {
  name: string;
  description: string;
  defaultEnabled: boolean;
  sourceInfo?: { source?: string; path?: string; scope?: string };
}
export const listAgentTools = () =>
  invoke<AgentToolCatalogItem[]>("list_agent_tools");
