//! 原生图片选择与受限读取：只读取用户本次选择的文件，不暴露通用路径接口。
use crate::types::{AppError, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::PathBuf};
use tauri_plugin_dialog::DialogExt;

/// 阻塞选择器与磁盘读取由调用方放到 blocking 池，避免占用异步运行时。
pub fn pick(app: tauri::AppHandle) -> Result<Vec<Value>> {
    let Some(files) = app
        .dialog()
        .file()
        .set_title("选择图片")
        .add_filter(
            "图片（PNG、JPEG、WebP、GIF）",
            &["png", "jpg", "jpeg", "webp", "gif"],
        )
        .blocking_pick_files()
    else {
        return Ok(vec![]);
    };
    let paths = files
        .into_iter()
        .map(|file| {
            file.into_path()
                .map_err(|_| AppError::new("IMAGE", "无法读取所选图片路径"))
        })
        .collect::<Result<Vec<_>>>()?;
    read(paths)
}

fn read(paths: Vec<PathBuf>) -> Result<Vec<Value>> {
    if paths.len() > 8 {
        return Err(AppError::new("IMAGE", "每条消息最多添加 8 张图片。"));
    }
    let mut images = Vec::new();
    let mut total = 0;
    for path in paths {
        let mime = match path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => return Err(AppError::new("IMAGE", "支持 PNG、JPEG、WebP 和 GIF 图片。")),
        };
        let mut bytes = Vec::new();
        // 限长读取也防止检查大小之后文件增长，避免任意大文件占用内存。
        File::open(&path)
            .and_then(|f| f.take(10 * 1024 * 1024 + 1).read_to_end(&mut bytes))
            .map_err(|_| AppError::new("IMAGE", "图片读取失败，请重新选择。"))?;
        total += bytes.len();
        if total > 24 * 1024 * 1024 {
            return Err(AppError::new("IMAGE", "图片总大小不能超过 24 MiB"));
        }
        let data = STANDARD.encode(&bytes);
        let image = json!({"type":"image", "mimeType":mime, "data":data});
        crate::images::validate(&[image])?;
        images.push(json!({"id":format!("{:x}", Sha256::digest(data.as_bytes())),
            "name":path.file_name().unwrap_or_default().to_string_lossy(), "mimeType":mime, "data":data}));
    }
    Ok(images)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_selected_bytes_and_budgets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.PNG");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        let selected = read(vec![path.clone()]).unwrap();
        assert_eq!(selected[0]["mimeType"], "image/png");
        assert_eq!(selected[0]["name"], "photo.PNG");
        std::fs::write(&path, b"not an image").unwrap();
        assert!(read(vec![path.clone()]).is_err());
        let mut bytes = vec![0; 10 * 1024 * 1024 + 1];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        std::fs::write(&path, &bytes).unwrap();
        assert!(read(vec![path.clone()]).is_err());
        bytes.truncate(9 * 1024 * 1024);
        std::fs::write(&path, &bytes).unwrap();
        assert!(read(vec![path; 3]).is_err());
    }
    #[test]
    fn rejects_count_extension_and_missing_files() {
        assert!(read(vec![PathBuf::from("a.png"); 9]).is_err());
        assert!(read(vec![PathBuf::from("a.txt")]).is_err());
        assert!(read(vec![PathBuf::from("missing-image.PNG")]).is_err());
        assert!(read(vec![]).unwrap().is_empty());
    }
}
