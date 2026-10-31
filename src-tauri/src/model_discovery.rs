//! 有界远端模型发现；不记录请求头或响应正文，不跟随携带凭据的重定向。
use crate::{
    model_config::{self, ProviderConfig},
    types::{AppError, Result},
};
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeSet, path::Path, time::Duration};

#[derive(Serialize)]
pub struct RemoteModel {
    pub id: String,
    pub name: String,
}
#[derive(Serialize)]
pub struct Discovery {
    pub models: Vec<RemoteModel>,
    pub truncated: bool,
}
fn error(message: &str) -> AppError {
    AppError::new("MODEL_DISCOVERY", message)
}
/// 超时覆盖所有分页；请求取消由调用方丢弃 Future，UI 另用代次隔离迟到结果。
pub async fn discover(dir: &Path, provider: ProviderConfig) -> Result<Discovery> {
    tokio::time::timeout(Duration::from_secs(30), fetch(dir, provider))
        .await
        .map_err(|_| error("获取模型超时，请检查地址后重试"))?
}
async fn fetch(dir: &Path, p: ProviderConfig) -> Result<Discovery> {
    let api = p.api.as_deref().ok_or_else(|| error("请先选择 API 协议"))?;
    if ![
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
    ]
    .contains(&api)
    {
        return Err(error("该协议暂不支持模型发现"));
    }
    let mut url = model_config::validate_url(
        p.base_url
            .as_deref()
            .ok_or_else(|| error("请先填写 API 基础地址"))?,
    )?;
    url.set_path(&format!("{}/models", url.path().trim_end_matches('/')));
    let key = model_config::discovery_key(dir, &p)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| error("无法创建模型请求"))?;
    let anthropic = api == "anthropic-messages";
    let mut models = Vec::new();
    let mut seen = BTreeSet::new();
    let mut cursors = BTreeSet::new();
    let mut cursor: Option<String> = None;
    for page in 0..20 {
        let mut request = client.get(url.clone());
        if anthropic {
            request = request
                .header("anthropic-version", "2023-06-01")
                .query(&[("limit", "1000")]);
            if let Some(c) = &cursor {
                request = request.query(&[("after_id", c)]);
            }
        }
        if let Some(key) = &key {
            request = if anthropic {
                request.header("x-api-key", key)
            } else {
                request.bearer_auth(key)
            };
        }
        let mut response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                error("模型请求超时")
            } else {
                error("模型请求失败，请检查地址、网络和证书")
            }
        })?;
        if !response.status().is_success() {
            return Err(error(match response.status().as_u16() {
                401 => "认证失败，请检查 API Key",
                403 => "没有获取模型的权限",
                404 | 405 => "服务不支持此模型列表接口，请手动添加模型",
                429 => "请求受限，请稍后重试",
                300..=399 => "模型地址发生重定向，请直接填写最终 API 地址",
                _ => "远端服务返回错误，请稍后重试",
            }));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| error("读取模型列表失败"))?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(error("模型列表响应过大，请手动添加模型"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| error("远端返回的模型列表不是有效 JSON"))?;
        let entries = value["data"]
            .as_array()
            .ok_or_else(|| error("远端模型列表格式不兼容，请手动添加模型"))?;
        for entry in entries {
            let id = entry["id"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.len() <= 1024)
                .ok_or_else(|| error("远端模型条目缺少有效 ID"))?;
            if !seen.insert(id.to_owned()) {
                continue;
            }
            if models.len() == 5000 {
                return Ok(Discovery {
                    models,
                    truncated: true,
                });
            }
            let name = entry["display_name"]
                .as_str()
                .or_else(|| entry["name"].as_str())
                .unwrap_or(id);
            models.push(RemoteModel {
                id: id.into(),
                name: name.chars().take(1024).collect(),
            });
        }
        if !anthropic || value["has_more"] != true {
            models.sort_by(|a, b| a.id.cmp(&b.id));
            return Ok(Discovery {
                models,
                truncated: !anthropic && value["has_more"] == true,
            });
        }
        let next = value["last_id"]
            .as_str()
            .ok_or_else(|| error("远端分页缺少游标"))?
            .to_owned();
        if !cursors.insert(next.clone()) {
            return Err(error("远端分页游标重复，已停止获取"));
        }
        cursor = Some(next);
        if page == 19 {
            return Ok(Discovery {
                models,
                truncated: true,
            });
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[tokio::test]
    async fn fetch_keeps_prefix_auth_and_deduplicates() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut bytes = [0; 8192];
            let size = stream.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..size]);
            assert!(request.starts_with("GET /prefix/v1/models "));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer test-key"));
            let body = r#"{"data":[{"id":"a"},{"id":"a"},{"id":"b","name":"Bee"}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let p = ProviderConfig {
            id: "test".into(),
            name: None,
            api: Some("openai-responses".into()),
            base_url: Some(format!("http://{address}/prefix/v1/")),
            credential_source: String::new(),
            models: vec![],
            credential: model_config::CredentialChange {
                action: "replace".into(),
                value: "test-key".into(),
                confirm_replace: false,
            },
            removed: false,
            clear_credential: false,
        };
        let result = discover(dir.path(), p).await.unwrap();
        assert_eq!(result.models.len(), 2);
        assert!(!result.truncated);
        thread.join().unwrap();
    }
}
