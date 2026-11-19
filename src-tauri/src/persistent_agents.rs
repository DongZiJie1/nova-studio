use crate::commands::{nova_agent_dir, AgentManagerState, FactMemoryState};
use crate::rpc_types::{AgentInfo, SpawnRequest};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

static PROFILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    agent_id: String,
    project_path: String,
    prompt: String,
    created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentAgent {
    id: String,
    name: String,
    description: String,
    instructions: String,
    tools: Vec<String>,
    skills: Vec<String>,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    runs: Vec<AgentRun>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInput {
    id: Option<String>,
    name: String,
    description: String,
    instructions: String,
    tools: Vec<String>,
    skills: Vec<String>,
}

fn directory_at(root: &Path, id: &str) -> Result<PathBuf, String> {
    let uuid = uuid::Uuid::parse_str(id).map_err(|_| "Invalid Agent id")?;
    if uuid.to_string() != id || uuid.get_version_num() != 4 {
        return Err("Invalid Agent id".into());
    }
    Ok(root.join("agents").join(id))
}

fn directory(id: &str) -> Result<PathBuf, String> {
    directory_at(&nova_agent_dir()?, id)
}

fn read_profile(dir: &Path) -> Result<PersistentAgent, String> {
    let content = std::fs::read_to_string(dir.join("profile.json")).map_err(|e| e.to_string())?;
    let mut profile: PersistentAgent = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    profile.instructions =
        std::fs::read_to_string(dir.join("AGENTS.md")).map_err(|e| e.to_string())?;
    Ok(profile)
}

fn write_profile(dir: &Path, profile: &PersistentAgent) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let temp = dir.join(format!("profile-{}.tmp", uuid::Uuid::new_v4()));
    let data = serde_json::to_vec_pretty(profile).map_err(|e| e.to_string())?;
    std::fs::write(&temp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, dir.join("profile.json")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_agent_tools(state: State<'_, AgentManagerState>) -> Result<serde_json::Value, String> {
    state.0.list_agent_tools().await
}

#[tauri::command]
pub async fn list_installed_agent_skills(state: State<'_, AgentManagerState>) -> Result<serde_json::Value, String> {
    state.0.list_installed_agent_skills().await
}

#[tauri::command]
pub fn list_persistent_agents() -> Result<Vec<PersistentAgent>, String> {
    let _guard = PROFILE_LOCK.lock().map_err(|e| e.to_string())?;
    let root = nova_agent_dir()?.join("agents");
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut items = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.join("profile.json").exists() {
            items.push(read_profile(&path)?);
        }
    }
    items.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(items)
}

#[tauri::command]
pub fn save_persistent_agent(input: AgentInput) -> Result<PersistentAgent, String> {
    let _guard = PROFILE_LOCK.lock().map_err(|e| e.to_string())?;
    if input.name.trim().is_empty() || input.name.chars().count() > 80 {
        return Err("Agent 名称需要 1–80 个字符".into());
    }
    if input.instructions.len() > 200_000 {
        return Err("AGENTS.md 过长".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let dir = directory(&id)?;
    let previous = if input.id.is_some() {
        Some(read_profile(&dir)?)
    } else {
        None
    };
    let profile = PersistentAgent {
        id,
        name: input.name.trim().into(),
        description: input.description,
        instructions: input.instructions,
        tools: input.tools,
        skills: input
            .skills
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        created_at: previous
            .as_ref()
            .map(|p| p.created_at.clone())
            .unwrap_or(now.clone()),
        updated_at: now,
        runs: previous.map(|p| p.runs).unwrap_or_default(),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let temp = dir.join("AGENTS.md.tmp");
    std::fs::write(&temp, &profile.instructions).map_err(|e| e.to_string())?;
    std::fs::rename(temp, dir.join("AGENTS.md")).map_err(|e| e.to_string())?;
    write_profile(&dir, &profile)?;
    Ok(profile)
}

#[tauri::command]
pub async fn delete_persistent_agent(
    state: State<'_, AgentManagerState>,
    id: String,
) -> Result<(), String> {
    let profile = read_profile(&directory(&id)?)?;
    for run in &profile.runs {
        if state.0.get_process(&run.agent_id).await.is_some() {
            return Err("请先停止该 Agent 的执行会话，再删除身份与记忆".into());
        }
    }
    let _guard = PROFILE_LOCK.lock().map_err(|e| e.to_string())?;
    std::fs::remove_dir_all(directory(&id)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_persistent_agent(
    state: State<'_, AgentManagerState>,
    id: String,
    cwd: String,
    prompt: String,
) -> Result<AgentInfo, String> {
    if prompt.trim().is_empty() {
        return Err("请输入任务内容".into());
    }
    if !Path::new(&cwd).is_absolute() || !Path::new(&cwd).is_dir() {
        return Err("请选择有效的项目目录".into());
    }
    read_profile(&directory(&id)?)?;
    let info = state
        .0
        .spawn(SpawnRequest {
            cwd: cwd.clone(),
            worktree_enabled: false,
            parent_agent_id: None,
            model: None,
            provider: None,
            args: Some(vec!["--persistent-agent".into(), id.clone()]),
            depth: 0,
        })
        .await?;
    {
        let _guard = PROFILE_LOCK.lock().map_err(|e| e.to_string())?;
        let dir = directory(&id)?;
        let mut profile = read_profile(&dir)?;
        profile.runs.push(AgentRun {
            agent_id: info.id.clone(),
            project_path: cwd,
            prompt: prompt.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        });
        write_profile(&dir, &profile)?;
    }
    Ok(info)
}

#[tauri::command]
pub fn get_persistent_agent_memory(id: String) -> Result<FactMemoryState, String> {
    let dir = directory(&id)?;
    read_profile(&dir)?;
    crate::commands::load_fact_memory(&dir)
}

#[tauri::command]
pub async fn archive_persistent_agent_memory(
    state: State<'_, AgentManagerState>,
    id: String,
    fact_id: String,
) -> Result<(), String> {
    let dir = directory(&id)?;
    read_profile(&dir)?;
    if !fact_id.starts_with("fact_")
        || !fact_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("Invalid fact id".into());
    }
    state
        .0
        .run_memory_cli_at(&["archive".into(), fact_id], dir)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profiles_persist_and_reject_path_escape() {
        let root = std::env::temp_dir().join(format!("nova-profile-test-{}", uuid::Uuid::new_v4()));
        let id = uuid::Uuid::new_v4().to_string();
        let dir = directory_at(&root, &id).unwrap();
        assert!(directory_at(&root, "../../escape").is_err());
        let profile = PersistentAgent {
            id,
            name: "Reviewer".into(),
            description: "".into(),
            instructions: "Review".into(),
            tools: vec!["read".into()],
            skills: vec![],
            created_at: "now".into(),
            updated_at: "now".into(),
            runs: vec![],
        };
        write_profile(&dir, &profile).unwrap();
        std::fs::write(dir.join("AGENTS.md"), "Review carefully").unwrap();
        let loaded = read_profile(&dir).unwrap();
        assert_eq!(loaded.instructions, "Review carefully");
        assert_eq!(loaded.tools, vec!["read"]);
        assert!(directory_at(&root, &uuid::Uuid::new_v4().to_string()).unwrap() != dir);
        std::fs::remove_dir_all(root).unwrap();
    }
}
