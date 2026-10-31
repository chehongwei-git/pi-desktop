//! 创建用于同进程跨项目恢复的空白 v3 会话；后续内容始终由 Pi 写入。
use crate::{history, types::*};
use chrono::{SecondsFormat, Utc};
use std::{fs, io::Write, path::PathBuf};

/// 新文件独占创建，不覆盖历史。取消时仅删除内容未变的空白文件。
pub struct EmptySession {
    pub path: PathBuf,
    header: Vec<u8>,
}
impl EmptySession {
    pub fn create(settings: &Settings, project: &str) -> Result<Self> {
        let cwd = PathBuf::from(project);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(AppError::new("PROJECT", "项目目录不存在或不是绝对路径"));
        }
        let mut dir = history::root(settings);
        if settings.session_dir.is_empty()
            && std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_none()
        {
            let cwd_text = cwd.to_string_lossy();
            let trimmed = cwd_text.strip_prefix(['/', '\\']).unwrap_or(&cwd_text);
            dir = dir.join(format!("--{}--", trimmed.replace(['/', '\\', ':'], "-")));
        }
        fs::create_dir_all(&dir)?;
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let path = dir.join(format!(
            "{}_{}.jsonl",
            timestamp.replace([':', '.'], "-"),
            id
        ));
        let mut header = serde_json::to_vec(&serde_json::json!({
            "type": "session", "version": 3, "id": id,
            "timestamp": timestamp, "cwd": project,
        }))
        .map_err(|_| AppError::new("SESSION", "会话头编码失败"))?;
        header.push(b'\n');
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        if let Err(error) = file.write_all(&header).and_then(|_| file.flush()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(error.into());
        }
        Ok(Self { path, header })
    }
    pub fn discard_if_empty(&self) {
        if fs::read(&self.path).is_ok_and(|bytes| bytes == self.header) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_unique_headers_in_configured_directory_and_preserves_written_messages() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("项目");
        fs::create_dir(&project).unwrap();
        let settings = Settings {
            session_dir: temp.path().join("sessions").to_string_lossy().into(),
            ..Settings::default()
        };
        let first = EmptySession::create(&settings, project.to_str().unwrap()).unwrap();
        let second = EmptySession::create(&settings, project.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        let header: serde_json::Value =
            serde_json::from_slice(&fs::read(&first.path).unwrap()).unwrap();
        assert_eq!(header["cwd"], project.to_str().unwrap());
        assert_eq!(header["version"], 3);
        assert!(uuid::Uuid::parse_str(header["id"].as_str().unwrap()).is_ok());
        first.discard_if_empty();
        assert!(!first.path.exists());
        writeln!(
            fs::OpenOptions::new()
                .append(true)
                .open(&second.path)
                .unwrap(),
            "{{\"type\":\"message\"}}"
        )
        .unwrap();
        second.discard_if_empty();
        assert!(second.path.exists());
        assert!(EmptySession::create(&settings, "missing-relative").is_err());
    }
}
