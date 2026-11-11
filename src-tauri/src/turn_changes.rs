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
    omitted: BTreeMap<String, String>,
    unknown_dirs: BTreeSet<String>,
    warnings: Vec<String>,
}
impl Snapshot {
    /// 未观测到不等于不存在；目录未知时必须连同后代一起排除。
    fn unknown(&self, path: &str) -> bool {
        self.omitted.contains_key(path)
            || self.unknown_dirs.contains("")
            || self.unknown_dirs.contains(path)
            || path
                .match_indices('/')
                .any(|(index, _)| self.unknown_dirs.contains(&path[..index]))
    }
}
fn snapshot(root: &Path) -> Snapshot {
    snapshot_with_limits(root, TOTAL_LIMIT, ENTRY_LIMIT)
}
fn snapshot_with_limits(root: &Path, total_limit: usize, entry_limit: usize) -> Snapshot {
    fn walk(
        root: &Path,
        dir: &Path,
        result: &mut Snapshot,
        bytes: &mut usize,
        entries: &mut usize,
        total_limit: usize,
        entry_limit: usize,
    ) {
        let relative_dir = dir
            .strip_prefix(root)
            .unwrap_or(dir)
            .to_string_lossy()
            .replace('\\', "/");
        let Ok(items) = std::fs::read_dir(dir) else {
            result.unknown_dirs.insert(relative_dir);
            result
                .warnings
                .push("部分目录无法读取，结果可能不完整".into());
            return;
        };
        // 先按名称排序；收集本身也受条目预算约束，不能为了排序无限读取目录。
        let mut sorted = Vec::new();
        for item in items {
            if *entries >= entry_limit {
                result.unknown_dirs.insert(relative_dir.clone());
                result
                    .warnings
                    .push("工作区超过条目预算，结果可能不完整".into());
                break;
            }
            *entries += 1;
            match item {
                Ok(item) => sorted.push(item),
                Err(_) => {
                    result.unknown_dirs.insert(relative_dir.clone());
                    result
                        .warnings
                        .push("部分目录条目无法读取，结果可能不完整".into());
                }
            }
        }
        sorted.sort_by_key(|item| item.file_name());
        for item in sorted {
            let path = item.path();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let Ok(kind) = item.file_type() else {
                result.unknown_dirs.insert(relative.clone());
                result.omitted.insert(relative, "类型无法读取".into());
                continue;
            };
            if kind.is_symlink() {
                result.unknown_dirs.insert(relative.clone());
                result.omitted.insert(relative, "符号链接未比较".into());
                continue;
            }
            if kind.is_dir() {
                if !EXCLUDED.contains(&item.file_name().to_string_lossy().as_ref()) {
                    walk(
                        root,
                        &path,
                        result,
                        bytes,
                        entries,
                        total_limit,
                        entry_limit,
                    );
                }
            } else if kind.is_file() {
                use std::io::Read;
                let Ok(mut file) = std::fs::File::open(&path) else {
                    result.omitted.insert(relative, "文件无法读取".into());
                    continue;
                };
                let Ok(before) = file.metadata() else {
                    result.omitted.insert(relative, "属性无法读取".into());
                    continue;
                };
                if before.len() > FILE_LIMIT {
                    result.omitted.insert(relative, "超过单文件 1 MiB".into());
                    continue;
                }
                let remaining = total_limit.saturating_sub(*bytes).min(FILE_LIMIT as usize);
                if before.len() as usize > remaining {
                    result.omitted.insert(relative, "超过总内容预算".into());
                    continue;
                }
                let mut data = Vec::new();
                let read = (&mut file)
                    .take(remaining as u64 + 1)
                    .read_to_end(&mut data);
                let stable = file.metadata().is_ok_and(|after| {
                    before.len() == after.len()
                        && before.modified().ok() == after.modified().ok()
                        && after.len() == data.len() as u64
                });
                // 文件在读取过程中变化时，不把混合内容当作权威快照。
                if read.is_ok() && stable && data.len() <= remaining {
                    *bytes += data.len();
                    result.files.insert(relative, data);
                } else {
                    result
                        .omitted
                        .insert(relative, "读取失败、超限或读取期间变化".into());
                }
            } else {
                result.omitted.insert(relative, "非普通文件未比较".into());
            }
        }
    }
    let mut result = Snapshot::default();
    walk(
        root,
        root,
        &mut result,
        &mut 0,
        &mut 0,
        total_limit,
        entry_limit,
    );
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
    /// 仅文本差异有精度；替换视图的增删计数必须为空。
    #[serde(default)]
    pub diff_accuracy: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub title: String,
    pub state: String,
    pub files: Vec<FileChange>,
    pub warnings: Vec<String>,
    /// 缺失表示旧版采集，不能据此声称历史覆盖范围已被重新验证。
    #[serde(default)]
    pub capture_version: Option<u8>,
}
/// Myers 只按编辑距离扩展前沿；预算按操作数与轨迹内存计算，结果不依赖机器速度。
fn edit_script(
    a: &[&str],
    b: &[&str],
    work_limit: usize,
    memory_limit: usize,
) -> Option<Vec<char>> {
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut work = 0usize;
    let mut memory = (a.len() + b.len()).checked_mul(std::mem::size_of::<char>())?;
    // 纯新增/删除无需搜索编辑路径，避免大段插入也耗尽 Myers 的轨迹预算。
    if a.is_empty() || b.is_empty() {
        return (memory <= memory_limit && a.len() + b.len() <= work_limit)
            .then(|| vec![if a.is_empty() { '+' } else { '-' }; a.len() + b.len()]);
    }
    for d in 0..=a.len() + b.len() {
        memory = memory.checked_add(
            (d + 1) * std::mem::size_of::<isize>() + std::mem::size_of::<Vec<isize>>(),
        )?;
        if memory > memory_limit {
            return None;
        }
        let mut layer = Vec::with_capacity(d + 1);
        for index in 0..=d {
            work += 1;
            if work > work_limit {
                return None;
            }
            let k = 2 * index as isize - d as isize;
            let mut x = if d == 0 {
                0
            } else {
                let previous = &trace[d - 1];
                if index == 0 {
                    previous[0]
                } else if index == d {
                    previous[index - 1] + 1
                } else {
                    previous[index].max(previous[index - 1] + 1)
                }
            };
            let mut y = x - k;
            while x < a.len() as isize && y < b.len() as isize {
                work += 1;
                if work > work_limit {
                    return None;
                }
                if a[x as usize] != b[y as usize] {
                    break;
                }
                x += 1;
                y += 1;
            }
            layer.push(x);
            if x == a.len() as isize && y == b.len() as isize {
                let mut script = Vec::with_capacity(a.len() + b.len());
                for depth in (1..=d).rev() {
                    let index = ((x - y + depth as isize) / 2) as usize;
                    let previous = &trace[depth - 1];
                    let insert =
                        index == 0 || (index < depth && previous[index - 1] < previous[index]);
                    let px = if insert {
                        previous[index]
                    } else {
                        previous[index - 1]
                    };
                    let py = px - (x - y + if insert { 1 } else { -1 });
                    while x > px && y > py {
                        script.push(' ');
                        x -= 1;
                        y -= 1;
                    }
                    if insert {
                        script.push('+');
                        y -= 1;
                    } else {
                        script.push('-');
                        x -= 1;
                    }
                }
                while x > 0 && y > 0 {
                    script.push(' ');
                    x -= 1;
                    y -= 1;
                }
                script.reverse();
                return Some(script);
            }
        }
        trace.push(layer);
    }
    None
}
/// 大范围重写仍可查看替换视图，但不把预算退化后的替换规模当成精确统计。
fn diff(before: &str, after: &str) -> (String, Option<usize>, Option<usize>) {
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
    // 先剥离公共首尾：长文件中的局部修改不应因总行数触发整文件替换。
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    for (i, line) in a[..prefix].iter().enumerate() {
        emit(' ', line, i + 1);
    }
    let original_a = &a;
    let original_b = &b;
    let a = &original_a[prefix..original_a.len() - suffix];
    let b = &original_b[prefix..original_b.len() - suffix];
    let script = edit_script(a, b, 4_000_000, 16 * 1024 * 1024);
    let fallback = script.is_none();
    if let Some(script) = script {
        let (mut i, mut j) = (0, 0);
        for sign in script {
            match sign {
                ' ' => {
                    emit(' ', b[j], prefix + j + 1);
                    i += 1;
                    j += 1;
                }
                '-' => {
                    emit('-', a[i], prefix + i + 1);
                    i += 1;
                }
                '+' => {
                    emit('+', b[j], prefix + j + 1);
                    j += 1;
                }
                _ => unreachable!(),
            }
        }
    } else {
        for (i, line) in a.iter().enumerate() {
            emit('-', line, prefix + i + 1);
        }
        for (i, line) in b.iter().enumerate() {
            emit('+', line, prefix + i + 1);
        }
    }
    for (i, line) in original_b[original_b.len() - suffix..].iter().enumerate() {
        emit(' ', line, original_b.len() - suffix + i + 1);
    }
    if fallback {
        rows.insert(
            0,
            "! 完整替换：差异超过精确比较预算，以下为替换视图，无法精确统计增删行数。".into(),
        );
    }
    (
        rows.join("\n"),
        (!fallback).then_some(added),
        (!fallback).then_some(removed),
    )
}
fn compare(before: Snapshot, after: Snapshot, title: String, state: String) -> Turn {
    let mut warnings = before.warnings.clone();
    warnings.extend(after.warnings.iter().cloned());
    let mut omitted = before.omitted.clone();
    omitted.extend(after.omitted.clone());
    let mut reasons = BTreeMap::<String, usize>::new();
    for reason in omitted.values() {
        *reasons.entry(reason.clone()).or_default() += 1;
    }
    for (reason, count) in reasons {
        warnings.push(format!("{count} 个路径未比较：{reason}。"));
    }
    let unknown_dirs: BTreeSet<_> = before.unknown_dirs.union(&after.unknown_dirs).collect();
    if !unknown_dirs.is_empty() {
        warnings.push(format!(
            "{} 个目录或路径覆盖不完整，未观测后代不推断为新增或删除。",
            unknown_dirs.len()
        ));
    }
    warnings.sort();
    warnings.dedup();
    warnings.push("仅比较工作区内文件；排除版本库、依赖、构建和桌面元数据目录，不跟随符号链接。并发任务或外部编辑可能包含在结果中。".into());
    let paths: BTreeSet<_> = before
        .files
        .keys()
        .chain(after.files.keys())
        .cloned()
        .collect();
    let mut files = Vec::new();
    for path in paths {
        // 已读取的两端仍可比较；只有缺失端需要用目录覆盖证明其确实不存在。
        if before.omitted.contains_key(&path)
            || after.omitted.contains_key(&path)
            || (!before.files.contains_key(&path) && before.unknown(&path))
            || (!after.files.contains_key(&path) && after.unknown(&path))
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
            (text, added, removed)
        };
        let diff_accuracy = (!binary).then(|| {
            if added.is_some() {
                "exact"
            } else {
                "replacement"
            }
            .into()
        });
        files.push(FileChange {
            path,
            kind: kind.into(),
            added,
            removed,
            diff: text,
            binary,
            diff_accuracy,
        });
    }
    Turn {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        state,
        files,
        warnings,
        capture_version: Some(2),
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
        let mut turns: Vec<Turn> = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        // 旧版替换计数无法恢复为精确值；只修正精度标记，不伪造历史快照。
        for turn in &mut turns {
            if turn.capture_version.is_none()
                && !turn.warnings.iter().any(|w| w.contains("旧版采集结果"))
            {
                turn.warnings
                    .push("旧版采集结果，文件覆盖范围与统计未经新版规则验证。".into());
            }
            for file in &mut turn.files {
                if file.diff.starts_with("! 完整替换") {
                    if turn.capture_version.is_none() {
                        let body = file
                            .diff
                            .split_once('\n')
                            .map(|(_, body)| body)
                            .unwrap_or("");
                        file.diff =
                            format!("! 完整替换：旧版替换视图，无法精确统计增删行数。\n{body}");
                    }
                    file.diff_accuracy = Some("replacement".into());
                    file.added = None;
                    file.removed = None;
                }
            }
        }
        turns
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
    fn large_local_edit_preserves_context_and_line_numbers() {
        let before = (0..5000).map(|i| format!("line {i}\n")).collect::<String>();
        let after = before.replace("line 2500\n", "changed\nextra\n");
        let (text, added, removed) = diff(&before, &after);
        assert_eq!((added, removed), (Some(2), Some(1)));
        assert!(text.contains("-2501 line 2500\n+2501 changed\n+2502 extra"));
        assert!(text.contains(" 5001 line 4999"));
        assert!(!text.contains("完整替换"));
    }
    #[test]
    fn bounded_fallback_is_explicit_and_preserves_edges() {
        let before = format!("head\n{}tail\n", "old\n".repeat(3000));
        let after = format!("head\n{}tail\n", "new\n".repeat(3000));
        let (text, added, removed) = diff(&before, &after);
        assert_eq!((added, removed), (None, None));
        assert!(text.starts_with("! 完整替换："));
        assert!(text.contains(" 1 head"));
        assert!(text.ends_with(" 3002 tail"));
        assert_eq!(
            diff("", "new"),
            (
                "+1 new\n\\ No newline at end of file".into(),
                Some(1),
                Some(0)
            )
        );
        assert_eq!(diff("old\r\n", ""), ("-1 old".into(), Some(0), Some(1)));
    }
    #[test]
    fn scattered_edits_are_exact_and_script_reconstructs_content() {
        let before = (0..5000).map(|i| format!("line {i}\n")).collect::<String>();
        let after = before
            .replace("line 2\n", "changed\n")
            .replace("line 4997\n", "also changed\n");
        let (text, added, removed) = diff(&before, &after);
        assert_eq!((added, removed), (Some(2), Some(2)));
        assert!(!text.contains("完整替换"));
        // 穷举短重复序列，以独立 LCS 校验最短编辑距离，同时验证能重建新内容。
        for n in 0..32usize {
            for m in 0..32usize {
                let av: Vec<_> = (0..5)
                    .map(|i| if n & (1 << i) == 0 { "a\n" } else { "b\r\n" })
                    .collect();
                let bv: Vec<_> = (0..5)
                    .map(|i| if m & (1 << i) == 0 { "a\n" } else { "b\r\n" })
                    .collect();
                let a = &av[..n % 6];
                let b = &bv[..m % 6];
                let script = edit_script(a, b, 10000, 10000).unwrap();
                let (mut i, mut j, mut edits) = (0, 0, 0);
                let mut rebuilt = Vec::new();
                for op in script {
                    match op {
                        ' ' => {
                            assert_eq!(a[i], b[j]);
                            rebuilt.push(a[i]);
                            i += 1;
                            j += 1;
                        }
                        '-' => {
                            i += 1;
                            edits += 1;
                        }
                        '+' => {
                            rebuilt.push(b[j]);
                            j += 1;
                            edits += 1;
                        }
                        _ => unreachable!(),
                    }
                }
                assert_eq!((i, j), (a.len(), b.len()));
                assert_eq!(rebuilt, b);
                let mut lcs = vec![vec![0; b.len() + 1]; a.len() + 1];
                for i in 0..a.len() {
                    for j in 0..b.len() {
                        lcs[i + 1][j + 1] = if a[i] == b[j] {
                            lcs[i][j] + 1
                        } else {
                            lcs[i][j + 1].max(lcs[i + 1][j])
                        };
                    }
                }
                assert_eq!(edits, a.len() + b.len() - 2 * lcs[a.len()][b.len()]);
            }
        }
        assert!(edit_script(&["a"], &["b"], 0, 1000).is_none());
        assert!(edit_script(&["a"], &["b"], 1000, 0).is_none());
        assert_eq!(diff("", ""), (String::new(), Some(0), Some(0)));
        let inserted = "new\n".repeat(5000);
        assert_eq!(
            (diff("", &inserted).1, diff("", &inserted).2),
            (Some(5000), Some(0))
        );
        assert_eq!(
            (diff(&inserted, "").1, diff(&inserted, "").2),
            (Some(0), Some(5000))
        );
        assert_eq!(
            (diff("a\r\n", "a\n").1, diff("a", "a\n").2),
            (Some(1), Some(1))
        );
    }
    #[test]
    fn budget_changes_never_become_false_additions_or_deletions() {
        let root = tempfile::tempdir().unwrap();
        // 创建顺序与名称顺序相反，两次仍必须优先采集 a。
        std::fs::write(root.path().join("z"), "zzzz").unwrap();
        std::fs::write(root.path().join("a"), "aaaa").unwrap();
        let before = snapshot_with_limits(root.path(), 4, 100);
        assert_eq!(before.files.keys().collect::<Vec<_>>(), vec!["a"]);
        std::fs::write(root.path().join("a"), "a").unwrap();
        let after = snapshot_with_limits(root.path(), 5, 100);
        let turn = compare(before, after, "budget".into(), "done".into());
        assert_eq!(turn.files.len(), 1);
        assert_eq!(turn.files[0].path, "a");
        assert!(turn.warnings.iter().any(|w| w.contains("1 个路径未比较")));
        let before = snapshot_with_limits(root.path(), 5, 100);
        std::fs::write(root.path().join("a"), "aaaa").unwrap();
        let after = snapshot_with_limits(root.path(), 4, 100);
        let turn = compare(before, after, "reverse budget".into(), "done".into());
        assert_eq!(turn.files.len(), 1);
        assert_eq!(turn.files[0].path, "a");
        let before = snapshot(root.path());
        let after = snapshot_with_limits(root.path(), 100, 0);
        assert!(compare(before, after, "entries".into(), "done".into())
            .files
            .is_empty());
        let before = snapshot(root.path());
        std::fs::write(root.path().join("a"), vec![b'a'; FILE_LIMIT as usize + 1]).unwrap();
        assert!(
            compare(before, snapshot(root.path()), "size".into(), "done".into())
                .files
                .is_empty()
        );
    }
    #[test]
    fn unknown_directory_only_suppresses_unproven_absence() {
        let mut before = Snapshot::default();
        before.files.insert("dir/old".into(), b"old".to_vec());
        before.files.insert("known".into(), b"before".to_vec());
        let mut after = Snapshot::default();
        after.unknown_dirs.insert("dir".into());
        after.omitted.insert("dir".into(), "符号链接未比较".into());
        assert!(after.unknown("dir/nested/old"));
        assert!(!after.unknown("dir2/old"));
        after.files.insert("known".into(), b"after".to_vec());
        after.files.insert("new".into(), b"new".to_vec());
        let turn = compare(before, after, "coverage".into(), "done".into());
        assert_eq!(
            turn.files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["known", "new"]
        );
        assert_eq!(turn.files[1].kind, "added");
        let root = tempfile::tempdir().unwrap();
        let missing = snapshot(&root.path().join("missing"));
        assert!(missing.unknown("anything/nested"));
    }
    #[test]
    fn successive_rounds_and_legacy_records_keep_their_own_content() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let mut recorder = Recorder::new(root.path().into(), storage.path().into());
        recorder.context(&serde_json::json!({"sessionFile":"rounds"}));
        recorder.begin("create");
        std::fs::write(root.path().join("a"), "one\n").unwrap();
        recorder.finish("done").unwrap();
        recorder.begin("modify");
        std::fs::write(root.path().join("a"), "temporary\n").unwrap();
        std::fs::write(root.path().join("a"), "two\nextra\n").unwrap();
        recorder.finish("done").unwrap();
        recorder.begin("delete");
        std::fs::remove_file(root.path().join("a")).unwrap();
        recorder.finish("done").unwrap();
        let turns = recorder.list();
        assert_eq!(
            turns
                .iter()
                .map(|t| t.files[0].kind.as_str())
                .collect::<Vec<_>>(),
            vec!["deleted", "modified", "added"]
        );
        assert_eq!(
            (turns[1].files[0].added, turns[1].files[0].removed),
            (Some(2), Some(1))
        );
        assert!(turns[1].files[0].diff.contains("-1 one"));
        assert!(!turns[1].files[0].diff.contains("temporary"));
        recorder.begin("revert");
        std::fs::write(root.path().join("a"), "temporary").unwrap();
        std::fs::remove_file(root.path().join("a")).unwrap();
        recorder.finish("done").unwrap();
        assert!(recorder.list()[0].files.is_empty());
        let mut legacy = serde_json::to_value(turns).unwrap();
        for turn in legacy.as_array_mut().unwrap() {
            turn.as_object_mut().unwrap().remove("captureVersion");
            for file in turn["files"].as_array_mut().unwrap() {
                file.as_object_mut().unwrap().remove("diffAccuracy");
            }
        }
        legacy[0]["files"][0]["diff"] = "! 完整替换：旧版\n-1 old\n+1 new".into();
        std::fs::write(recorder.path(), serde_json::to_vec(&legacy).unwrap()).unwrap();
        let restored = recorder.list();
        assert_eq!(restored[0].files[0].added, None);
        assert_eq!(
            restored[0].files[0].diff_accuracy.as_deref(),
            Some("replacement")
        );
        assert!(restored[0].files[0]
            .diff
            .contains("旧版替换视图，无法精确统计"));
        assert!(restored[0]
            .warnings
            .iter()
            .any(|w| w.contains("旧版采集结果")));
    }
    #[test]
    fn directory_replaced_by_symlink_does_not_report_deleted_children() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let dir = root.path().join("dir");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("old"), "old").unwrap();
        let before = snapshot(root.path());
        std::fs::remove_dir_all(&dir).unwrap();
        #[cfg(windows)]
        {
            // Windows 创建符号链接依赖开发者模式/权限；目录联接同样不能被扫描器跟随，且无需提权。
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&dir)
                .arg(target.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "创建目录联接失败：{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target.path(), &dir).unwrap();
        let after = snapshot(root.path());
        assert!(after.unknown("dir/old"));
        let turn = compare(before, after, "link".into(), "done".into());
        assert!(turn.files.is_empty());
        assert!(turn.warnings.iter().any(|w| w.contains("符号链接")));
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
