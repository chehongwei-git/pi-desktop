//! 诊断日志只接收代码、状态与事件类型，不写入提示词、工具正文或凭据。
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 共享写入器只用于低频结构化诊断；最多保留当前文件与两个轮转副本。
#[derive(Clone)]
struct Writer(Arc<Mutex<Log>>);
struct Log {
    path: PathBuf,
    file: File,
    bytes: u64,
}
impl Write for Writer {
    /// 轮转发生在单锁内，避免多任务重命名同一日志；写入失败传递给 tracing。
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut log = self.0.lock().map_err(|_| io::Error::other("log lock"))?;
        if log.bytes + buffer.len() as u64 > MAX_BYTES {
            log.file.flush()?;
            // Windows 不能重命名打开文件，先用临时句柄替换，之后删除空占位。
            let placeholder = log.path.with_extension("rotating");
            let replacement = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&placeholder)?;
            drop(std::mem::replace(&mut log.file, replacement));
            let one = log.path.with_extension("1.log");
            let two = log.path.with_extension("2.log");
            let _ = fs::remove_file(&two);
            if one.exists() {
                fs::rename(&one, &two)?;
            }
            fs::rename(&log.path, &one)?;
            log.file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&log.path)?;
            let _ = fs::remove_file(placeholder);
            log.bytes = 0;
        }
        log.file.write_all(buffer)?;
        log.bytes += buffer.len() as u64;
        Ok(buffer.len())
    }
    /// 退出时由文件句柄关闭；显式 flush 也遵循相同互斥边界。
    fn flush(&mut self) -> io::Result<()> {
        self.0
            .lock()
            .map_err(|_| io::Error::other("log lock"))?
            .file
            .flush()
    }
}
/// 在应用私有配置目录安装日志；诊断不可用时仍允许应用启动。
pub fn init(config_dir: &std::path::Path) {
    let result = (|| -> io::Result<Writer> {
        fs::create_dir_all(config_dir)?;
        let path = config_dir.join("desktop.log");
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let bytes = file.metadata()?.len();
        Ok(Writer(Arc::new(Mutex::new(Log { path, file, bytes }))))
    })();
    if let Ok(writer) = result {
        let _ = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .with_writer(move || writer.clone())
            .try_init();
    }
}
