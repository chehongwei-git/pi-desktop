//! 附件边界校验：在调用 Pi 前验证 Base64、文件签名及总预算。
use crate::types::{AppError, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

pub fn validate(images: &[Value]) -> Result<()> {
    let invalid = || {
        AppError::new(
            "IMAGE",
            "图片格式或大小无效；支持 PNG、JPEG、WebP、GIF，单张最多 10 MiB",
        )
    };
    if images.len() > 8 {
        return Err(invalid());
    }
    let mut total = 0;
    for image in images {
        let data = image["data"].as_str().ok_or_else(invalid)?;
        if image["type"] != "image" || data.len() > (10 * 1024 * 1024_usize).div_ceil(3) * 4 {
            return Err(invalid());
        }
        let bytes = STANDARD.decode(data).map_err(|_| invalid())?;
        let signature = match image["mimeType"].as_str().unwrap_or("") {
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
            "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            _ => false,
        };
        if !signature || bytes.len() > 10 * 1024 * 1024 {
            return Err(invalid());
        }
        total += bytes.len();
    }
    if total > 24 * 1024 * 1024 {
        return Err(AppError::new("IMAGE", "图片总大小不能超过 24 MiB"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_invalid_encoding_signature_and_count() {
        let image = json!({"type":"image","mimeType":"image/png","data":STANDARD.encode(b"\x89PNG\r\n\x1a\n")});
        assert!(validate(&[image.clone()]).is_ok());
        assert!(validate(&vec![image; 9]).is_err());
        for data in ["%%%%", "aGVsbG8=", ""] {
            assert!(
                validate(&[json!({"type":"image","mimeType":"image/png","data":data})]).is_err()
            );
        }
    }
}
