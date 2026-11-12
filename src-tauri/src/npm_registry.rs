//! 公开 npm 发现端口：固定源、有界响应；查询不执行包代码或读取本机认证。
use crate::types::{AppError, Result};
use reqwest::{Client, StatusCode, Url};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const REGISTRY: &str = "https://registry.npmjs.org/";
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub name: String,
    pub description: String,
    pub version: String,
    pub publisher: String,
    pub pi_package: bool,
    pub pi_manifest: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    pub exact: Option<Package>,
    pub items: Vec<Package>,
    pub warnings: Vec<String>,
}
fn fail(message: &str) -> AppError {
    AppError::new("NPM_QUERY", message)
}
fn part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 214
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
}
fn package_name(value: &str) -> bool {
    if value.len() > 214 {
        return false;
    }
    if let Some(scoped) = value.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(a, b)| part(a) && part(b))
    } else {
        part(value)
    }
}
/// 仅接受精确版本和标签，避免把范围、URL 或 CLI 参数送入安装来源。
fn selector(value: &str) -> bool {
    let tag = value
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c));
    tag || version(value)
}
fn version(value: &str) -> bool {
    if value.len() > 128 {
        return false;
    }
    let (without_build, build) = value
        .split_once('+')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    let (core, pre) = without_build
        .split_once('-')
        .map_or((without_build, None), |(a, b)| (a, Some(b)));
    let identifiers = |s: &str, prerelease: bool| {
        s.split('.').all(|id| {
            !id.is_empty()
                && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                && !(prerelease
                    && id.len() > 1
                    && id.starts_with('0')
                    && id.bytes().all(|c| c.is_ascii_digit()))
        })
    };
    let numbers: Vec<_> = core.split('.').collect();
    numbers.len() == 3
        && numbers.iter().all(|s| {
            !s.is_empty()
                && s.bytes().all(|c| c.is_ascii_digit())
                && (s.len() == 1 || !s.starts_with('0'))
        })
        && value.len() <= 128
        && pre.is_none_or(|s| identifiers(s, true))
        && build.is_none_or(|s| identifiers(s, false))
}
fn spec(value: &str) -> Option<(&str, &str)> {
    let value = value.strip_prefix("npm:").unwrap_or(value);
    let split = value.rfind('@').filter(|i| *i > 0);
    let (name, selected) = split.map_or((value, "latest"), |i| (&value[..i], &value[i + 1..]));
    (package_name(name) && selected.len() <= 128 && selector(selected)).then_some((name, selected))
}
fn query(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(fail("请输入不超过 512 字节的包名或插件名称"));
    }
    if value.starts_with('-') || ["npm ", "npx ", "pi "].iter().any(|p| value.starts_with(p)) {
        return Err(fail("请输入包名，不要粘贴 npm、npx 或 Pi 命令"));
    }
    if (value.starts_with("npm:") || value.starts_with('@') || value.contains('@'))
        && spec(value).is_none()
    {
        return Err(fail(
            "包名或版本格式无效；支持精确版本或 npm 标签，不支持版本范围",
        ));
    }
    Ok(value)
}
fn client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        // registry API 不需要重定向，完全关闭以免携带查询到其它主机。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| fail("无法创建 npm 查询连接"))
}
fn endpoint(name: &str, selected: &str) -> Result<Url> {
    let mut url = Url::parse(REGISTRY).map_err(|_| fail("npm 源无效"))?;
    url.path_segments_mut()
        .map_err(|_| fail("npm 源无效"))?
        .pop_if_empty()
        .push(name)
        .push(selected);
    Ok(url)
}
async fn fetch(client: &Client, url: Url, limit: usize) -> Result<Option<Value>> {
    let mut response = client.get(url).send().await.map_err(|e| {
        fail(if e.is_timeout() {
            "npm 查询超时，请稍后重试"
        } else {
            "无法连接 npm，请检查网络或稍后重试"
        })
    })?;
    match response.status() {
        StatusCode::NOT_FOUND => return Ok(None),
        StatusCode::TOO_MANY_REQUESTS => return Err(fail("npm 查询过于频繁，请稍后重试")),
        status if !status.is_success() => return Err(fail("npm 服务暂不可用，请稍后重试")),
        _ => {}
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(fail("npm 响应超过大小限制，请使用准确包名查询"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| fail("npm 响应中断或超时，请重试"))?
    {
        if bytes.len() + chunk.len() > limit {
            return Err(fail("npm 响应超过大小限制，请使用准确包名查询"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| fail("npm 返回了无效包信息"))
}
fn text(value: &Value, key: &str, limit: usize) -> String {
    value[key]
        .as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}
fn project(value: &Value) -> Option<Package> {
    let name = value["name"].as_str()?;
    let selected = value["version"].as_str()?;
    if !package_name(name) || !version(selected) {
        return None;
    }
    let pi_package = value["keywords"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some("pi-package")));
    Some(Package {
        name: name.into(),
        version: selected.into(),
        description: text(value, "description", 500),
        publisher: text(&value["publisher"], "username", 100),
        pi_package,
        pi_manifest: value["pi"].is_object(),
    })
}
async fn detail_with(client: &Client, name: &str, selected: &str) -> Result<Option<Package>> {
    let Some(value) = fetch(client, endpoint(name, selected)?, 5 * 1024 * 1024).await? else {
        return Ok(None);
    };
    let mut package = project(&value).ok_or_else(|| fail("npm 包信息缺少有效名称或版本"))?;
    if package.name != name || (version(selected) && package.version != selected) {
        return Err(fail("npm 返回的包名或版本与请求不一致"));
    }
    package.publisher = text(&value["_npmUser"], "name", 100);
    Ok(Some(package))
}
/// 前端选中包后再解析版本，以精确版本安装，避免展示与执行不一致。
pub async fn detail(name: String, selected: String) -> Result<Package> {
    if !package_name(&name) || !selector(&selected) || selected.len() > 128 {
        return Err(fail("包名或版本格式无效"));
    }
    detail_with(&client()?, &name, &selected)
        .await?
        .ok_or_else(|| fail("未找到该包或版本"))
}
async fn keywords(client: &Client, value: &str) -> Result<Vec<Package>> {
    let mut url = Url::parse(REGISTRY).map_err(|_| fail("npm 源无效"))?;
    url.set_path("/-/v1/search");
    url.query_pairs_mut()
        .append_pair("text", &format!("{value} keywords:pi-package"))
        .append_pair("size", "20");
    let value = fetch(client, url, 1024 * 1024)
        .await?
        .ok_or_else(|| fail("npm 搜索不可用"))?;
    let objects = value["objects"]
        .as_array()
        .ok_or_else(|| fail("npm 搜索结果格式无效"))?;
    Ok(objects
        .iter()
        .take(20)
        .filter_map(|v| project(&v["package"]))
        .filter(|p| p.pi_package)
        .collect())
}
/// 两路查询独立失败；准确包不因搜索故障被隐藏，普通名称不被直接安装。
pub async fn search(value: String) -> Result<Search> {
    let value = query(&value)?;
    let client = client()?;
    let exact = async {
        match spec(value) {
            Some((name, selected)) => detail_with(&client, name, selected).await,
            None => Ok(None),
        }
    };
    let attempted_exact = spec(value).is_some();
    let (exact, items) = tokio::join!(
        exact,
        keywords(&client, spec(value).map_or(value, |(n, _)| n))
    );
    if !attempted_exact && items.is_err() {
        return Err(items.err().unwrap_or_else(|| fail("npm 搜索不可用")));
    }
    combine(exact, items)
}
fn combine(exact: Result<Option<Package>>, items: Result<Vec<Package>>) -> Result<Search> {
    let mut warnings = vec![];
    let any_success = exact.is_ok() || items.is_ok();
    let exact = exact.unwrap_or_else(|e| {
        warnings.push(e.message);
        None
    });
    let mut items = items.unwrap_or_else(|e| {
        warnings.push(e.message);
        vec![]
    });
    if !any_success {
        return Err(fail(&warnings.join("；")));
    }
    let mut names = std::collections::HashSet::new();
    if let Some(p) = &exact {
        names.insert(p.name.clone());
    }
    items.retain(|p| names.insert(p.name.clone()));
    items.truncate(if exact.is_some() { 19 } else { 20 });
    Ok(Search {
        exact,
        items,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn names_versions_and_commands() {
        for s in [
            "tool",
            "@example/tools",
            "npm:@example/tools@1.2.3",
            "tool@next",
            "tool@1.2.3-beta.1",
        ] {
            assert!(spec(s).is_some(), "{s}");
        }
        for s in [
            "-tool",
            "@scope",
            "tool@^1.0.0",
            "tool@",
            "tool@1.2",
            "a/b",
            "Tool",
            "@a/b/c",
        ] {
            assert!(spec(s).is_none(), "{s}");
        }
        for s in [
            "npx tool install",
            "npm install tool",
            "pi install npm:tool",
            "--help",
            "tool\n--help",
            "npm:tool@^1.0.0",
        ] {
            assert!(query(s).is_err(), "{s}");
        }
        assert!(!version("1.2.3-beta..1"));
        assert!(!version("1.2.3-01"));
        assert!(!version("1.2.3+a+b"));
        assert!(query("代码审阅").is_ok());
        assert!(query("review tools").is_ok());
    }
    #[test]
    fn scoped_url_is_one_segment() {
        let url = endpoint("@example/tools", "1.0.0").unwrap();
        assert_eq!(url.host_str(), Some("registry.npmjs.org"));
        assert!(url.as_str().contains("@example%2Ftools/1.0.0"));
    }
    #[test]
    fn metadata_and_partial_search() {
        let p = project(&json!({"name":"tool", "version":"1.0.0", "keywords":["pi-package"], "pi":{}, "description":"hello\nworld"})).unwrap();
        assert!(p.pi_package && p.pi_manifest);
        assert_eq!(p.description, "helloworld");
        assert!(project(&json!({"name":"tool", "version":"bad"})).is_none());
        let result = combine(Ok(Some(p.clone())), Ok(vec![p.clone(), p.clone()])).unwrap();
        assert!(result.items.is_empty());
        assert_eq!(
            combine(Ok(Some(p)), Err(fail("offline")))
                .unwrap()
                .warnings
                .len(),
            1
        );
        assert!(combine(Err(fail("offline")), Err(fail("offline"))).is_err());
    }
    /// 本地 HTTP 夹具验证传输约束，不依赖公网或真实 npm 凭据。
    async fn response(status: &str, body: &str, limit: usize) -> Result<Option<Value>> {
        let data = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        raw_response(data, limit, client().unwrap(), Duration::ZERO).await
    }
    async fn raw_response(
        data: String,
        limit: usize,
        client: Client,
        delay: Duration,
    ) -> Result<Option<Value>> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 8192];
            let _ = socket.read(&mut buffer);
            std::thread::sleep(delay);
            let _ = socket.write_all(data.as_bytes());
        });
        let result = fetch(&client, url, limit).await;
        server.join().unwrap();
        result
    }
    #[tokio::test]
    async fn chunked_limit_and_timeout() {
        let data = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n".to_string();
        assert!(raw_response(data, 1, client().unwrap(), Duration::ZERO)
            .await
            .is_err());
        let slow_client = Client::builder()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        assert!(raw_response(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".into(),
            100,
            slow_client,
            Duration::from_millis(300)
        )
        .await
        .is_err());
    }
    #[tokio::test]
    async fn transport_status_and_limits() {
        assert!(response("404 Not Found", "", 100).await.unwrap().is_none());
        assert!(response("429 Too Many Requests", "", 100)
            .await
            .unwrap_err()
            .message
            .contains("频繁"));
        assert!(response("302 Found", "", 100).await.is_err());
        assert!(response("200 OK", "invalid", 100).await.is_err());
        assert!(response("200 OK", "{\"large\":true}", 2).await.is_err());
        assert_eq!(
            response("200 OK", "{}", 100).await.unwrap(),
            Some(json!({}))
        );
    }
}
