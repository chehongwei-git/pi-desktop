//! 每轮以工作区实际内容为基线；不依赖 Git HEAD，不把工具调用差异相加。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

const FILE_LIMIT: u64 = 1024 * 1024;
const TOTAL_LIMIT: usize = 16 * 1024 * 1024;
const ENTRY_LIMIT: usize = 10_000;
const EXCLUDED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".desktop-process",
    ".desktop-changes",
    ".idea",
    ".pi",
];

#[derive(Default)]
struct Snapshot {
    files: BTreeMap<String, Vec<u8>>,
    omitted: BTreeSet<String>,
    warnings: Vec<String>,
}
fn snapshot(root: &Path) -> Snapshot {
    fn walk(
        root: &Path,
        dir: &Path,
        result: &mut Snapshot,
        bytes: &mut usize,
        entries: &mut usize,
    ) {
        let Ok(items) = std::fs::read_dir(dir) else {
            result
                .warnings
                .push("部分目录无法读取，结果可能不完整".into());
            return;
        };
        for item in items {
            *entries += 1;
            if *entries > ENTRY_LIMIT {
                result
                    .warnings
                    .push("工作区超过一万个条目，结果可能不完整".into());
                return;
            }
            let Ok(item) = item else {
                result.warnings.push("部分条目无法读取".into());
                continue;
            };
            let path = item.path();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let Ok(kind) = item.file_type() else {
                result.omitted.insert(relative);
                continue;
            };
            // 不跟随符号链接，避免越过工作区或递归环。
            if kind.is_symlink() {
                result.omitted.insert(relative);
                continue;
            }
            if kind.is_dir() {
                if !EXCLUDED.contains(&item.file_name().to_string_lossy().as_ref()) {
                    walk(root, &path, result, bytes, entries);
                }
            } else if kind.is_file() {
                let size = item.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
                if size > FILE_LIMIT || *bytes + size as usize > TOTAL_LIMIT {
                    result.omitted.insert(relative);
                    continue;
                }
                // take 限制实际读取，文件在 metadata 后增长也不能突破预算。
                use std::io::Read;
                let data = std::fs::File::open(&path).and_then(|file| {
                    let mut data = Vec::new();
                    file.take(FILE_LIMIT + 1).read_to_end(&mut data)?;
                    Ok(data)
                });
                match data {
                    Ok(data) if data.len() <= FILE_LIMIT as usize => {
                        *bytes += data.len();
                        result.files.insert(relative, data);
                    }
                    _ => {
                        result.omitted.insert(relative);
                    }
                }
            }
        }
    }
    let mut result = Snapshot::default();
    walk(root, root, &mut result, &mut 0, &mut 0);
    result
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: String,
    pub added: Option<usize>,
    pub removed: Option<usize>,
    pub diff: String,
    pub binary: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub title: String,
    pub state: String,
    pub files: Vec<FileChange>,
    pub warnings: Vec<String>,
}
/// 使用有界 LCS 保留未修改行；大范围重写退化为完整替换，保证差异准确且计算有界。
fn diff(before: &str, after: &str) -> (String, usize, usize) {
    let a: Vec<_> = before.split_inclusive('\n').collect();
    let b: Vec<_> = after.split_inclusive('\n').collect();
    let mut rows = Vec::new();
    let mut added = 0;
    let mut removed = 0;
    let mut emit = |sign: char, line: &str, index: usize| {
        rows.push(format!(
            "{sign}{index} {}",
            line.trim_end_matches('\n').trim_end_matches('\r')
        ));
        if !line.ends_with('\n') {
            rows.push("\\ No newline at end of file".into());
        }
        if sign == '+' {
            added += 1;
        }
        if sign == '-' {
            removed += 1;
        }
    };
    if a.len().saturating_mul(b.len()) <= 1_000_000 {
        let width = b.len() + 1;
        let mut table = vec![0u32; (a.len() + 1) * width];
        for i in (0..a.len()).rev() {
            for j in (0..b.len()).rev() {
                table[i * width + j] = if a[i] == b[j] {
                    1 + table[(i + 1) * width + j + 1]
                } else {
                    table[(i + 1) * width + j].max(table[i * width + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < a.len() || j < b.len() {
            if i < a.len() && j < b.len() && a[i] == b[j] {
                emit(' ', a[i], i + 1);
                i += 1;
                j += 1;
            } else if i < a.len()
                && (j == b.len() || table[(i + 1) * width + j] >= table[i * width + j + 1])
            {
                emit('-', a[i], i + 1);
                i += 1;
            } else {
                emit('+', b[j], j + 1);
                j += 1;
            }
        }
    } else {
        for (i, line) in a.iter().enumerate() {
            emit('-', line, i + 1);
        }
        for (i, line) in b.iter().enumerate() {
            emit('+', line, i + 1);
        }
    }
    (rows.join("\n"), added, removed)
}
fn compare(before: Snapshot, after: Snapshot, title: String, state: String) -> Turn {
    let incomplete_scan = !before.warnings.is_empty() || !after.warnings.is_empty();
    let mut warnings = before.warnings;
    warnings.extend(after.warnings);
    warnings.push("仅比较工作区内文件；排除版本库、依赖、构建和桌面元数据目录，不跟随符号链接。并发任务或外部编辑可能包含在结果中。".into());
    if !before.omitted.is_empty() || !after.omitted.is_empty() {
        warnings
            .push("部分文件因不可读、超过单文件 1 MiB 或总计 16 MiB 的采集预算而未比较。".into());
    }
    let paths: BTreeSet<_> = before
        .files
        .keys()
        .chain(after.files.keys())
        .cloned()
        .collect();
    let mut files = Vec::new();
    for path in paths {
        if before.omitted.contains(&path) || after.omitted.contains(&path) {
            continue;
        }
        // 扫描整体失败时不能把缺失条目误报为新增或删除。
        if incomplete_scan
            && (!before.files.contains_key(&path) || !after.files.contains_key(&path))
        {
            continue;
        }
        let a = before.files.get(&path);
        let b = after.files.get(&path);
        if a == b {
            continue;
        }
        let kind = if a.is_none() {
            "added"
        } else if b.is_none() {
            "deleted"
        } else {
            "modified"
        };
        let a = a.map(Vec::as_slice).unwrap_or_default();
        let b = b.map(Vec::as_slice).unwrap_or_default();
        let binary = a.contains(&0)
            || b.contains(&0)
            || std::str::from_utf8(a).is_err()
            || std::str::from_utf8(b).is_err();
        let (text, added, removed) = if binary {
            (
                "二进制文件内容已变化，无法显示文本差异。".into(),
                None,
                None,
            )
        } else {
            let (text, added, removed) = diff(
                std::str::from_utf8(a).unwrap(),
                std::str::from_utf8(b).unwrap(),
            );
            (text, Some(added), Some(removed))
        };
        files.push(FileChange {
            path,
            kind: kind.into(),
            added,
            removed,
            diff: text,
            binary,
        });
    }
    Turn {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        state,
        files,
        warnings,
    }
}
/// 每个运行时独立持有基线；磁盘记录按真实会话身份隔离，最多保留最近十轮。
pub struct Recorder {
    root: PathBuf,
    directory: PathBuf,
    session: String,
    baseline: Option<(Snapshot, String)>,
}
impl Recorder {
    pub fn new(root: PathBuf, directory: PathBuf) -> Self {
        Self {
            root,
            directory,
            session: String::new(),
            baseline: None,
        }
    }
    pub fn context(&mut self, data: &serde_json::Value) {
        if let Some(root) = data["cwd"].as_str() {
            self.root = root.into();
        }
        if let Some(session) = data["sessionFile"].as_str() {
            self.session = session.into();
        }
    }
    fn path(&self) -> PathBuf {
        self.directory.join(format!(
            "{:x}.json",
            Sha256::digest(self.session.as_bytes())
        ))
    }
    pub fn cancel(&mut self) {
        self.baseline = None;
    }
    pub fn begin(&mut self, title: &str) {
        if self.baseline.is_none() {
            self.baseline = Some((snapshot(&self.root), title.chars().take(80).collect()));
        }
    }
    pub fn list(&self) -> Vec<Turn> {
        if self.session.is_empty() {
            return Vec::new();
        }
        let path = self.path();
        if std::fs::metadata(&path)
            .map(|meta| meta.len() > 64 * 1024 * 1024)
            .unwrap_or(true)
        {
            return Vec::new();
        }
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }
    pub fn finish(&mut self, state: &str) -> std::io::Result<()> {
        let Some((before, title)) = self.baseline.take() else {
            return Ok(());
        };
        let turn = compare(before, snapshot(&self.root), title, state.into());
        if self.session.is_empty() {
            return Err(std::io::Error::other("缺少会话身份，未保存轮次变更"));
        }
        let mut turns = self.list();
        turns.insert(0, turn);
        turns.truncate(10);
        while serde_json::to_vec(&turns)?.len() > 64 * 1024 * 1024 && turns.len() > 1 {
            turns.pop();
        }
        std::fs::create_dir_all(&self.directory)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer(&mut file, &turns)?;
        file.persist(self.path()).map_err(|error| error.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compares_final_content_and_preserves_original_local_edits() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.ts"), "local\nold\n").unwrap();
        let before = snapshot(root.path());
        std::fs::write(root.path().join("a.ts"), "local\nintermediate\n").unwrap();
        std::fs::write(root.path().join("a.ts"), "local\nnew\n").unwrap();
        std::fs::write(root.path().join("new.ts"), "created\n").unwrap();
        let turn = compare(before, snapshot(root.path()), "test".into(), "done".into());
        assert_eq!(turn.files.len(), 2);
        assert_eq!(turn.files[0].added, Some(1));
        assert_eq!(turn.files[0].removed, Some(1));
        assert!(turn.files[0].diff.contains(" local") || turn.files[0].diff.contains("1 local"));
        assert!(!turn.files[0].diff.contains("intermediate"));
        assert_eq!(turn.files[1].kind, "added");
    }
    #[test]
    fn deletion_revert_binary_and_restart() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("deleted"), "old").unwrap();
        std::fs::write(root.path().join("same"), "unchanged").unwrap();
        let mut recorder = Recorder::new(root.path().into(), storage.path().into());
        recorder.context(&serde_json::json!({"sessionFile":"session-a"}));
        recorder.begin("prompt");
        std::fs::remove_file(root.path().join("deleted")).unwrap();
        std::fs::write(root.path().join("binary"), [0, 1, 2]).unwrap();
        recorder.finish("stopped").unwrap();
        let mut restored = Recorder::new(root.path().into(), storage.path().into());
        restored.context(&serde_json::json!({"sessionFile":"session-a"}));
        let turns = restored.list();
        assert_eq!(turns[0].state, "stopped");
        assert_eq!(turns[0].files.len(), 2);
        assert!(turns[0].files[0].binary);
        assert_eq!(turns[0].files[1].kind, "deleted");
        restored.context(&serde_json::json!({"sessionFile":"session-b"}));
        assert!(restored.list().is_empty());
    }
}
