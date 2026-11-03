//! Pi 共享配置仓库：只返回可编辑字段，凭据留在宿主；目录锁与 Pi proper-lockfile 互斥。
use crate::types::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FILES: [&str; 3] = ["models.json", "auth.json", "settings.json"];
const MODEL_FIELDS: [&str; 7] = [
    "name",
    "contextWindow",
    "maxTokens",
    "input",
    "reasoning",
    "thinkingLevelMap",
    "id",
];

/// 可编辑模型字段；未知高级字段不经过前端，保存时从原文合并。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfig {
    pub id: String,
    pub override_only: bool,
    pub values: BTreeMap<String, Value>,
    pub default_thinking: Option<String>,
}
/// 密钥动作与元数据分离，空输入不能隐式删除已存凭据。
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialChange {
    pub action: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub confirm_replace: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    pub id: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub api: Option<String>,
    pub credential_source: String,
    pub models: Vec<ModelConfig>,
    #[serde(default)]
    pub credential: CredentialChange,
    #[serde(default)]
    pub removed: bool,
    #[serde(default)]
    pub clear_credential: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSettings {
    pub revision: String,
    pub directory: String,
    pub providers: Vec<ProviderConfig>,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub default_thinking_level: Option<String>,
}

/// 与 Pi 启动环境共用目录解析；相对覆盖路径以桌面进程工作目录解析。
pub fn directory(home: &Path) -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .map(|p| {
            if p == Path::new("~") {
                home.to_path_buf()
            } else if let Ok(rest) = p.strip_prefix("~") {
                home.join(rest)
            } else {
                p
            }
        })
        .unwrap_or_else(|| home.join(".pi").join("agent"))
}
fn fail(message: impl Into<String>) -> AppError {
    AppError::new("MODEL_CONFIG", message)
}
fn raw(dir: &Path) -> Result<Vec<Option<Vec<u8>>>> {
    FILES
        .iter()
        .map(|name| match fs::read(dir.join(name)) {
            Ok(bytes) if bytes.len() <= 8 * 1024 * 1024 => Ok(Some(bytes)),
            Ok(_) => Err(fail(format!("{name} 超过配置大小上限"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        })
        .collect()
}
fn parse(bytes: &Option<Vec<u8>>, name: &str) -> Result<Value> {
    let value = match bytes {
        Some(bytes) => serde_json::from_slice::<Value>(
            bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes),
        )
        .map_err(|_| fail(format!("{name} 不是有效 JSON，请先修复原文件；未覆盖配置")))?,
        None => json!({}),
    };
    if !value.is_object() {
        return Err(fail(format!("{name} 须为 JSON 对象")));
    }
    Ok(value)
}
fn revision(bytes: &[Option<Vec<u8>>]) -> String {
    let mut hash = Sha256::new();
    for value in bytes {
        match value {
            Some(v) => {
                hash.update([1]);
                hash.update((v.len() as u64).to_le_bytes());
                hash.update(v);
            }
            None => hash.update([0]),
        }
    }
    format!("{:x}", hash.finalize())
}
fn optional(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_owned)
}
fn source(models: &Value, auth: &Value, id: &str) -> String {
    if auth[id]["type"] == "oauth" {
        "OAuth".into()
    } else if let Some(key) = auth[id]["key"]
        .as_str()
        .or_else(|| models["providers"][id]["apiKey"].as_str())
    {
        if key.starts_with('!') {
            "命令型密钥".into()
        } else if key.contains('$') {
            "环境变量引用".into()
        } else {
            "已保存 API Key".into()
        }
    } else {
        "未保存认证（可能由环境或扩展提供）".into()
    }
}
/// 不解析密钥、不执行命令，也不将任意配置字段或请求头回传界面。
pub fn load(dir: &Path) -> Result<ModelSettings> {
    let bytes = raw(dir)?;
    let models = parse(&bytes[0], FILES[0])?;
    let auth = parse(&bytes[1], FILES[1])?;
    let settings = parse(&bytes[2], FILES[2])?;
    let mut ids = BTreeSet::new();
    for map in [models["providers"].as_object(), auth.as_object()]
        .into_iter()
        .flatten()
    {
        ids.extend(map.keys().cloned());
    }
    if models.get("providers").is_some_and(|v| !v.is_object()) {
        return Err(fail("models.json providers 须为对象"));
    }
    let mut providers = Vec::new();
    for id in ids {
        let p = &models["providers"][&id];
        if (!p.is_null() && !p.is_object())
            || p.get("models").is_some_and(|v| !v.is_array())
            || p.get("modelOverrides").is_some_and(|v| !v.is_object())
        {
            return Err(fail("已有服务商或模型列表结构无效，请先修复 models.json"));
        }
        let mut entries = Vec::new();
        if let Some(items) = p["models"].as_array() {
            for m in items {
                let mid = m["id"]
                    .as_str()
                    .ok_or_else(|| fail("已有模型缺少 id，请先修复 models.json"))?;
                entries.push(read_model(m, mid, false, &settings, &id));
            }
        }
        if let Some(items) = p["modelOverrides"].as_object() {
            for (mid, m) in items {
                entries.push(read_model(m, mid, true, &settings, &id));
            }
        }
        providers.push(ProviderConfig {
            id: id.clone(),
            name: optional(p, "name"),
            base_url: optional(p, "baseUrl"),
            api: optional(p, "api"),
            credential_source: source(&models, &auth, &id),
            models: entries,
            credential: CredentialChange {
                action: "keep".into(),
                ..Default::default()
            },
            removed: false,
            clear_credential: false,
        });
    }
    Ok(ModelSettings {
        revision: revision(&bytes),
        directory: dir.to_string_lossy().into(),
        providers,
        default_provider: optional(&settings, "defaultProvider"),
        default_model: optional(&settings, "defaultModel"),
        default_thinking_level: optional(&settings, "defaultThinkingLevel")
            .or_else(|| Some("off".into())),
    })
}
fn read_model(
    m: &Value,
    id: &str,
    override_only: bool,
    settings: &Value,
    provider: &str,
) -> ModelConfig {
    let mut values: BTreeMap<String, Value> = MODEL_FIELDS
        .iter()
        .filter(|k| **k != "id")
        .filter_map(|k| m.get(*k).map(|v| ((*k).into(), v.clone())))
        .collect();
    // 自定义模型以最终强度决定能力；无独立等级时跟随全局默认。
    if !override_only {
        // 缺省支持图片，但保留用户显式配置的仅文字能力。
        values
            .entry("input".into())
            .or_insert_with(|| json!(["text", "image"]));
        let thinking = settings["modelThinkingLevels"][format!("{provider}/{id}")]
            .as_str()
            .or_else(|| settings["defaultThinkingLevel"].as_str())
            .unwrap_or("off");
        values.insert("reasoning".into(), json!(thinking != "off"));
    }
    ModelConfig {
        id: id.into(),
        override_only,
        values,
        default_thinking: settings["modelThinkingLevels"][format!("{provider}/{id}")]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                (!override_only && settings["defaultThinkingLevel"].is_null()).then(|| "off".into())
            }),
    }
}
fn set_optional(v: &mut Value, key: &str, value: &Option<String>) {
    if let Some(s) = value.as_ref().filter(|s| !s.is_empty()) {
        v[key] = json!(s);
    } else {
        v.as_object_mut().unwrap().remove(key);
    }
}
fn level(value: &Option<String>) -> Result<()> {
    if value
        .as_ref()
        .is_some_and(|s| !LEVELS.contains(&s.as_str()))
    {
        return Err(fail("无效思考等级"));
    }
    Ok(())
}
pub fn validate_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).map_err(|_| fail("API 地址格式无效"))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(fail("API 地址须为不含账号、查询参数或片段的 HTTP(S) 地址"));
    }
    Ok(url)
}
fn validate(input: &ModelSettings) -> Result<()> {
    level(&input.default_thinking_level)?;
    if input.default_provider.is_some() != input.default_model.is_some() {
        return Err(fail("默认服务商和模型须同时设置或清空"));
    }
    let mut ids = BTreeSet::new();
    for p in &input.providers {
        if p.id.is_empty()
            || p.id.len() > 128
            || !p
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
            || !ids.insert(&p.id)
        {
            return Err(fail("服务商标识无效或重复"));
        }
        if p.removed {
            continue;
        }
        if let Some(url) = &p.base_url {
            validate_url(url)?;
        }
        match p.credential.action.as_str() {
            "keep" | "clear" | "none" => (),
            "replace"
                if !p.credential.value.trim().is_empty()
                    && !p.credential.value.starts_with('!')
                    && !p.credential.value.contains(['\r', '\n']) => {}
            "environment"
                if !p.credential.value.is_empty()
                    && p.credential.value.chars().enumerate().all(|(i, c)| {
                        c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                    }) => {}
            _ => return Err(fail("认证动作或密钥无效；不支持新增命令型密钥")),
        }
        let mut mids = BTreeSet::new();
        for m in &p.models {
            if m.id.trim().is_empty() || !mids.insert((&m.id, m.override_only)) {
                return Err(fail("模型 ID 不能为空或重复"));
            }
            level(&m.default_thinking)?;
            for (k, v) in &m.values {
                if !MODEL_FIELDS.contains(&k.as_str()) || k == "id" {
                    return Err(fail("不支持的模型字段"));
                }
                let valid = match k.as_str() {
                    "contextWindow" | "maxTokens" => v
                        .as_u64()
                        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991),
                    "name" => v.as_str().is_some_and(|s| !s.trim().is_empty()),
                    "reasoning" => v.is_boolean(),
                    "input" => v.as_array().is_some_and(|a| {
                        a.contains(&json!("text")) && a.iter().all(|i| i == "text" || i == "image")
                    }),
                    "thinkingLevelMap" => v.as_object().is_some_and(|o| {
                        o.iter().all(|(l, v)| {
                            LEVELS.contains(&l.as_str())
                                && (v.is_null() || v.as_str().is_some_and(|s| !s.trim().is_empty()))
                        })
                    }),
                    _ => false,
                };
                if !valid {
                    return Err(fail(format!("模型 {} 的 {k} 无效", m.id)));
                }
            }
            if let (Some(c), Some(o)) = (
                m.values.get("contextWindow").and_then(Value::as_u64),
                m.values.get("maxTokens").and_then(Value::as_u64),
            ) {
                if o > c {
                    return Err(fail(format!("模型 {} 的最大输出不能大于上下文长度", m.id)));
                }
            }
            let effective_thinking = m.default_thinking.as_ref().or_else(|| {
                (!m.override_only)
                    .then_some(input.default_thinking_level.as_ref())
                    .flatten()
            });
            if let Some(l) = effective_thinking {
                if l != "off"
                    && m.values
                        .get("thinkingLevelMap")
                        .and_then(|v| v.get(l))
                        .is_some_and(Value::is_null)
                {
                    return Err(fail("模型默认思考等级已被禁用"));
                }
            }
        }
    }
    Ok(())
}
/// 采用与 proper-lockfile 相同的 .lock 目录；忙时失败而非抢占或误删 CLI 锁。
struct Locks(Vec<PathBuf>);
impl Drop for Locks {
    fn drop(&mut self) {
        for p in self.0.iter().rev() {
            let _ = fs::remove_dir(p);
        }
    }
}
fn locks(dir: &Path) -> Result<Locks> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // auth.json 新文件继承私有目录，避免多用户设备暴露凭据。
        if !dir.join("auth.json").exists() {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    let mut locks = Locks(Vec::new());
    for name in FILES {
        let path = dir.join(format!("{name}.lock"));
        fs::create_dir(&path).map_err(|_| {
            AppError::new(
                "CONFIG_LOCKED",
                "Pi 配置正被其他进程使用，或上次异常退出留下锁；请稍后重试",
            )
        })?;
        locks.0.push(path);
    }
    Ok(locks)
}
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let target = dir.join(name);
    // 保留既有文件权限；新文件使用 tempfile 的私有权限，Windows 继承目录 ACL。
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    if let Ok(meta) = fs::metadata(&target) {
        tmp.as_file().set_permissions(meta.permissions())?;
    }
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(target).map_err(|e| AppError::from(e.error))?;
    Ok(())
}
fn merge_model(old: &Value, m: &ModelConfig, global_thinking: &Option<String>) -> Value {
    let mut out = if old.is_object() {
        old.clone()
    } else {
        json!({})
    };
    for key in MODEL_FIELDS {
        out.as_object_mut().unwrap().remove(key);
    }
    for (key, value) in &m.values {
        out[key] = value.clone();
    }
    if !m.override_only {
        out["id"] = json!(m.id);
        // 显式落盘，避免 Pi 将缺省 input 解释为仅文字。
        if out.get("input").is_none() {
            out["input"] = json!(["text", "image"]);
        }
        // Pi 在扩展加载前解析启动默认等级；为选中的扩展默认值补齐映射，防止静默降级。
        if let Some(level) = m.default_thinking.as_ref().or(global_thinking.as_ref()) {
            if ["xhigh", "max"].contains(&level.as_str()) {
                if out.get("thinkingLevelMap").is_none() {
                    out["thinkingLevelMap"] = json!({});
                }
                if out["thinkingLevelMap"].get(level).is_none() {
                    out["thinkingLevelMap"][level] = json!(level);
                }
            }
        }
        // 保存时再次归一化，防止旧客户端或全局等级修改留下冲突字段。
        out["reasoning"] = json!(m
            .default_thinking
            .as_ref()
            .or(global_thinking.as_ref())
            .is_some_and(|level| level != "off"));
    }
    out
}
/// 全部校验完成后才写盘；失败时逆序恢复，恢复失败则明确报告部分保存。
pub fn save(dir: &Path, input: ModelSettings) -> Result<ModelSettings> {
    validate(&input)?;
    let _locks = locks(dir)?;
    let original = raw(dir)?;
    if revision(&original) != input.revision {
        return Err(AppError::new(
            "CONFIG_CONFLICT",
            "Pi 配置已被外部修改；草稿已保留，请重新读取并合并后保存",
        ));
    }
    let mut models = parse(&original[0], FILES[0])?;
    let mut auth = parse(&original[1], FILES[1])?;
    let mut settings = parse(&original[2], FILES[2])?;
    if models.get("providers").is_none() {
        models["providers"] = json!({});
    }
    if !models["providers"].is_object() {
        return Err(fail("models.json providers 须为对象"));
    }
    if settings.get("modelThinkingLevels").is_none() {
        settings["modelThinkingLevels"] = json!({});
    }
    if !settings["modelThinkingLevels"].is_object() {
        return Err(fail("modelThinkingLevels 须为对象"));
    }
    for p in &input.providers {
        let old = models["providers"][&p.id].clone();
        if let Some(api) = &p.api {
            if ![
                "openai-completions",
                "openai-responses",
                "anthropic-messages",
            ]
            .contains(&api.as_str())
                && old["api"].as_str() != Some(api)
            {
                return Err(fail("新增或切换服务商协议时请选择受支持的 API 协议"));
            }
        }
        if p.removed {
            models["providers"].as_object_mut().unwrap().remove(&p.id);
            if p.clear_credential {
                auth.as_object_mut().unwrap().remove(&p.id);
            }
            settings["modelThinkingLevels"]
                .as_object_mut()
                .unwrap()
                .retain(|k, _| !k.starts_with(&format!("{}/", p.id)));
            if input.default_provider.as_deref() == Some(&p.id) {
                return Err(fail("请先更改默认模型，再移除该服务商配置"));
            }
            continue;
        }
        if !p.models.is_empty()
            && p.models.iter().any(|m| !m.override_only)
            && (p.api.is_none() || p.base_url.is_none())
            && !old.is_object()
        {
            return Err(fail("新增自定义模型须指定服务商 API 协议和基础地址"));
        }
        let mut next = if old.is_object() {
            old.clone()
        } else {
            json!({})
        };
        set_optional(&mut next, "name", &p.name);
        set_optional(&mut next, "baseUrl", &p.base_url);
        set_optional(&mut next, "api", &p.api);
        if auth[&p.id]["type"] == "oauth"
            && p.credential.action != "keep"
            && !p.credential.confirm_replace
        {
            return Err(fail("替换或清除 OAuth 认证须就地确认"));
        }
        match p.credential.action.as_str() {
            "replace" | "environment" | "none" => {
                let key = match p.credential.action.as_str() {
                    "environment" => format!("${{{}}}", p.credential.value),
                    "none" => "pi-local-no-auth".into(),
                    _ => p.credential.value.replace('$', "$$"),
                };
                let mut entry = if auth[&p.id]["type"] == "api_key" {
                    auth[&p.id].clone()
                } else {
                    json!({})
                };
                entry["type"] = json!("api_key");
                entry["key"] = json!(key);
                auth[&p.id] = entry;
                next.as_object_mut().unwrap().remove("apiKey");
            }
            "clear" => {
                auth.as_object_mut().unwrap().remove(&p.id);
                next.as_object_mut().unwrap().remove("apiKey");
            }
            _ => (),
        }
        let mut added = Vec::new();
        let mut overrides = serde_json::Map::new();
        for m in &p.models {
            let previous = if m.override_only {
                old["modelOverrides"][&m.id].clone()
            } else {
                old["models"]
                    .as_array()
                    .and_then(|a| a.iter().find(|v| v["id"] == m.id))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            let value = merge_model(&previous, m, &input.default_thinking_level);
            if m.override_only {
                overrides.insert(m.id.clone(), value);
            } else {
                added.push(value);
            }
            set_optional(
                &mut settings["modelThinkingLevels"],
                &format!("{}/{}", p.id, m.id),
                &m.default_thinking,
            );
        }
        // 只移除本次明确从表单移走的模型默认值，不影响其他模型的独立配置。
        let before = old["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["id"].as_str())
            .chain(
                old["modelOverrides"]
                    .as_object()
                    .into_iter()
                    .flat_map(|o| o.keys().map(String::as_str)),
            );
        for mid in before {
            if !p.models.iter().any(|m| m.id == mid) {
                settings["modelThinkingLevels"]
                    .as_object_mut()
                    .unwrap()
                    .remove(&format!("{}/{}", p.id, mid));
            }
        }
        if !added.is_empty() || old.get("models").is_some() {
            next["models"] = json!(added);
        }
        if !overrides.is_empty() || old.get("modelOverrides").is_some() {
            next["modelOverrides"] = Value::Object(overrides);
        }
        // 仅有认证的服务商不应生成空配置；否则移除端点后再次保存会复活为 Pi 拒绝的 {}。
        // 同时清理旧版本已写入的空条目，认证仍由上方的独立动作管理。
        if next.as_object().is_some_and(|o| o.is_empty()) {
            models["providers"].as_object_mut().unwrap().remove(&p.id);
        } else {
            models["providers"][&p.id] = next;
        }
    }
    if let (Some(pid), Some(mid)) = (&input.default_provider, &input.default_model) {
        if let Some(p) = input.providers.iter().find(|p| &p.id == pid) {
            let old = parse(&original[0], FILES[0])?;
            let existed = old["providers"][pid]["models"]
                .as_array()
                .is_some_and(|a| a.iter().any(|m| m["id"] == *mid));
            if existed && !p.models.iter().any(|m| &m.id == mid) {
                return Err(fail("默认模型已从配置移除，请先更改默认模型"));
            }
        }
    }
    set_optional(&mut settings, "defaultProvider", &input.default_provider);
    set_optional(&mut settings, "defaultModel", &input.default_model);
    set_optional(
        &mut settings,
        "defaultThinkingLevel",
        &input.default_thinking_level,
    );
    let next = [models, auth, settings]
        .iter()
        .map(|v| serde_json::to_vec_pretty(v).map_err(|_| fail("配置序列化失败")))
        .collect::<Result<Vec<_>>>()?;
    // 尽量缩短持锁时间，避免达到 proper-lockfile 的过期阈值；不持锁执行网络请求。
    let mut written: Vec<usize> = Vec::new();
    for (i, bytes) in next.iter().enumerate() {
        if original[i].as_ref() == Some(bytes) {
            continue;
        }
        if let Err(error) = write_atomic(dir, FILES[i], bytes) {
            let mut restored = true;
            for j in written.into_iter().rev() {
                let result = match &original[j] {
                    Some(b) => write_atomic(dir, FILES[j], b),
                    None => fs::remove_file(dir.join(FILES[j])).map_err(AppError::from),
                };
                restored &= result.is_ok();
            }
            return Err(if restored {
                error
            } else {
                AppError::new(
                    "CONFIG_PARTIAL",
                    "配置仅部分保存且恢复失败，请重新读取共享配置检查；草稿已保留",
                )
            });
        }
        written.push(i);
    }
    load(dir)
}

/// 发现请求仅解析静态密钥及环境引用，永不执行命令或返回 OAuth token。
pub fn discovery_key(dir: &Path, p: &ProviderConfig) -> Result<Option<String>> {
    let bytes = raw(dir)?;
    let models = parse(&bytes[0], FILES[0])?;
    let auth = parse(&bytes[1], FILES[1])?;
    let key = match p.credential.action.as_str() {
        "none" | "clear" => return Ok(None),
        "replace" => return Ok(Some(p.credential.value.clone())),
        "environment" => {
            return std::env::var(&p.credential.value)
                .map(Some)
                .map_err(|_| fail("环境变量未设置"))
        }
        "keep" | "" => {
            if auth[&p.id]["type"] == "oauth" {
                return Err(fail("模型发现暂不支持 OAuth；可手动添加模型或使用 API Key"));
            }
            auth[&p.id]["key"]
                .as_str()
                .or_else(|| models["providers"][&p.id]["apiKey"].as_str())
                .map(str::to_owned)
        }
        _ => return Err(fail("无效认证方式")),
    };
    let Some(key) = key else {
        let variable = match p.id.as_str() {
            "openai" => "OPENAI_API_KEY",
            "anthropic" => "ANTHROPIC_API_KEY",
            "openrouter" => "OPENROUTER_API_KEY",
            "deepseek" => "DEEPSEEK_API_KEY",
            _ => return Ok(None),
        };
        return Ok(std::env::var(variable).ok());
    };
    resolve_key(&key, &auth[&p.id]["env"])
}
fn resolve_key(key: &str, env: &Value) -> Result<Option<String>> {
    if key.starts_with('!') {
        return Err(fail("模型发现不执行命令型密钥，请手动添加模型"));
    }
    let chars: Vec<char> = key.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '$' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        i += 1;
        if i < chars.len() && (chars[i] == '$' || chars[i] == '!') {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let braced = i < chars.len() && chars[i] == '{';
        if braced {
            i += 1;
        }
        let start = i;
        while i < chars.len() && (chars[i] == '_' || chars[i].is_ascii_alphanumeric()) {
            i += 1;
        }
        if i == start || (braced && (i >= chars.len() || chars[i] != '}')) {
            return Err(fail("密钥环境变量引用无效"));
        }
        let name: String = chars[start..i].iter().collect();
        if braced {
            i += 1;
        }
        let value = env[&name]
            .as_str()
            .map(str::to_owned)
            .or_else(|| std::env::var(&name).ok())
            .ok_or_else(|| fail("密钥引用的环境变量未设置"))?;
        out.push_str(&value);
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_preserves_secrets_and_unknown_fields_and_detects_conflict() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("models.json"),r#"{"future":true,"providers":{"proxy":{"apiKey":"secret","headers":{"private":"hidden"},"models":[{"id":"m","compat":{"supportsStore":false},"reasoning":true}]}}}"#).unwrap();
        let mut form = load(dir.path()).unwrap();
        let serialized = serde_json::to_string(&form).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("hidden"));
        form.providers[0].models[0]
            .values
            .insert("contextWindow".into(), json!(200000));
        form.providers[0].models[0]
            .values
            .insert("thinkingLevelMap".into(), json!({"max":"max","xhigh":null}));
        form.providers[0].models[0].default_thinking = Some("max".into());
        let saved = save(dir.path(), form.clone()).unwrap();
        assert_eq!(
            saved.providers[0].models[0].default_thinking.as_deref(),
            Some("max")
        );
        let content: Value =
            serde_json::from_slice(&fs::read(dir.path().join("models.json")).unwrap()).unwrap();
        assert_eq!(content["providers"]["proxy"]["apiKey"], "secret");
        assert_eq!(
            content["providers"]["proxy"]["models"][0]["compat"]["supportsStore"],
            false
        );
        assert_eq!(
            save(dir.path(), form).err().unwrap().code,
            "CONFIG_CONFLICT"
        );
    }
    #[test]
    fn image_input_defaults_survive_save_and_respect_explicit_text_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("models.json"),
            json!({"providers": {"test": {
                "models": [{"id": "default"}, {"id": "text", "input": ["text"]}],
                "modelOverrides": {"catalog": {"maxTokens": 1000}}
            }}})
            .to_string(),
        )
        .unwrap();
        let mut form = load(dir.path()).unwrap();
        assert_eq!(
            form.providers[0].models[0].values["input"],
            json!(["text", "image"])
        );
        assert_eq!(form.providers[0].models[1].values["input"], json!(["text"]));
        assert!(!form.providers[0].models[2].values.contains_key("input"));
        // 默认选项删除字段后，宿主仍须写入图片能力，不能退回 Pi 的仅文字默认。
        form.providers[0].models[0].values.remove("input");
        save(dir.path(), form).unwrap();
        let stored = parse(&raw(dir.path()).unwrap()[0], "models.json").unwrap();
        assert_eq!(
            stored["providers"]["test"]["models"][0]["input"],
            json!(["text", "image"])
        );
        assert_eq!(
            stored["providers"]["test"]["models"][1]["input"],
            json!(["text"])
        );
        assert!(stored["providers"]["test"]["modelOverrides"]["catalog"]
            .get("input")
            .is_none());
    }

    #[test]
    fn custom_models_disable_reasoning_when_thinking_is_off() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("models.json"),
            json!({"providers": {"test": {
                "baseUrl": "https://example.test/v1", "api": "openai-responses",
                "models": [{"id": "new"}, {"id": "disabled", "reasoning": false}],
                "modelOverrides": {"catalog": {"maxTokens": 1000}}
            }}})
            .to_string(),
        )
        .unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{"modelThinkingLevels":{"test/disabled":"off"}}"#,
        )
        .unwrap();
        let form = load(dir.path()).unwrap();
        assert_eq!(form.default_thinking_level.as_deref(), Some("off"));
        let models = &form.providers[0].models;
        assert_eq!(models[0].values["reasoning"], false);
        assert_eq!(models[0].default_thinking.as_deref(), Some("off"));
        assert_eq!(models[1].values["reasoning"], false);
        assert!(!models[2].values.contains_key("reasoning"));
        assert!(models[2].default_thinking.is_none());
        save(dir.path(), form).unwrap();
        let bytes = raw(dir.path()).unwrap();
        assert_eq!(
            parse(&bytes[0], "models.json").unwrap()["providers"]["test"]["models"][0]["reasoning"],
            false
        );
        assert_eq!(
            parse(&bytes[2], "settings.json").unwrap()["modelThinkingLevels"]["test/new"],
            "off"
        );
    }

    #[test]
    fn strength_controls_reasoning_across_save_reload_and_global_inheritance() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("models.json"),
            r#"{"providers":{"test":{"api":"openai-responses","baseUrl":"https://example.test/v1","models":[{"id":"m","reasoning":false}]}}}"#).unwrap();
        let mut form = load(dir.path()).unwrap();
        for level in ["xhigh", "max", "high", "off", "medium"] {
            form.providers[0].models[0].default_thinking = Some(level.into());
            form = save(dir.path(), form).unwrap();
            assert_eq!(
                form.providers[0].models[0].values["reasoning"],
                level != "off"
            );
            let stored = parse(&raw(dir.path()).unwrap()[0], "models.json").unwrap();
            assert_eq!(
                stored["providers"]["test"]["models"][0]["reasoning"],
                level != "off"
            );
        }
        form.providers[0].models[0].default_thinking = None;
        for level in ["xhigh", "max", "high", "off"] {
            form.default_thinking_level = Some(level.into());
            form = save(dir.path(), form).unwrap();
            assert!(form.providers[0].models[0].default_thinking.is_none());
            assert_eq!(
                form.providers[0].models[0].values["reasoning"],
                level != "off"
            );
        }
    }

    #[test]
    fn auth_only_providers_do_not_create_empty_model_config() {
        let dir = tempfile::tempdir().unwrap();
        let auth = json!({
            "EE": {"type": "api_key", "key": "test-only"},
            "openai": {"type": "oauth", "access": "test-only", "refresh": "test-only", "expires": 1}
        });
        fs::write(dir.path().join("auth.json"), auth.to_string()).unwrap();
        let form = load(dir.path()).unwrap();
        let saved = save(dir.path(), form).unwrap();
        assert_eq!(saved.providers.len(), 2);
        let models = parse(&raw(dir.path()).unwrap()[0], "models.json").unwrap();
        assert_eq!(models["providers"], json!({}));
        assert_eq!(
            parse(&raw(dir.path()).unwrap()[1], "auth.json").unwrap(),
            auth
        );
    }

    #[test]
    fn removing_endpoint_preserves_optional_auth_without_resurrecting_config() {
        for clear_credential in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            fs::write(
                dir.path().join("models.json"),
                json!({"providers": {"EE": {
                    "baseUrl": "https://example.test/v1", "api": "openai-responses",
                    "models": [{"id": "m"}]
                }}})
                .to_string(),
            )
            .unwrap();
            fs::write(
                dir.path().join("auth.json"),
                r#"{"EE":{"type":"api_key","key":"test-only"}}"#,
            )
            .unwrap();
            fs::write(
                dir.path().join("settings.json"),
                r#"{"modelThinkingLevels":{"EE/m":"high","other/m":"low"}}"#,
            )
            .unwrap();
            let mut form = load(dir.path()).unwrap();
            form.providers[0].removed = true;
            form.providers[0].clear_credential = clear_credential;
            let saved = save(dir.path(), form).unwrap();
            assert_eq!(saved.providers.len(), usize::from(!clear_credential));
            // 保存返回的快照会重新包含保留的认证；连续保存也不能把端点写回来。
            let saved = save(dir.path(), saved).unwrap();
            save(dir.path(), saved).unwrap();
            let bytes = raw(dir.path()).unwrap();
            let models = parse(&bytes[0], "models.json").unwrap();
            let auth = parse(&bytes[1], "auth.json").unwrap();
            let settings = parse(&bytes[2], "settings.json").unwrap();
            assert!(models["providers"].get("EE").is_none());
            assert_eq!(auth.get("EE").is_none(), clear_credential);
            assert!(settings["modelThinkingLevels"].get("EE/m").is_none());
            assert_eq!(settings["modelThinkingLevels"]["other/m"], "low");
        }
    }

    #[test]
    fn saving_repairs_legacy_empty_provider_and_preserves_other_config() {
        let dir = tempfile::tempdir().unwrap();
        let other = json!({"headers": {"X-Test": "keep"}, "future": true});
        fs::write(
            dir.path().join("models.json"),
            json!({"future": true, "providers": {"EE": {}, "other": other}}).to_string(),
        )
        .unwrap();
        fs::write(
            dir.path().join("auth.json"),
            r#"{"EE":{"type":"api_key","key":"test-only"}}"#,
        )
        .unwrap();
        save(dir.path(), load(dir.path()).unwrap()).unwrap();
        let bytes = raw(dir.path()).unwrap();
        let models = parse(&bytes[0], "models.json").unwrap();
        assert!(models["providers"].get("EE").is_none());
        assert_eq!(models["providers"]["other"], other);
        assert_eq!(models["future"], true);
        assert_eq!(
            parse(&bytes[1], "auth.json").unwrap()["EE"]["key"],
            "test-only"
        );
    }

    #[test]
    fn locks_validation_and_oauth_protection() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("auth.json"),
            r#"{"openai":{"type":"oauth","access":"private","refresh":"private","expires":1}}"#,
        )
        .unwrap();
        let mut form = load(dir.path()).unwrap();
        form.providers[0].credential = CredentialChange {
            action: "replace".into(),
            value: "new-key".into(),
            confirm_replace: false,
        };
        assert!(save(dir.path(), form.clone()).is_err());
        form.providers[0].credential.confirm_replace = true;
        let form = save(dir.path(), form).unwrap();
        assert!(!serde_json::to_string(&form).unwrap().contains("new-key"));
        fs::create_dir(dir.path().join("auth.json.lock")).unwrap();
        assert_eq!(save(dir.path(), form).err().unwrap().code, "CONFIG_LOCKED");
        assert!(!dir.path().join("models.json.lock").exists());
        assert!(validate_url("https://host/prefix/v1").is_ok());
        assert!(validate_url("https://secret@host/v1").is_err());
    }
    #[test]
    fn invalid_files_and_disabled_default_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("models.json"), "broken").unwrap();
        assert!(load(dir.path()).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("models.json")).unwrap(),
            "broken"
        );
        assert_eq!(
            resolve_key("a$$b", &json!({})).unwrap().as_deref(),
            Some("a$b")
        );
        assert!(resolve_key("!echo private", &json!({})).is_err());
        fs::remove_file(dir.path().join("models.json")).unwrap();
        let mut form = load(dir.path()).unwrap();
        form.providers.push(ProviderConfig {
            id: "test".into(),
            name: None,
            base_url: Some("http://localhost:1234/v1".into()),
            api: Some("openai-responses".into()),
            credential_source: String::new(),
            credential: CredentialChange {
                action: "keep".into(),
                ..Default::default()
            },
            removed: false,
            clear_credential: false,
            models: vec![ModelConfig {
                id: "m".into(),
                override_only: false,
                values: BTreeMap::from([
                    ("reasoning".into(), json!(true)),
                    ("thinkingLevelMap".into(), json!({"max": null})),
                ]),
                default_thinking: Some("max".into()),
            }],
        });
        assert!(save(dir.path(), form.clone()).is_err());
        form.providers[0].models[0]
            .values
            .insert("thinkingLevelMap".into(), json!({"max":"max"}));
        form.providers[0].models[0]
            .values
            .insert("contextWindow".into(), json!(100));
        form.providers[0].models[0]
            .values
            .insert("maxTokens".into(), json!(101));
        assert!(save(dir.path(), form.clone()).is_err());
        form.providers[0].models[0]
            .values
            .insert("maxTokens".into(), json!(50));
        assert!(save(dir.path(), form).is_ok());
    }
}
