//! Git worktree isolation for parallel agents.
//!
//! Each agent that opts in gets its own checkout under `~/.nova/worktrees/`, so concurrent
//! agents never write to the same files and the user's working tree is never touched until
//! they explicitly accept the result. Merging is a squash merge guarded by a `merge-tree`
//! preflight: a conflict is reported, never resolved by force.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeState {
    Active,
    Merged,
    Rejected,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Absolute path of the isolated checkout that the agent uses as its cwd.
    pub path: String,
    /// Branch the work is recorded on, e.g. `nova/agent-1a2b3c4d`.
    pub branch: String,
    /// Repository root the worktree was created from.
    pub project_cwd: String,
    /// Commit the worktree branched off; every diff is measured against it.
    pub base_commit: String,
    #[serde(default)]
    pub base_branch: Option<String>,
    pub created_at: String,
    pub state: WorktreeState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeFileChange {
    pub path: String,
    /// One of: added, modified, deleted.
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub path: String,
    pub branch: String,
    pub base_branch: Option<String>,
    /// True when the worktree has uncommitted changes.
    pub dirty: bool,
    /// Number of commits the agent made on top of the base commit.
    pub commits: usize,
    pub files: Vec<WorktreeFileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub merged: bool,
    pub conflicts: Vec<String>,
    pub message: String,
}

struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

async fn run_git(dir: &str, args: &[&str]) -> Result<GitOutput, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
        .map_err(|error| format!("Failed to run git: {error}"))?;
    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

async fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = run_git(dir, args).await?;
    if !output.success {
        let detail = output.stderr.trim();
        return Err(if detail.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            detail.to_string()
        });
    }
    Ok(output.stdout)
}

fn nova_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Cannot resolve the home directory".to_string())
}

/// Stable, dependency-free hash so the per-project directory name survives restarts.
fn fnv1a_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn project_dir_name(project_cwd: &str) -> String {
    let name = Path::new(project_cwd)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("project");
    let slug: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let digest = fnv1a_hex(project_cwd);
    format!("{slug}-{}", &digest[..8])
}

pub fn default_base_dir() -> Result<PathBuf, String> {
    Ok(nova_home()?.join(".nova").join("worktrees"))
}

pub async fn is_git_repo(dir: &str) -> bool {
    match git(dir, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok(stdout) => stdout.trim() == "true",
        Err(_) => false,
    }
}

/// Resolve a possibly-nested project path to the repository root.
pub async fn repo_root(dir: &str) -> Result<String, String> {
    let stdout = git(dir, &["rev-parse", "--show-toplevel"]).await?;
    let root = stdout.trim();
    if root.is_empty() {
        return Err(format!("{dir} is not inside a git repository"));
    }
    Ok(root.to_string())
}

pub async fn verify_existing(info: &WorktreeInfo) -> bool {
    Path::new(&info.path).join(".git").exists()
}

fn parse_numstat(output: &str) -> Vec<WorktreeFileChange> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let additions = parts.next()?;
            let deletions = parts.next()?;
            let path = parts.next()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(WorktreeFileChange {
                path: path.to_string(),
                status: "modified".to_string(),
                additions: additions.parse::<u64>().unwrap_or(0),
                deletions: deletions.parse::<u64>().unwrap_or(0),
            })
        })
        .collect()
}

/// `merge-tree --write-tree --name-only` prints the written tree oid first, then one
/// conflicted path per line. `--no-messages` keeps informational lines out, but they are
/// filtered here too so older/newer git output cannot be mistaken for a path.
fn parse_conflict_paths(output: &str) -> Vec<String> {
    let mut lines = output.lines().filter(|line| !line.trim().is_empty());
    let mut paths: Vec<String> = Vec::new();
    if let Some(first) = lines.next() {
        let candidate = first.trim();
        let looks_like_oid =
            candidate.len() >= 40 && candidate.len() <= 64 && candidate.chars().all(|c| c.is_ascii_hexdigit());
        if !looks_like_oid {
            paths.push(candidate.to_string());
        }
    }
    for line in lines {
        let candidate = line.trim();
        if candidate.starts_with("CONFLICT")
            || candidate.starts_with("Auto-merging")
            || candidate.starts_with("error:")
        {
            continue;
        }
        paths.push(candidate.to_string());
    }
    paths
}

pub async fn status(info: &WorktreeInfo) -> Result<WorktreeStatus, String> {
    if !verify_existing(info).await {
        return Err(format!("Worktree is missing: {}", info.path));
    }
    let porcelain = git(&info.path, &["status", "--porcelain"]).await?;
    let dirty = !porcelain.trim().is_empty();
    let commits = git(&info.path, &["rev-list", "--count", &format!("{}..HEAD", info.base_commit)])
        .await
        .ok()
        .and_then(|stdout| stdout.trim().parse::<usize>().ok())
        .unwrap_or(0);

    let numstat = git(&info.path, &["diff", "--numstat", &info.base_commit])
        .await
        .unwrap_or_default();
    let mut files = parse_numstat(&numstat);

    // Untracked files never show up in `diff`, but the agent did create them.
    for line in porcelain.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("?? ") {
            let path = rest.trim().trim_matches('"').to_string();
            if !path.is_empty() && !files.iter().any(|file| file.path == path) {
                files.push(WorktreeFileChange {
                    path,
                    status: "added".to_string(),
                    additions: 0,
                    deletions: 0,
                });
            }
        }
    }

    Ok(WorktreeStatus {
        path: info.path.clone(),
        branch: info.branch.clone(),
        base_branch: info.base_branch.clone(),
        dirty,
        commits,
        files,
    })
}

/// Diff a single file against the base commit, including uncommitted work.
pub async fn file_diff(info: &WorktreeInfo, path: &str) -> Result<String, String> {
    if !verify_existing(info).await {
        return Err(format!("Worktree is missing: {}", info.path));
    }
    let tracked = git(&info.path, &["diff", &info.base_commit, "--", path]).await?;
    if !tracked.trim().is_empty() {
        return Ok(tracked);
    }
    // Untracked files: `--no-index` exits non-zero when the files differ, which is the
    // expected case here, so read stdout regardless of exit status.
    let untracked = run_git(&info.path, &["diff", "--no-index", "--", "/dev/null", path]).await?;
    Ok(untracked.stdout)
}

async fn commit_pending_work(info: &WorktreeInfo, label: &str) -> Result<(), String> {
    let porcelain = git(&info.path, &["status", "--porcelain"]).await?;
    if porcelain.trim().is_empty() {
        return Ok(());
    }
    git(&info.path, &["add", "-A"]).await?;
    let message = format!("nova: {label}");
    let commit = run_git(&info.path, &["commit", "-m", &message]).await?;
    if !commit.success {
        return Err(format!(
            "Failed to commit the agent's work before merging: {}",
            commit.stderr.trim()
        ));
    }
    Ok(())
}

/// Squash-merge the worktree branch into the project branch.
///
/// Refuses to touch a dirty project tree, and aborts on conflict so the user's files are
/// never partially overwritten. `merge --squash` records no MERGE_HEAD, so a failed merge is
/// rolled back with `reset --merge` rather than `merge --abort`.
pub async fn merge_back(info: &WorktreeInfo, label: &str) -> Result<MergeOutcome, String> {
    let project = info.project_cwd.as_str();
    if !verify_existing(info).await {
        return Err(format!("Worktree is missing: {}", info.path));
    }
    if !git(project, &["status", "--porcelain"]).await?.trim().is_empty() {
        return Err(
            "The project has uncommitted changes. Commit or stash them before accepting this agent's work."
                .to_string(),
        );
    }
    commit_pending_work(info, label).await?;

    let project_head = git(project, &["rev-parse", "HEAD"]).await?.trim().to_string();
    let preflight = run_git(
        project,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            &project_head,
            &info.branch,
        ],
    )
    .await?;
    if !preflight.success {
        let conflicts = parse_conflict_paths(&preflight.stdout);
        return Ok(MergeOutcome {
            merged: false,
            conflicts,
            message: "The project branch changed in the same files. Resolve the conflicts in the worktree and try again."
                .to_string(),
        });
    }

    let merge = run_git(project, &["merge", "--squash", &info.branch]).await?;
    if !merge.success {
        let _ = run_git(project, &["reset", "--merge"]).await;
        return Err(format!(
            "Merge failed and was rolled back: {}",
            merge.stderr.trim()
        ));
    }
    let commit = run_git(project, &["commit", "-m", &format!("nova: {label}")]).await?;
    if !commit.success {
        let _ = run_git(project, &["reset", "--merge"]).await;
        return Err(format!(
            "Commit failed and the merge was rolled back: {}",
            commit.stderr.trim()
        ));
    }

    let short = git(project, &["rev-parse", "--short", "HEAD"])
        .await
        .unwrap_or_default()
        .trim()
        .to_string();
    Ok(MergeOutcome {
        merged: true,
        conflicts: Vec::new(),
        message: format!("Merged into the project as {short}"),
    })
}

/// Remove the checkout and delete its branch. Used by both reject and post-merge cleanup.
pub async fn remove_worktree(info: &WorktreeInfo) -> Result<(), String> {
    let project = info.project_cwd.as_str();
    if Path::new(&info.path).exists() {
        let removed = run_git(project, &["worktree", "remove", "--force", &info.path]).await;
        let removed_ok = matches!(removed, Ok(output) if output.success);
        if !removed_ok {
            let _ = tokio::fs::remove_dir_all(&info.path).await;
        }
    }
    let _ = run_git(project, &["branch", "-D", &info.branch]).await;
    let _ = run_git(project, &["worktree", "prune"]).await;
    Ok(())
}

/// Index of agent id → worktree, kept in its own file so agent-record pruning cannot
/// silently drop a worktree and leak it.
pub struct WorktreeStore {
    index_path: PathBuf,
    base_dir: PathBuf,
    entries: Arc<RwLock<HashMap<String, WorktreeInfo>>>,
    lock: Mutex<()>,
}

impl WorktreeStore {
    pub fn new(index_path: PathBuf) -> Result<Self, String> {
        Ok(Self {
            index_path,
            base_dir: default_base_dir()?,
            entries: Arc::new(RwLock::new(HashMap::new())),
            lock: Mutex::new(()),
        })
    }

    #[cfg(test)]
    pub fn with_base_dir(index_path: PathBuf, base_dir: PathBuf) -> Self {
        Self {
            index_path,
            base_dir,
            entries: Arc::new(RwLock::new(HashMap::new())),
            lock: Mutex::new(()),
        }
    }

    pub async fn load(&self) -> Result<(), String> {
        if !self.index_path.exists() {
            return Ok(());
        }
        let raw = tokio::fs::read(&self.index_path)
            .await
            .map_err(|error| format!("Failed to read {}: {error}", self.index_path.display()))?;
        let parsed: HashMap<String, WorktreeInfo> = serde_json::from_slice(&raw)
            .map_err(|error| format!("Failed to parse {}: {error}", self.index_path.display()))?;
        *self.entries.write().await = parsed;
        Ok(())
    }

    pub async fn get(&self, agent_id: &str) -> Option<WorktreeInfo> {
        self.entries.read().await.get(agent_id).cloned()
    }

    pub async fn list(&self) -> Vec<(String, WorktreeInfo)> {
        self.entries
            .read()
            .await
            .iter()
            .map(|(id, info)| (id.clone(), info.clone()))
            .collect()
    }

    pub async fn put(&self, agent_id: &str, info: WorktreeInfo) -> Result<(), String> {
        self.entries.write().await.insert(agent_id.to_string(), info);
        self.save().await
    }

    pub async fn remove(&self, agent_id: &str) -> Result<(), String> {
        self.entries.write().await.remove(agent_id);
        self.save().await
    }

    async fn save(&self) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        if let Some(parent) = self.index_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let snapshot = self.entries.read().await.clone();
        let body = serde_json::to_vec_pretty(&snapshot)
            .map_err(|error| format!("Failed to serialize worktrees: {error}"))?;
        let temporary = self.index_path.with_extension("json.tmp");
        tokio::fs::write(&temporary, body)
            .await
            .map_err(|error| format!("Failed to write {}: {error}", temporary.display()))?;
        tokio::fs::rename(&temporary, &self.index_path)
            .await
            .map_err(|error| format!("Failed to replace {}: {error}", self.index_path.display()))?;
        Ok(())
    }

    /// Create an isolated checkout for `agent_id` and record it.
    pub async fn create(&self, project_cwd: &str, agent_id: &str) -> Result<WorktreeInfo, String> {
        if !is_git_repo(project_cwd).await {
            return Err(format!("{project_cwd} is not a git working tree"));
        }
        let root = repo_root(project_cwd).await?;
        let base_commit = git(&root, &["rev-parse", "HEAD"]).await?.trim().to_string();
        let base_branch = git(&root, &["symbolic-ref", "--short", "HEAD"])
            .await
            .ok()
            .map(|stdout| stdout.trim().to_string())
            .filter(|value| !value.is_empty());

        let branch = format!("nova/{agent_id}");
        let target = self
            .base_dir
            .join(project_dir_name(&root))
            .join(agent_id);
        if target.exists() {
            return Err(format!("Worktree directory already exists: {}", target.display()));
        }
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let path = target.to_string_lossy().to_string();
        git(&root, &["worktree", "add", "-b", &branch, &path, &base_commit]).await?;

        let info = WorktreeInfo {
            path,
            branch,
            project_cwd: root,
            base_commit,
            base_branch,
            created_at: Utc::now().to_rfc3339(),
            state: WorktreeState::Active,
        };
        self.put(agent_id, info.clone()).await?;
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRepo {
        dir: PathBuf,
    }

    impl TempRepo {
        async fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("nova-worktree-test-{}", uuid::Uuid::new_v4()));
            tokio::fs::create_dir_all(&dir).await.unwrap();
            let path = dir.to_string_lossy().to_string();
            git(&path, &["init", "--initial-branch=main"]).await.unwrap();
            git(&path, &["config", "user.email", "test@example.com"]).await.unwrap();
            git(&path, &["config", "user.name", "Test"]).await.unwrap();
            tokio::fs::write(dir.join("shared.txt"), "base\n").await.unwrap();
            git(&path, &["add", "-A"]).await.unwrap();
            git(&path, &["commit", "-m", "init"]).await.unwrap();
            Self { dir }
        }

        fn path(&self) -> String {
            self.dir.to_string_lossy().to_string()
        }

        async fn commit_file(&self, name: &str, contents: &str) {
            tokio::fs::write(self.dir.join(name), contents).await.unwrap();
            git(&self.path(), &["add", "-A"]).await.unwrap();
            git(&self.path(), &["commit", "-m", &format!("update {name}")])
                .await
                .unwrap();
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    struct StoreFixture {
        store: WorktreeStore,
        base_dir: PathBuf,
    }

    impl StoreFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("nova-worktree-store-{}", uuid::Uuid::new_v4()));
            let base_dir = root.join("checkouts");
            let store = WorktreeStore::with_base_dir(root.join("worktrees.json"), base_dir.clone());
            Self { store, base_dir }
        }
    }

    impl Drop for StoreFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.base_dir.parent().unwrap());
        }
    }

    #[tokio::test]
    async fn accepts_agent_work_as_a_single_squashed_commit() {
        let repo = TempRepo::new().await;
        let fixture = StoreFixture::new();

        let info = fixture.store.create(&repo.path(), "agent-aaa").await.unwrap();
        assert_eq!(info.branch, "nova/agent-aaa");
        assert!(info.base_branch.as_deref() == Some("main"));

        tokio::fs::write(Path::new(&info.path).join("agent.txt"), "from agent\n")
            .await
            .unwrap();
        let status = status(&info).await.unwrap();
        assert!(status.dirty);
        assert!(status.files.iter().any(|file| file.path == "agent.txt"));

        let outcome = merge_back(&info, "agent-aaa").await.unwrap();
        assert!(outcome.merged, "expected a clean merge, got {outcome:?}");

        // The project now has the agent's file and exactly one extra commit.
        assert!(repo.dir.join("agent.txt").exists());
        let log = git(&repo.path(), &["rev-list", "--count", "HEAD"]).await.unwrap();
        assert_eq!(log.trim(), "2");
        assert!(git(&repo.path(), &["status", "--porcelain"]).await.unwrap().trim().is_empty());

        remove_worktree(&info).await.unwrap();
        assert!(!Path::new(&info.path).exists());
        assert!(!is_git_repo(&info.path).await);
    }

    #[tokio::test]
    async fn refuses_to_merge_into_a_dirty_project() {
        let repo = TempRepo::new().await;
        let fixture = StoreFixture::new();
        let info = fixture.store.create(&repo.path(), "agent-bbb").await.unwrap();

        tokio::fs::write(Path::new(&info.path).join("agent.txt"), "agent\n")
            .await
            .unwrap();
        tokio::fs::write(repo.dir.join("shared.txt"), "user work in progress\n")
            .await
            .unwrap();

        let error = merge_back(&info, "agent-bbb").await.unwrap_err();
        assert!(error.contains("uncommitted changes"), "unexpected error: {error}");

        // The user's file is untouched and no commit was created.
        let contents = tokio::fs::read_to_string(repo.dir.join("shared.txt")).await.unwrap();
        assert_eq!(contents, "user work in progress\n");
        let log = git(&repo.path(), &["rev-list", "--count", "HEAD"]).await.unwrap();
        assert_eq!(log.trim(), "1");
    }

    #[tokio::test]
    async fn reports_conflicts_without_touching_the_project() {
        let repo = TempRepo::new().await;
        let fixture = StoreFixture::new();
        let info = fixture.store.create(&repo.path(), "agent-ccc").await.unwrap();

        // Both sides edit the same line.
        tokio::fs::write(Path::new(&info.path).join("shared.txt"), "agent version\n")
            .await
            .unwrap();
        git(&info.path, &["add", "-A"]).await.unwrap();
        git(&info.path, &["commit", "-m", "agent edit"]).await.unwrap();
        repo.commit_file("shared.txt", "project version\n").await;

        let outcome = merge_back(&info, "agent-ccc").await.unwrap();
        assert!(!outcome.merged);
        assert_eq!(outcome.conflicts, vec!["shared.txt".to_string()]);

        // Project keeps its own content, is still clean, and the worktree survives for retry.
        let contents = tokio::fs::read_to_string(repo.dir.join("shared.txt")).await.unwrap();
        assert_eq!(contents, "project version\n");
        assert!(git(&repo.path(), &["status", "--porcelain"]).await.unwrap().trim().is_empty());
        assert!(verify_existing(&info).await);
    }

    #[tokio::test]
    async fn rejects_work_by_removing_the_checkout_and_branch() {
        let repo = TempRepo::new().await;
        let fixture = StoreFixture::new();
        let info = fixture.store.create(&repo.path(), "agent-ddd").await.unwrap();

        tokio::fs::write(Path::new(&info.path).join("agent.txt"), "discard me\n")
            .await
            .unwrap();
        remove_worktree(&info).await.unwrap();

        assert!(!Path::new(&info.path).exists());
        assert!(!repo.dir.join("agent.txt").exists());
        let branches = git(&repo.path(), &["branch", "--list", "nova/agent-ddd"]).await.unwrap();
        assert!(branches.trim().is_empty());
    }

    #[tokio::test]
    async fn persists_and_reloads_the_index() {
        let repo = TempRepo::new().await;
        let fixture = StoreFixture::new();
        let info = fixture.store.create(&repo.path(), "agent-eee").await.unwrap();
        let index_path = fixture.store.index_path.clone();

        let reloaded = WorktreeStore::with_base_dir(
            index_path,
            fixture.base_dir.clone(),
        );
        reloaded.load().await.unwrap();
        let stored = reloaded.get("agent-eee").await.unwrap();
        assert_eq!(stored.branch, info.branch);
        assert_eq!(stored.path, info.path);
    }

    #[test]
    fn derives_stable_per_project_directories() {
        let first = project_dir_name("/Users/me/code/nova-agent");
        let second = project_dir_name("/Users/me/code/nova-agent");
        assert_eq!(first, second);
        assert!(first.starts_with("nova-agent-"));
        assert_ne!(first, project_dir_name("/Users/me/code/other-repo"));
    }
}
