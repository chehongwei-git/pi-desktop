//! 对话文件访问：只读限量预览，项目外访问须显式确认；不运行脚本或活跃文档。
use crate::types::{AppError, Result};
use base64::Engine;
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const TEXT_LIMIT: usize = 256 * 1024;
const IMAGE_LIMIT: u64 = 10 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    path: String,
    kind: &'static str,
    text: Option<String>,
    image: Option<String>,
    truncated: bool,
    size: u64,
    can_open: bool,
}

/// 网络路径在任何元数据 IO 前拒绝，防止点击诱发隐式网络认证。
fn local(path: &Path) -> Result<()> {
    let value = path.to_string_lossy().replace('\\', "/");
    if value.starts_with("//") || value.contains('\0') {
        return Err(AppError::new(
            "FILE",
            "不支持网络共享或设备路径，请使用本地文件",
        ));
    }
    Ok(())
}

pub fn resolve(project: &str, value: &str) -> Result<(PathBuf, PathBuf)> {
    let root = Path::new(project);
    if !root.is_absolute() {
        return Err(AppError::new("FILE", "会话工作目录不可用"));
    }
    local(root)?;
    let input = Path::new(value);
    local(input)?;
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(AppError::new("FILE", "文件路径无效"));
    }
    #[cfg(not(windows))]
    if value.as_bytes().get(1) == Some(&b':') || value.contains('\\') {
        return Err(AppError::new("FILE", "此路径不属于当前操作系统"));
    }
    let path = if input.is_absolute() {
        input.to_owned()
    } else {
        root.join(input)
    };
    // 规范化同时检查符号链接边界；项目外只返回审批信息，不读取正文。
    Ok((fs::canonicalize(root)?, fs::canonicalize(path)?))
}

/// 系统打开采用保守文档白名单，未知后缀和可执行权限文件均不交给默认处理器。
fn can_open(path: &Path, metadata: &fs::Metadata) -> bool {
    if metadata.is_dir() {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return false;
        }
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "txt"
            | "md"
            | "log"
            | "csv"
            | "tsv"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "ini"
            | "rs"
            | "ts"
            | "tsx"
            | "jsx"
            | "java"
            | "css"
            | "svelte"
            | "vue"
            | "c"
            | "h"
            | "cpp"
            | "go"
            | "sql"
            | "pdf"
            | "docx"
            | "xlsx"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "rtf"
            | "doc"
            | "xls"
            | "ppt"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "tiff"
            | "tif"
            | "heic"
            | "avif"
            | "mp3"
            | "wav"
            | "ogg"
            | "flac"
            | "mp4"
            | "mov"
            | "webm"
            | "mkv"
            | "zip"
            | "gz"
            | "tar"
            | "7z"
            | "rar"
    )
}

pub fn preview(project: &str, value: &str, approved: bool) -> Result<Preview> {
    let (root, path) = resolve(project, value)?;
    let mut result = Preview {
        path: path.to_string_lossy().into_owned(),
        kind: "approval",
        text: None,
        image: None,
        truncated: false,
        size: 0,
        can_open: false,
    };
    if !path.starts_with(root) && !approved {
        return Ok(result);
    }
    let metadata = fs::metadata(&path)?;
    result.size = metadata.len();
    result.can_open = can_open(&path, &metadata);
    if metadata.is_dir() {
        result.kind = "directory";
        return Ok(result);
    }
    if !metadata.is_file() {
        return Err(AppError::new("FILE", "仅支持普通文件和目录"));
    }
    let mut file = fs::File::open(&path)?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take((TEXT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    };
    result.kind = "other";
    if let Some(mime) = mime {
        if metadata.len() <= IMAGE_LIMIT {
            file.take(IMAGE_LIMIT + 1 - bytes.len() as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 <= IMAGE_LIMIT {
                result.kind = "image";
                result.image = Some(format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ));
            }
        }
    } else {
        result.truncated = bytes.len() > TEXT_LIMIT;
        bytes.truncate(TEXT_LIMIT);
        // 允许末尾 UTF-8 码点被限额切开，但不把任意二进制替换成乱码。
        let valid = match std::str::from_utf8(&bytes) {
            Ok(_) => true,
            Err(error) if result.truncated && error.error_len().is_none() => {
                bytes.truncate(error.valid_up_to());
                true
            }
            Err(_) => false,
        };
        if valid
            && !bytes
                .iter()
                .any(|b| *b < 32 && !matches!(*b, b'\n' | b'\r' | b'\t'))
        {
            result.kind = "text";
            result.text =
                Some(String::from_utf8(bytes).map_err(|_| AppError::new("FILE", "文本编码无效"))?);
        }
    }
    Ok(result)
}

pub fn openable(project: &str, value: &str, approved: bool) -> Result<PathBuf> {
    let (root, path) = resolve(project, value)?;
    if !path.starts_with(root) && !approved {
        return Err(AppError::new("FILE", "请先确认访问项目外文件"));
    }
    let metadata = fs::metadata(&path)?;
    if !can_open(&path, &metadata) {
        return Err(AppError::new(
            "FILE",
            "为避免运行程序，此类型不支持系统打开；可复制路径自行处理",
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_approval_binary_and_open_policy() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("中文.txt"), "你好").unwrap();
        let project = root.to_str().unwrap();
        let text = preview(project, "中文.txt", false).unwrap();
        assert_eq!(text.text.as_deref(), Some("你好"));
        fs::write(temp.path().join("outside.txt"), "secret").unwrap();
        assert_eq!(
            preview(project, "../outside.txt", false).unwrap().kind,
            "approval"
        );
        assert!(openable(project, "../outside.txt", false).is_err());
        assert_eq!(
            preview(project, "../outside.txt", true)
                .unwrap()
                .text
                .as_deref(),
            Some("secret")
        );
        fs::write(root.join("binary.bin"), [0, 255, 1]).unwrap();
        assert_eq!(preview(project, "binary.bin", false).unwrap().kind, "other");
        assert!(openable(project, "binary.bin", false).is_err());
        fs::write(root.join("run.sh"), "echo unsafe").unwrap();
        assert!(openable(project, "run.sh", false).is_err());
        for script in ["run.js", "run.py", "run.cmd", "run.lnk"] {
            fs::write(root.join(script), "unsafe").unwrap();
            assert!(openable(project, script, false).is_err());
        }
        fs::write(root.join("image.png"), b"\x89PNG\r\n\x1a\nfixture").unwrap();
        let image = preview(project, "image.png", false).unwrap();
        assert_eq!(image.kind, "image");
        assert!(image.image.unwrap().starts_with("data:image/png;base64,"));
        assert!(preview(project, "missing", false).is_err());
        assert!(resolve(project, "//server/share").is_err());
        fs::write(root.join("large.txt"), "文".repeat(TEXT_LIMIT)).unwrap();
        let large = preview(project, "large.txt", false).unwrap();
        assert!(large.truncated);
        assert!(large.text.unwrap().len() <= TEXT_LIMIT);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_requires_approval() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(outside, root.join("link.txt")).unwrap();
        assert_eq!(
            preview(root.to_str().unwrap(), "link.txt", false)
                .unwrap()
                .kind,
            "approval"
        );
    }
}
