//! 配置 Repository：原子替换、损坏备份；不存模型密钥或会话正文。
use crate::types::{AppError, Result, Settings};
use std::{fs, io::Write, path::Path};

/// 读取 schema v1；损坏内容移到备份，未知新版本拒绝覆盖。
pub fn load(dir: &Path) -> Result<Settings> {
    fs::create_dir_all(dir)?;
    let file = dir.join("settings.json");
    if !file.exists() {
        return Ok(Settings::default());
    }
    let text = fs::read_to_string(&file)?;
    match serde_json::from_str::<Settings>(&text) {
        Ok(settings) if settings.schema_version == 1 => Ok(settings),
        Ok(_) => Err(AppError::new(
            "SETTINGS_VERSION",
            "配置来自更高版本，请使用对应客户端",
        )),
        Err(_) => {
            fs::rename(file, dir.join("settings.corrupt.json"))?;
            Ok(Settings::default())
        }
    }
}

/// 同目录临时文件持久化，避免中断时留下半个 JSON；仅保留最近 20 项目。
pub fn save(dir: &Path, settings: &Settings) -> Result<()> {
    if !(80..=150).contains(&settings.zoom) {
        return Err(AppError::new(
            "SETTINGS",
            "界面缩放比例须在 80% 至 150% 之间",
        ));
    }
    if !["system", "light", "dark"].contains(&settings.theme.as_str()) {
        return Err(AppError::new("SETTINGS", "无效主题"));
    }
    fs::create_dir_all(dir)?;
    let mut clean = settings.clone();
    clean.schema_version = 1;
    clean.recent_projects.truncate(20);
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    temp.write_all(
        &serde_json::to_vec_pretty(&clean)
            .map_err(|_| AppError::new("SETTINGS", "配置序列化失败"))?,
    )?;
    temp.as_file().sync_all()?;
    temp.persist(dir.join("settings.json"))
        .map_err(|e| AppError::from(e.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 旧版配置自动补空置顶列表；新增偏好在原子保存后保留。
    #[test]
    fn pinned_sessions_are_backward_compatible_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{"schemaVersion":1,"theme":"system"}"#,
        )
        .unwrap();
        let mut settings = load(dir.path()).unwrap();
        assert!(settings.pinned_sessions.is_empty());
        assert!(settings.project_order.is_empty());
        assert_eq!(settings.zoom, 100);
        settings.zoom = 120;
        settings.pinned_sessions = vec!["session.jsonl".into()];
        settings.project_order = vec!["/beta".into(), "/alpha".into()];
        save(dir.path(), &settings).unwrap();
        assert_eq!(load(dir.path()).unwrap().zoom, 120);
        assert_eq!(
            load(dir.path()).unwrap().project_order,
            vec!["/beta", "/alpha"]
        );
        assert_eq!(
            load(dir.path()).unwrap().pinned_sessions,
            vec!["session.jsonl"]
        );
    }
    #[test]
    fn invalid_zoom_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for zoom in [0, 79, 151] {
            let settings = Settings {
                zoom,
                ..Settings::default()
            };
            assert!(save(dir.path(), &settings).is_err());
        }
    }
    /// 损坏配置不会阻止首次使用，且原文件仍可诊断。
    #[test]
    fn corrupt_settings_are_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("settings.json"), "{").unwrap();
        assert_eq!(load(dir.path()).unwrap().schema_version, 1);
        assert!(dir.path().join("settings.corrupt.json").exists());
        save(dir.path(), &Settings::default()).unwrap();
        assert_eq!(load(dir.path()).unwrap().theme, "system");
    }
}
