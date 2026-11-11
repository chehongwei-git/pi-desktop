//! 插件专用 CLI Adapter：白名单参数、有限输出、独立进程树，不经过 shell。
use crate::{
    platform,
    types::{AppError, Result, Settings},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub action: String,
    pub source: String,
}
/// 来源必须作为单个参数传递；不支持任意选项或 Shell 命令。
fn source(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 2048
        || value.chars().any(char::is_control)
        || value.starts_with('-')
    {
        return Err(AppError::new(
            "PLUGIN_SOURCE",
            "请输入有效来源，不接受命令行选项",
        ));
    }
    if !(value.starts_with("npm:")
        || value.starts_with("git:")
        || value.starts_with("https://")
        || Path::new(value).is_absolute())
    {
        return Err(AppError::new(
            "PLUGIN_SOURCE",
            "使用 npm:包名、git:仓库、HTTPS 仓库或本地绝对路径",
        ));
    }
    if value.starts_with("https://") {
        let url = reqwest::Url::parse(value)
            .map_err(|_| AppError::new("PLUGIN_SOURCE", "仓库 URL 无效"))?;
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
            return Err(AppError::new(
                "PLUGIN_SOURCE",
                "仓库来源不能包含凭据或查询参数",
            ));
        }
    }
    Ok(())
}
/// 不回传 CLI 原始输出，避免认证头、脚本输出或完整环境泄露到 WebView。
pub async fn run(
    settings: &Settings,
    home: &Path,
    project: Option<&Path>,
    request: Request,
) -> Result<Value> {
    let args = match request.action.as_str() {
        "install" => {
            source(&request.source)?;
            vec!["install", request.source.as_str()]
        }
        "update" => {
            source(&request.source)?;
            vec!["update", request.source.as_str()]
        }
        "diagnose" => vec!["mcp", "list", "--json"],
        "login" | "logout" => {
            if request.source.is_empty()
                || !request
                    .source
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(AppError::new("MCP_NAME", "服务器名称无效"));
            }
            vec!["mcp", request.action.as_str(), request.source.as_str()]
        }
        _ => return Err(AppError::new("PLUGIN_ACTION", "未知插件操作")),
    };
    let spec = platform::discover(settings)?;
    let mut cmd = platform::command(&spec, settings)?;
    cmd.args(args)
        .current_dir(project.unwrap_or(home))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 全局操作从用户目录运行，避免隐式安装到某个项目；项目安装显式使用 -l。
    if project.is_some() && request.action == "install" {
        cmd.arg("--local");
    }
    let mut child = cmd.spawn()?;
    let tree = match platform::ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new("PLUGIN_PROCESS", "无法读取子进程输出"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::new("PLUGIN_PROCESS", "无法读取子进程诊断"))?;
    let out = tokio::spawn(async move { drain(stdout, true).await });
    let err = tokio::spawn(async move { drain(stderr, false).await });
    let result = tokio::time::timeout(Duration::from_secs(300), child.wait()).await;
    drop(tree);
    // 树清理后所有读端均会结束；失败不重试有副作用的安装或认证动作。
    let bytes = out
        .await
        .map_err(|_| AppError::new("PLUGIN_PROCESS", "读取输出任务失败"))??;
    let _ = err.await;
    let status = result.map_err(|_| AppError::new("PLUGIN_TIMEOUT", "操作超过 5 分钟，已停止自有进程；请检查实际配置后再决定是否重试，安装脚本副作用可能仍然存在"))??;
    if request.action == "diagnose" {
        // Pi 的 JSON 结构按版本变化，不能以退出成功冒充当前会话已连接。
        let parsed = serde_json::from_slice::<Value>(&bytes).is_ok();
        return Ok(
            json!({"success":status.success(),"message":if status.success() { "独立 CLI 检查通过；这是新连接检查，不代表已有会话状态。" } else { "部分 MCP 无法连接或配置无效。请检查程序是否可用、环境变量、远程认证和 Pi 的 mcp.log；未回传可能含秘密的原始日志。" },"structured":parsed}),
        );
    }
    if !status.success() {
        return Err(AppError::new("PLUGIN_COMMAND", "Pi 操作未成功，可能存在部分变更。请重新读取配置并通过 Pi CLI 检查；为保护凭据，此页不展示安装脚本或认证的原始输出。"));
    }
    Ok(
        json!({"success":true,"message": "Pi 操作已结束，请核对重新读取的配置；运行中的会话不会自动重载。"}),
    )
}
/// 持续排空管道但只保存有界 stdout，避免大型安装日志堵塞或占满内存。
async fn drain(
    mut stream: impl tokio::io::AsyncRead + Unpin,
    retain: bool,
) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let length = stream.read(&mut buffer).await?;
        if length == 0 {
            break;
        }
        if retain {
            let remaining = (1024 * 1024usize).saturating_sub(output.len());
            output.extend_from_slice(&buffer[..length.min(remaining)]);
        }
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sources_cannot_be_options_or_commands() {
        for value in [
            "",
            "--help",
            "npm:x\n--help",
            "echo hello",
            "https://user:secret@example.test/repo",
            "https://example.test/repo?token=x",
        ] {
            assert!(source(value).is_err(), "{value}");
        }
        for value in [
            "npm:@example/tools@1.0.0",
            "git:github.com/example/tools@v1",
            "https://github.com/example/tools",
        ] {
            assert!(source(value).is_ok());
        }
    }
}
