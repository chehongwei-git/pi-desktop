//! 用户选择与拖入共用文件分类；拖放票据限定读取来源，不暴露任意路径读取接口。
use crate::types::{AppError, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Copy, Default, Deserialize)]
pub struct Budget {
    pub count: usize,
    pub bytes: usize,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropEvent {
    pub drop_id: String,
    pub position: tauri::PhysicalPosition<f64>,
    pub count: usize,
}
struct Ticket {
    id: String,
    paths: Vec<PathBuf>,
    created: Instant,
}
#[derive(Default)]
pub struct Drops(HashMap<String, Ticket>);
impl Drops {
    /// 每窗口只保留一个未消费批次；新拖入替换旧批次，内存不随事件数量增长。
    pub fn insert(
        &mut self,
        window: &str,
        paths: Vec<PathBuf>,
        position: tauri::PhysicalPosition<f64>,
    ) -> DropEvent {
        let id = uuid::Uuid::new_v4().to_string();
        let event = DropEvent {
            drop_id: id.clone(),
            count: paths.len(),
            position,
        };
        self.0.insert(
            window.to_owned(),
            Ticket {
                id,
                paths,
                created: Instant::now(),
            },
        );
        event
    }
    pub fn take(&mut self, window: &str, id: &str) -> Result<Vec<PathBuf>> {
        if self.0.get(window).is_none_or(|ticket| ticket.id != id) {
            return Err(AppError::new(
                "FILE_DROP",
                "拖入批次已失效，请重新拖入文件。",
            ));
        }
        let ticket = self.0.remove(window).expect("checked ticket");
        if ticket.created.elapsed() > Duration::from_secs(60) {
            return Err(AppError::new(
                "FILE_DROP",
                "拖入批次已过期，请重新拖入文件。",
            ));
        }
        Ok(ticket.paths)
    }
    pub fn remove(&mut self, window: &str) {
        self.0.remove(window);
    }
}

/// 阻塞选择器和磁盘操作由调用方放入 blocking 池。
pub fn pick(app: tauri::AppHandle, budget: Budget) -> Result<Vec<Value>> {
    let Some(files) = app
        .dialog()
        .file()
        .set_title("添加文件")
        .blocking_pick_files()
    else {
        return Ok(vec![]);
    };
    let paths = files
        .into_iter()
        .map(|file| {
            file.into_path()
                .map_err(|_| AppError::new("FILE", "无法读取所选文件路径"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(read(paths, budget))
}

/// 每项独立返回错误；普通引用不读取正文，超限图片也不分配完整 Base64。
pub fn read(paths: Vec<PathBuf>, mut budget: Budget) -> Vec<Value> {
    paths.into_iter().map(|path| {
        match read_one(&path, &mut budget) {
            Ok(value) => value,
            Err(error) => json!({"kind":"error", "name":path.file_name().and_then(|name| name.to_str()).unwrap_or("无法显示的文件名"), "message":error.message}),
        }
    }).collect()
}
fn read_one(path: &std::path::Path, budget: &mut Budget) -> Result<Value> {
    let text = path
        .to_str()
        .filter(|_| path.is_absolute())
        .ok_or_else(|| AppError::new("FILE", "文件路径必须是可表示的完整绝对路径。"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(text);
    let metadata = path
        .metadata()
        .map_err(|_| AppError::new("FILE", "文件不存在或无法访问，请重新选择。"))?;
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(AppError::new("FILE", "仅支持普通文件和目录路径。"));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    };
    if metadata.is_dir() || mime.is_none() {
        let mut item = json!({"id":uuid::Uuid::new_v4().to_string(), "kind":"path", "path":text, "name":name, "directory":metadata.is_dir()});
        if !metadata.is_dir()
            && [
                "bmp", "tif", "tiff", "heic", "heif", "avif", "svg", "ico", "tga", "psd", "raw",
            ]
            .contains(&extension.as_str())
        {
            item["notice"] = json!("此格式按路径引用");
        }
        return Ok(item);
    }
    if budget.count >= 8 {
        return Err(AppError::new("IMAGE", "每条消息最多添加 8 张图片。"));
    }
    let size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    if size == 0 || size > 10 * 1024 * 1024 {
        return Err(AppError::new("IMAGE", "图片不能为空且不能超过 10 MiB。"));
    }
    if budget.bytes.saturating_add(size) > 24 * 1024 * 1024 {
        return Err(AppError::new(
            "IMAGE",
            "每条消息的图片总大小不能超过 24 MiB。",
        ));
    }
    let mut bytes = Vec::new();
    // 文件可能在检查后增长，限长读取和读后预算校验缺一不可。
    File::open(path)
        .and_then(|file| file.take(10 * 1024 * 1024 + 1).read_to_end(&mut bytes))
        .map_err(|_| AppError::new("IMAGE", "图片读取失败，请重新选择。"))?;
    if budget.bytes.saturating_add(bytes.len()) > 24 * 1024 * 1024 {
        return Err(AppError::new(
            "IMAGE",
            "每条消息的图片总大小不能超过 24 MiB。",
        ));
    }
    let data = STANDARD.encode(&bytes);
    let mime = mime.expect("image candidate");
    crate::images::validate(&[json!({"type":"image", "mimeType":mime, "data":data})])?;
    budget.count += 1;
    budget.bytes += bytes.len();
    Ok(
        json!({"id":uuid::Uuid::new_v4().to_string(), "kind":"image", "image":{
            "id":format!("{:x}", Sha256::digest(data.as_bytes())), "name":name, "mimeType":mime, "data":data
        }}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_selected_bytes_and_budgets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.PNG");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        let selected = read(vec![path.clone()], Budget::default());
        assert_eq!(selected[0]["image"]["mimeType"], "image/png");
        assert_eq!(selected[0]["image"]["name"], "photo.PNG");
        std::fs::write(&path, b"not an image").unwrap();
        assert_eq!(
            read(vec![path.clone()], Budget::default())[0]["kind"],
            "error"
        );
        let mut bytes = vec![0; 10 * 1024 * 1024 + 1];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            read(vec![path.clone()], Budget::default())[0]["kind"],
            "error"
        );
        bytes.truncate(9 * 1024 * 1024);
        std::fs::write(&path, bytes).unwrap();
        let result = read(vec![path; 3], Budget::default());
        assert_eq!(result[0]["kind"], "image");
        assert_eq!(result[1]["kind"], "image");
        assert_eq!(result[2]["kind"], "error");
    }
    #[test]
    fn mixes_paths_directories_and_images_without_losing_successes() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("图 片.png");
        let doc = dir.path().join("需求 \"文档.txt");
        // Windows 文件名不允许双引号，路径转义由前端独立覆盖。
        let doc = if cfg!(windows) {
            dir.path().join("需求 文档.txt")
        } else {
            doc
        };
        let svg = dir.path().join("icon.svg");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(&doc, b"text").unwrap();
        std::fs::write(&svg, b"<svg/>").unwrap();
        let values = read(
            vec![
                image.clone(),
                doc.clone(),
                dir.path().to_path_buf(),
                svg,
                dir.path().join("missing.png"),
                image,
            ],
            Budget::default(),
        );
        assert_eq!(
            values
                .iter()
                .map(|value| value["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["image", "path", "path", "path", "error", "image"]
        );
        assert_eq!(values[1]["path"], doc.to_str().unwrap());
        assert_eq!(values[2]["directory"], true);
        assert_eq!(values[3]["notice"], "此格式按路径引用");
        assert_ne!(values[0]["id"], values[5]["id"]);
        assert_eq!(values[0]["image"]["id"], values[5]["image"]["id"]);
    }
    #[test]
    fn existing_budget_count_and_relative_paths_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(
            read(vec![path.clone()], Budget { count: 8, bytes: 0 })[0]["kind"],
            "error"
        );
        assert_eq!(
            read(
                vec![path],
                Budget {
                    count: 0,
                    bytes: 24 * 1024 * 1024
                }
            )[0]["kind"],
            "error"
        );
        assert_eq!(
            read(vec![PathBuf::from("relative.txt")], Budget::default())[0]["kind"],
            "error"
        );
        assert!(read(vec![], Budget::default()).is_empty());
    }
    #[test]
    fn drop_tickets_are_window_bound_single_use_replaceable_and_expiring() {
        let mut drops = Drops::default();
        let pos = tauri::PhysicalPosition::new(10.0, 20.0);
        let first = drops.insert("main", vec![PathBuf::from("a")], pos);
        assert!(drops.take("other", &first.drop_id).is_err());
        assert!(drops.take("main", "invalid").is_err());
        let next = drops.insert("main", vec![PathBuf::from("b")], pos);
        assert!(drops.take("main", &first.drop_id).is_err());
        assert_eq!(
            drops.take("main", &next.drop_id).unwrap(),
            [PathBuf::from("b")]
        );
        assert!(drops.take("main", &next.drop_id).is_err());
        let expired = drops.insert("main", vec![], pos);
        drops.0.get_mut("main").unwrap().created = Instant::now() - Duration::from_secs(61);
        assert!(drops.take("main", &expired.drop_id).is_err());
        let closed = drops.insert("main", vec![], pos);
        drops.remove("main");
        assert!(drops.take("main", &closed.drop_id).is_err());
    }
}
