//! 平台 Adapter：有限候选发现、无 shell 启动、只回收本应用拥有的进程树。
use crate::types::{AppError, LaunchSpec, Result, Settings};
use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::{Child, Command};

/// 合并用户额外 PATH，不修改父进程环境；不可表示的目录返回显式错误。
fn search_path(settings: &Settings) -> Result<std::ffi::OsString> {
    let mut paths: Vec<PathBuf> = settings.extra_path.iter().map(PathBuf::from).collect();
    paths.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
    env::join_paths(paths).map_err(|_| AppError::new("PATH", "额外 PATH 含无效目录"))
}

/// 在有限安装目录查找入口，不执行用户 shell 配置，也不递归磁盘。
fn candidates(settings: &Settings, name: &str) -> Result<Vec<PathBuf>> {
    let mut dirs: Vec<PathBuf> = env::split_paths(&search_path(settings)?).collect();
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        let home = PathBuf::from(home);
        dirs.extend([
            home.join(".local/bin"),
            home.join(".bun/bin"),
            home.join(".pi/bin"),
        ]);
    }
    if let Some(roaming) = env::var_os("APPDATA") {
        dirs.push(PathBuf::from(roaming).join("npm"));
    }
    dirs.extend([
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    Ok(dirs.into_iter().map(|dir| dir.join(name)).collect())
}

/// 显式配置优先，随后 PATH 与常见目录；标准 npm shim 解析 bin 而非执行 cmd。
pub fn discover(settings: &Settings) -> Result<LaunchSpec> {
    if !settings.pi_path.trim().is_empty() {
        return resolve(Path::new(&settings.pi_path), settings);
    }
    let names = if cfg!(windows) {
        vec!["pi.exe", "pi.cmd", "pi"]
    } else {
        vec!["pi"]
    };
    for name in names {
        for path in candidates(settings, name)? {
            if path.is_file() {
                if let Ok(spec) = resolve(&path, settings) {
                    return Ok(spec);
                }
            }
        }
    }
    Err(AppError::new(
        "PI_NOT_FOUND",
        "未找到 Pi。请安装 Pi，或在设置中指定入口路径与 Node 运行时。",
    ))
}

/// 支持脚本+运行时、原生入口及 npm 安装布局；未知 cmd 明确拒绝。
fn resolve(path: &Path, settings: &Settings) -> Result<LaunchSpec> {
    if !path.is_file() {
        return Err(AppError::new("PI_PATH", "Pi 入口文件不存在"));
    }
    let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
    let parent = path.parent().unwrap_or(Path::new("."));
    let package = parent.join("node_modules/@earendil-works/pi-coding-agent/package.json");
    let script = if package.is_file() && matches!(ext, "cmd" | "ps1" | "") {
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&package)?)
            .map_err(|_| AppError::new("PI_PACKAGE", "Pi package.json 无效"))?;
        let bin = value
            .pointer("/bin/pi")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::new("PI_PACKAGE", "未找到 bin.pi"))?;
        Some(package.parent().unwrap().join(bin))
    } else if matches!(ext, "js" | "mjs" | "cjs") {
        Some(path.to_path_buf())
    } else if matches!(ext, "cmd" | "bat" | "ps1") {
        return Err(AppError::new(
            "PI_SHIM",
            "不支持自定义启动脚本，请选择 Pi CLI 的 JS 文件并指定 Node",
        ));
    } else {
        None
    };
    if let Some(script) = script {
        if !script.is_file() {
            return Err(AppError::new("PI_PATH", "Pi CLI 脚本不存在"));
        }
        let runtime = if !settings.runtime_path.is_empty() {
            PathBuf::from(&settings.runtime_path)
        } else {
            let name = if cfg!(windows) { "node.exe" } else { "node" };
            std::iter::once(parent.join(name))
                .chain(candidates(settings, name)?)
                .find(|p| p.is_file())
                .ok_or_else(|| {
                    AppError::new("NODE_NOT_FOUND", "未找到 Node，请在设置中指定运行时")
                })?
        };
        if !runtime.is_file() {
            return Err(AppError::new("NODE_NOT_FOUND", "运行时文件不存在"));
        }
        return Ok(LaunchSpec {
            executable: runtime.to_string_lossy().into(),
            args: vec![script.to_string_lossy().into()],
        });
    }
    Ok(LaunchSpec {
        executable: path.to_string_lossy().into(),
        args: vec![],
    })
}

/// 构造命令：所有参数独立传递；Windows 不弹控制台，Unix 单独进程组。
pub fn command(spec: &LaunchSpec, settings: &Settings) -> Result<Command> {
    let mut cmd = Command::new(&spec.executable);
    cmd.args(&spec.args)
        .env("PATH", search_path(settings)?)
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    Ok(cmd)
}

/// 仅执行 --version，超时后杀死该探测子进程，不加载 Agent 或提示词。
pub async fn version(settings: &Settings) -> Result<serde_json::Value> {
    let spec = discover(settings)?;
    let mut cmd = command(&spec, settings)?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        cmd.arg("--version").stdin(Stdio::null()).output(),
    )
    .await
    .map_err(|_| AppError::new("VERSION_TIMEOUT", "Pi 版本检测超时"))??;
    if !result.status.success() {
        return Err(AppError::new("VERSION", "Pi 无法启动，请检查运行时版本"));
    }
    let version = String::from_utf8_lossy(&result.stdout).trim().to_string();
    Ok(serde_json::json!({"spec":spec,"version":version,"verified":version.contains("1.4.0")}))
}

/// 进程树所有权 guard；Windows Job 在 guard drop 时自动清理仍存活子孙。
pub struct ProcessTree {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(unix)]
    pid: i32,
}
// SAFETY: Job 句柄只有 guard 拥有，转移到 actor 后只在该任务中使用/关闭。
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
impl ProcessTree {
    /// spawn 后立即绑定所有权；绑定失败则调用方必须关闭新创建的进程。
    pub fn attach(child: &Child) -> Result<Self> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::{JobObjects::*, Threading::*},
            };
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().into());
            }
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                0,
                child.id().unwrap_or(0),
            );
            if process.is_null() {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().into());
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(Self { handle: job })
        }
        #[cfg(unix)]
        {
            Ok(Self {
                pid: child
                    .id()
                    .ok_or_else(|| AppError::new("PROCESS", "进程已退出"))?
                    as i32,
            })
        }
    }
    /// 仅给已拥有的 Unix 进程组发 TERM，允许工具自行清理。
    pub fn terminate(&self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pid, libc::SIGTERM);
        }
    }
}
impl Drop for ProcessTree {
    /// 退出所有路径均回收树，绝不按名称终止其他 Pi。
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pid, libc::SIGKILL);
        }
    }
}
