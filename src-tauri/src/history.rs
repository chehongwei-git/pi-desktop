//! 历史只读 Repository：逐行解析元数据；Pi 是原始 JSONL 的唯一写入方。
use crate::types::{Result, SessionSummary, Settings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Seek},
    path::PathBuf,
    time::UNIX_EPOCH,
};

/// 每文件缓存读取位置，追加读取不重扫正文；mtime/大小变化后必要时重建。
#[derive(Serialize, Deserialize)]
struct Cached {
    size: u64,
    modified: u64,
    offset: u64,
    summary: SessionSummary,
}
#[derive(Default)]
pub struct Catalog {
    cache: HashMap<PathBuf, Cached>,
    persistent: Option<PathBuf>,
}

/// 配置与环境优先级与 Pi CLI 对齐；自定义 sessionDir 不再附加项目编码目录。
pub fn root(settings: &Settings) -> PathBuf {
    if !settings.session_dir.is_empty() {
        return PathBuf::from(&settings.session_dir);
    }
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR") {
        return dir.into();
    }
    let agent = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(
                std::env::var_os("USERPROFILE")
                    .or_else(|| std::env::var_os("HOME"))
                    .unwrap_or_default(),
            )
            .join(".pi/agent")
        });
    agent.join("sessions")
}

/// 项目路径比较使用规范化路径，Windows 大小写不敏感，避免目录编码碰撞。
pub fn same_project(a: &str, b: &str) -> bool {
    let normalize = |value: &str| {
        let path = fs::canonicalize(value).unwrap_or_else(|_| PathBuf::from(value));
        let text = path
            .to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("//?/")
            .trim_end_matches('/')
            .to_string();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    normalize(a) == normalize(b)
}
impl Catalog {
    /// 磁盘仅缓存摘要和已消费位置；损坏缓存直接丢弃，不影响 Pi 原始文件。
    pub fn load(config_dir: &std::path::Path) -> Self {
        let persistent = config_dir.join("history-index-v1.json");
        let cache = fs::read(&persistent)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            cache,
            persistent: Some(persistent),
        }
    }
    /// 原子替换可重建索引；失败只记录错误类别，绝不阻断会话浏览。
    fn persist(&self) {
        if let Some(path) = &self.persistent {
            let result = (|| -> Result<()> {
                use std::io::Write;
                let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
                serde_json::to_writer(&mut temp, &self.cache)
                    .map_err(|_| crate::types::AppError::new("INDEX", "索引编码失败"))?;
                temp.flush()?;
                temp.persist(path).map_err(|e| e.error)?;
                Ok(())
            })();
            if result.is_err() {
                tracing::warn!(code = "INDEX_WRITE", "history index not persisted");
            }
        }
    }
    /// 仅遍历会话根及一层项目目录；损坏文件逐项降级，不阻断其他项目。
    pub fn list(
        &mut self,
        settings: &Settings,
        project: &str,
        search: &str,
    ) -> Result<Vec<SessionSummary>> {
        let base = root(settings);
        if !base.exists() {
            return Ok(vec![]);
        }
        let mut files = vec![];
        for item in fs::read_dir(base)? {
            let path = item?.path();
            if path.is_dir() {
                for item in fs::read_dir(&path)?.flatten() {
                    if item.path().extension().is_some_and(|x| x == "jsonl") {
                        files.push(item.path());
                    }
                }
            } else if path.extension().is_some_and(|x| x == "jsonl") {
                files.push(path);
            }
        }
        let previous_count = self.cache.len();
        self.cache.retain(|path, _| files.contains(path));
        let mut changed = previous_count != self.cache.len();
        let mut results = vec![];
        for file in files {
            let meta = match fs::metadata(&file) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let prior = self.cache.remove(&file);
            let mut cached = match prior {
                Some(c) if c.size == meta.len() && c.modified == modified => {
                    self.cache.insert(file.clone(), c);
                    let summary = &self.cache[&file].summary;
                    if same_project(&summary.cwd, project) && !summary.preview.is_empty() {
                        results.push(summary.clone());
                    }
                    continue;
                }
                Some(c) if meta.len() > c.size => c,
                _ => Cached {
                    size: 0,
                    modified: 0,
                    offset: 0,
                    summary: SessionSummary {
                        path: file.to_string_lossy().into(),
                        id: String::new(),
                        cwd: String::new(),
                        name: String::new(),
                        preview: String::new(),
                        timestamp: String::new(),
                        modified,
                        warning: None,
                    },
                },
            };
            changed = true;
            let input = match fs::File::open(&file) {
                Ok(file) => file,
                Err(_) => continue,
            };
            let mut reader = BufReader::new(input);
            reader.seek(std::io::SeekFrom::Start(cached.offset))?;
            loop {
                let mut line = String::new();
                let count = match reader.read_line(&mut line) {
                    Ok(count) => count,
                    Err(_) => {
                        cached.summary.warning =
                            Some("历史文件无法解码，恢复结果由 Pi 决定".into());
                        break;
                    }
                };
                if count == 0 || !line.ends_with('\n') {
                    break;
                } // 未完成尾行留到下次，不缓存半条记录。
                cached.offset += count as u64;
                let entry: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => {
                        cached.summary.warning = Some("历史包含损坏行，恢复结果由 Pi 决定".into());
                        continue;
                    }
                };
                match entry["type"].as_str().unwrap_or("") {
                    "session" => {
                        cached.summary.id = entry["id"].as_str().unwrap_or("").into();
                        cached.summary.cwd = entry["cwd"].as_str().unwrap_or("").into();
                        cached.summary.timestamp = entry["timestamp"].as_str().unwrap_or("").into();
                        if entry["version"].as_u64().unwrap_or(1) > 3 {
                            cached.summary.warning = Some("未经验证的会话版本".into());
                        }
                    }
                    "session_info" => {
                        cached.summary.name = entry["name"].as_str().unwrap_or("").into()
                    }
                    "message"
                        if entry["message"]["role"] == "user"
                            && cached.summary.preview.is_empty() =>
                    {
                        cached.summary.preview = text_content(&entry["message"]["content"])
                            .chars()
                            .take(100)
                            .collect();
                    }
                    _ => {}
                }
            }
            cached.size = meta.len();
            cached.modified = modified;
            cached.summary.modified = modified;
            if same_project(&cached.summary.cwd, project) && !cached.summary.preview.is_empty() {
                results.push(cached.summary.clone());
            }
            self.cache.insert(file, cached);
        }
        if changed {
            self.persist();
        }
        let search = search.to_lowercase();
        results.retain(|s| {
            search.is_empty()
                || format!("{} {}", s.name, s.preview)
                    .to_lowercase()
                    .contains(&search)
        });
        results.sort_by_key(|s| std::cmp::Reverse(s.modified));
        Ok(results)
    }
}

/// 提取标准文本块；图片/未知块不解码、不进入历史摘要。
pub fn text_content(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.into();
    }
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// 仅沿 leafId 的父链恢复原始展示；context_edit 不覆盖原始消息。
pub fn active_branch(entries: &[Value], leaf: Option<&str>) -> Vec<Value> {
    let map: HashMap<&str, &Value> = entries
        .iter()
        .filter_map(|e| e["id"].as_str().map(|id| (id, e)))
        .collect();
    let mut branch = vec![];
    let mut current = leaf;
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id) {
            break;
        }
        let Some(entry) = map.get(id) else {
            break;
        };
        branch.push((*entry).clone());
        current = entry["parentId"].as_str();
    }
    branch.reverse();
    branch
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    /// 废弃分支不展示，后续 context_edit 也不篡改原始对话。
    #[test]
    fn branch_follows_parent() {
        let entries = vec![
            json!({"id":"a","parentId":null}),
            json!({"id":"b","parentId":"a"}),
            json!({"id":"c","parentId":"a"}),
        ];
        assert_eq!(
            active_branch(&entries, Some("c")),
            vec![entries[0].clone(), entries[2].clone()]
        );
    }
    /// 追加半行稍后补全应只读取一次，摘要与 CLI header.cwd 一致。
    #[test]
    fn catalog_handles_incomplete_tail() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("session.jsonl");
        fs::write(&file, "{\"type\":\"session\",\"id\":\"a\",\"cwd\":\"/project\",\"version\":3}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n{\"type\":").unwrap();
        let settings = Settings {
            session_dir: temp.path().to_string_lossy().into(),
            ..Settings::default()
        };
        let mut catalog = Catalog::default();
        assert_eq!(
            catalog.list(&settings, "/project", "hello").unwrap().len(),
            1
        );
        use std::io::Write;
        writeln!(
            fs::OpenOptions::new().append(true).open(file).unwrap(),
            "\"session_info\",\"name\":\"renamed\"}}"
        )
        .unwrap();
        assert_eq!(
            catalog.list(&settings, "/project", "").unwrap()[0].name,
            "renamed"
        );
    }
}
