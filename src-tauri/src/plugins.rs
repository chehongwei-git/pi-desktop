//! 插件配置仓库：扫描不执行用户代码；版本校验和目录锁避免覆盖 CLI 的并发修改。
use crate::types::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const LIMIT: u64 = 2 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub scope: String,
    pub enabled: bool,
    pub inherited: bool,
    pub overridden: bool,
    pub problem: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub revision: String,
    pub directory: String,
    pub items: Vec<Plugin>,
    pub warnings: Vec<String>,
}
/// 只接受领域动作，不接收任意目标文件；MCP 配置仅新增时输入，已有秘密不回传。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub revision: String,
    pub kind: String,
    pub id: String,
    pub action: String,
    pub config: Option<Value>,
}
fn fail(message: &str) -> AppError {
    AppError::new("PLUGINS", message)
}
fn read(path: &Path) -> Result<Vec<u8>> {
    match fs::File::open(path) {
        Ok(file) => {
            use std::io::Read;
            let mut bytes = Vec::new();
            file.take(LIMIT + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > LIMIT {
                return Err(fail("插件文件超过 2 MiB，未读取或覆盖"));
            }
            Ok(bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}
fn document(path: &Path) -> Result<Value> {
    let bytes = read(path)?;
    if bytes.is_empty() && !path.exists() {
        return Ok(json!({}));
    }
    let value: Value =
        serde_json::from_slice(bytes.strip_prefix(&[239, 187, 191]).unwrap_or(&bytes))
            .map_err(|_| fail("插件配置不是有效 JSON，请先修复原文件；未覆盖配置"))?;
    if !value.is_object() {
        return Err(fail("插件配置须为 JSON 对象"));
    }
    Ok(value)
}
fn files(agent: &Path, project: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = vec![agent.join("settings.json"), agent.join("mcp.json")];
    if let Some(project) = project {
        paths.extend([
            project.join(".pi").join("settings.json"),
            project.join(".pi").join("mcp.json"),
        ]);
    }
    paths
}
fn revision(agent: &Path, project: Option<&Path>) -> Result<String> {
    let mut hash = Sha256::new();
    for path in files(agent, project) {
        let bytes = read(&path)?;
        hash.update([u8::from(path.exists())]);
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn paths(value: &Value, kind: &str) -> Result<Vec<String>> {
    match value.get(kind) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| fail("资源路径须为字符串"))
            })
            .collect(),
        _ => Err(fail("资源路径须为数组")),
    }
}
/// 路径统一由 Path 解析；相对接入路径以对应 settings.json 所在目录为基准。
fn resolve(base: &Path, home: &Path, input: &str) -> PathBuf {
    let path = Path::new(input);
    if path == Path::new("~") {
        home.into()
    } else if let Ok(rest) = path.strip_prefix("~") {
        home.join(rest)
    } else if path.is_absolute() {
        path.into()
    } else {
        base.join(path)
    }
}
fn resource(path: &Path, kind: &str, scope: &str) -> Plugin {
    let id = path.to_string_lossy().into_owned();
    let name = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut item = Plugin {
        id: id.clone(),
        kind: kind.into(),
        name,
        description: String::new(),
        source: id,
        scope: scope.into(),
        enabled: true,
        inherited: scope == "global",
        overridden: false,
        problem: None,
    };
    if kind == "skills" {
        let file = if path.is_dir() {
            path.join("SKILL.md")
        } else {
            path.into()
        };
        match read(&file) {
            Ok(bytes) if !bytes.is_empty() => {
                let text = String::from_utf8_lossy(&bytes);
                // 仅展示简单 frontmatter；复杂 YAML 不自作主张解释，原文在详情中可读。
                if let Some(front) = text
                    .strip_prefix("---\r\n")
                    .or_else(|| text.strip_prefix("---\n"))
                    .and_then(|s| s.split("\n---").next())
                {
                    for line in front.lines() {
                        if let Some(value) = line.strip_prefix("name:") {
                            item.name = value.trim().trim_matches(['\'', '"']).into();
                        }
                        if let Some(value) = line.strip_prefix("description:") {
                            item.description = value.trim().trim_matches(['\'', '"']).into();
                        }
                        if line.trim() == "disable-model-invocation: true" {
                            item.description.push_str(" · 仅手动调用");
                        }
                    }
                }
                if item.description.is_empty() {
                    item.problem =
                        Some("未识别到简单描述，请检查 SKILL.md；实际加载以 Pi 为准".into());
                }
            }
            _ => item.problem = Some("无法读取 SKILL.md".into()),
        }
    } else if !path.exists() {
        item.problem = Some("来源路径不存在".into());
    }
    item
}
/// 不跟随目录符号链接递归，限制层数与项目数，避免大型目录阻塞或循环。
fn scan(root: &Path, kind: &str, scope: &str, depth: usize, items: &mut Vec<Plugin>) -> Result<()> {
    if depth > 8 || items.len() >= 2000 {
        return Ok(());
    }
    if kind == "skills" && root.join("SKILL.md").is_file() {
        items.push(resource(root, kind, scope));
        return Ok(());
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut entries = entries.collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries.into_iter().take(2000) {
        let path = entry.path();
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            continue;
        }
        if kind == "skills" && ty.is_dir() {
            scan(&path, kind, scope, depth + 1, items)?;
        }
        if kind == "extensions"
            && ((ty.is_file()
                && matches!(
                    path.extension().and_then(|e| e.to_str()),
                    Some("ts" | "js" | "mjs")
                ))
                || (ty.is_dir()
                    && (path.join("index.ts").is_file() || path.join("index.js").is_file())))
        {
            items.push(resource(&path, kind, scope));
        }
    }
    Ok(())
}
fn mcp_entries(value: &Value) -> Result<Vec<(String, Value)>> {
    match value.get("mcpServers") {
        None => Ok(Vec::new()),
        Some(Value::Object(map)) => Ok(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        _ => Err(fail("mcpServers 须为对象")),
    }
}
pub fn load(agent: &Path, home: &Path, project: Option<&Path>) -> Result<Catalog> {
    let before = revision(agent, project)?;
    let global = document(&agent.join("settings.json"))?;
    let local_dir = project.map(|p| p.join(".pi"));
    let local = local_dir
        .as_ref()
        .map(|p| document(&p.join("settings.json")))
        .transpose()?
        .unwrap_or(json!({}));
    let mut items = Vec::new();
    let mut warnings =
        vec!["列表反映磁盘配置，不代表会话已加载。项目资源是否加载由 Pi 的项目信任决定。".into()];
    for (scope, dir, settings) in [("global", agent, &global)]
        .into_iter()
        .chain(local_dir.as_deref().map(|p| ("project", p, &local)))
    {
        let mcp = document(&dir.join("mcp.json"))?;
        for (name, config) in mcp_entries(&mcp)? {
            let previous = items
                .iter()
                .position(|p: &Plugin| p.kind == "mcp" && p.id == name);
            // 完整项目服务器替换全局项，只有不含连接字段的项目条目才继承状态。
            let partial = config.get("command").is_none()
                && config.get("url").is_none()
                && config.get("type").is_none();
            let inherited_enabled = if partial {
                previous.map(|i| items[i].enabled).unwrap_or(true)
            } else {
                true
            };
            let inherited_description = previous
                .map(|i| items[i].description.clone())
                .unwrap_or_default();
            if let Some(index) = previous {
                items.remove(index);
            }
            items.push(Plugin {
                id: name.clone(),
                kind: "mcp".into(),
                name,
                description: config["description"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or(inherited_description),
                source: dir.join("mcp.json").to_string_lossy().into(),
                scope: scope.into(),
                enabled: config["enabled"].as_bool().unwrap_or(inherited_enabled),
                inherited: scope == "global",
                overridden: previous.is_some(),
                problem: if !config.is_object() {
                    Some("服务器条目须为对象".into())
                } else {
                    None
                },
            });
        }
        for kind in ["skills", "extensions"] {
            scan(&dir.join(kind), kind, scope, 0, &mut items)?;
            for input in paths(settings, kind)? {
                if input.starts_with(['-', '+', '!']) || input.starts_with("builtin:") {
                    continue;
                }
                if input.contains(['*', '?']) {
                    warnings.push(format!("{kind} 含通配路径，完整解析以 Pi 为准"));
                    continue;
                }
                let path = resolve(dir, home, &input);
                if kind == "skills" && path.is_dir() {
                    scan(&path, kind, scope, 0, &mut items)?;
                } else {
                    items.push(resource(&path, kind, scope));
                }
            }
        }
        if let Some(packages) = settings.get("packages") {
            let packages = packages
                .as_array()
                .ok_or_else(|| fail("packages 须为数组"))?;
            for package in packages {
                let source = package
                    .as_str()
                    .or_else(|| package["source"].as_str())
                    .ok_or_else(|| fail("安装包缺少 source"))?;
                items.push(Plugin {
                    id: source.into(),
                    kind: "packages".into(),
                    name: source.into(),
                    description: "Pi 安装包 · 可能包含扩展、Skills、提示词和主题".into(),
                    source: source.into(),
                    scope: scope.into(),
                    enabled: true,
                    inherited: scope == "global",
                    overridden: false,
                    problem: None,
                });
            }
        }
    }
    scan(
        &home.join(".agents").join("skills"),
        "skills",
        "global",
        0,
        &mut items,
    )?;
    if let Some(project) = project {
        let mut current = Some(project);
        while let Some(dir) = current {
            scan(
                &dir.join(".agents").join("skills"),
                "skills",
                "project",
                0,
                &mut items,
            )?;
            if dir.join(".git").exists() {
                break;
            }
            current = dir.parent();
        }
    }
    for name in ["mcp", "codemode", "tool-search", "llama.cpp"] {
        items.push(Plugin {
            id: format!("builtin:{name}"),
            kind: "extensions".into(),
            name: name.into(),
            description: "Pi 内置扩展".into(),
            source: "Pi 内置".into(),
            scope: "global".into(),
            enabled: true,
            inherited: true,
            overridden: false,
            problem: None,
        });
    }
    let mut seen = BTreeSet::new();
    items.retain(|item| seen.insert((item.kind.clone(), item.id.clone(), item.scope.clone())));
    for item in &mut items {
        if ["skills", "extensions"].contains(&item.kind.as_str()) {
            for (dir, settings) in [(agent, &global)]
                .into_iter()
                .chain(local_dir.as_deref().map(|p| (p, &local)))
            {
                for filter in paths(settings, &item.kind)? {
                    let Some(sign) = filter.chars().next().filter(|s| ['+', '-'].contains(s))
                    else {
                        continue;
                    };
                    let raw = &filter[1..];
                    let id = if raw.starts_with("builtin:") {
                        raw.into()
                    } else {
                        resolve(dir, home, raw).to_string_lossy().into_owned()
                    };
                    if id == item.id {
                        item.enabled = sign == '+';
                        if local_dir.as_deref() == Some(dir) {
                            item.overridden = true;
                        }
                    }
                }
            }
        }
    }
    let mut skill_names = std::collections::BTreeMap::new();
    for item in &mut items {
        if item.kind == "skills"
            && item.enabled
            && skill_names
                .insert(item.name.clone(), item.id.clone())
                .is_some()
        {
            item.problem = Some("存在同名 Skill，实际采用顺序以 Pi 加载诊断为准".into());
        }
    }
    let after = revision(agent, project)?;
    if before != after {
        return Err(fail("扫描期间配置已被外部修改，请重新读取"));
    }
    Ok(Catalog {
        revision: after,
        directory: local_dir
            .unwrap_or_else(|| agent.into())
            .to_string_lossy()
            .into(),
        items,
        warnings,
    })
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}
fn commit(path: &Path, value: &Value) -> Result<()> {
    let dir = path.parent().ok_or_else(|| fail("配置目录不存在"))?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    if let Ok(meta) = fs::metadata(path) {
        temp.as_file().set_permissions(meta.permissions())?;
    }
    temp.write_all(&serde_json::to_vec_pretty(value).map_err(|_| fail("配置序列化失败"))?)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| AppError::from(e.error))?;
    Ok(())
}
fn validate_mcp(id: &str, config: &Value) -> Result<()> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(fail("服务器名称只支持字母、数字、下划线和连字符"));
    }
    if !config.is_object() || config["type"] == "sse" {
        return Err(fail("需要有效 MCP 配置，不支持旧版 SSE"));
    }
    let command = config["command"].as_str().filter(|s| !s.trim().is_empty());
    let url = config["url"].as_str();
    if command.is_some() == url.is_some() {
        return Err(fail("请选择本地程序或远程 URL，不能同时设置"));
    }
    if let Some(url) = url {
        let url = reqwest::Url::parse(url).map_err(|_| fail("远程地址无效"))?;
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(fail("仅支持不包含内嵌凭据的 HTTP/HTTPS 地址"));
        }
    }
    if let Some(args) = config.get("args") {
        if !args
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
        {
            return Err(fail("程序参数须为字符串数组"));
        }
    }
    Ok(())
}
/// 每次仅修改一个文件；先锁住全部参与版本校验的文件，保留未知字段及原有认证。
pub fn change(
    agent: &Path,
    home: &Path,
    project: Option<&Path>,
    change: Change,
) -> Result<Catalog> {
    if !["mcp", "skills", "extensions", "packages"].contains(&change.kind.as_str()) {
        return Err(fail("未知插件类型"));
    }
    if !["enable", "disable", "inherit", "remove", "add"].contains(&change.action.as_str()) {
        return Err(fail("未知插件操作"));
    }
    let dir = project
        .map(|p| p.join(".pi"))
        .unwrap_or_else(|| agent.into());
    let filename = if change.kind == "mcp" {
        "mcp.json"
    } else {
        "settings.json"
    };
    let mut locks = Vec::new();
    for path in files(agent, project) {
        fs::create_dir_all(path.parent().unwrap())?;
        let lock = path.with_file_name(format!(
            "{}.lock",
            path.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir(&lock).map_err(|_| fail("Pi 配置正被其他进程使用；未覆盖，请稍后重试"))?;
        locks.push(Lock(lock));
    }
    if revision(agent, project)? != change.revision {
        return Err(fail("配置已被外部修改，已保留你的输入；请重新读取后再提交"));
    }
    let catalog = load(agent, home, project)?;
    let existing = catalog
        .items
        .iter()
        .find(|p| p.kind == change.kind && p.id == change.id);
    if change.action != "add" && existing.is_none() {
        return Err(fail("插件已不在列表中，请刷新"));
    }
    let path = dir.join(filename);
    let mut value = document(&path)?;
    if change.kind == "mcp" {
        if value.get("mcpServers").is_none() {
            value["mcpServers"] = json!({});
        }
        let map = value["mcpServers"]
            .as_object_mut()
            .ok_or_else(|| fail("mcpServers 须为对象"))?;
        match change.action.as_str() {
            "add" => {
                let config = change.config.ok_or_else(|| fail("缺少服务器配置"))?;
                validate_mcp(&change.id, &config)?;
                if catalog.items.iter().any(|p| {
                    p.kind == "mcp" && p.id.replace('-', "_") == change.id.replace('-', "_")
                }) {
                    return Err(fail("同名或规范化后同名服务器已存在，请使用其他名称"));
                }
                map.insert(change.id, config);
            }
            "remove" => {
                if existing.is_some_and(|p| p.inherited && project.is_some()) {
                    return Err(fail("继承服务器只能在此项目停用，不能移除全局配置"));
                }
                map.remove(&change.id);
            }
            "inherit" => {
                if project.is_none() {
                    return Err(fail("只有项目配置可以恢复继承"));
                }
                let entry = map
                    .get_mut(&change.id)
                    .ok_or_else(|| fail("没有项目覆盖"))?;
                if let Some(entry) = entry.as_object_mut() {
                    for key in ["enabled", "exposure", "toolExposure"] {
                        entry.remove(key);
                    }
                    if entry.is_empty() {
                        map.remove(&change.id);
                    }
                }
            }
            _ => {
                let entry = map.entry(change.id).or_insert(json!({}));
                if !entry.is_object() {
                    return Err(fail("服务器配置无效，请先修复原文件"));
                }
                entry["enabled"] = json!(change.action == "enable");
            }
        }
    } else {
        let mut entries = paths(&value, &change.kind).or_else(|e| {
            if change.kind == "packages" {
                Ok(Vec::new())
            } else {
                Err(e)
            }
        })?;
        if change.kind == "packages" {
            // 安装包删除保留其他包的对象配置，且不触碰安装目录或源码。
            if change.action != "remove" {
                return Err(fail("安装包请使用来源安装流程；启停应针对包内资源"));
            }
            if project.is_some() && existing.is_some_and(|p| p.scope == "global") {
                return Err(fail("请切换全局范围移除安装包"));
            }
            if let Some(array) = value["packages"].as_array_mut() {
                array.retain(|p| p.as_str().or_else(|| p["source"].as_str()) != Some(&change.id));
            }
        } else {
            entries.retain(|p| {
                // 原始接入声明必须保留；移除它会让目录外资源在下次扫描时消失。
                if !p.starts_with(['+', '-']) {
                    return true;
                }
                let raw = p.strip_prefix(['+', '-']).unwrap_or(p);
                let id = if raw.starts_with("builtin:") {
                    raw.into()
                } else {
                    resolve(&dir, home, raw).to_string_lossy().into_owned()
                };
                id != change.id
            });
            match change.action.as_str() {
                "enable" | "disable" => entries.push(format!(
                    "{}{}",
                    if change.action == "enable" { '+' } else { '-' },
                    change.id
                )),
                "add" => {
                    let source = resolve(&dir, home, &change.id);
                    if !Path::new(&change.id).is_absolute() || !source.exists() {
                        return Err(fail("请填写存在的本地绝对路径"));
                    }
                    if change.kind == "skills" && !source.join("SKILL.md").is_file() {
                        return Err(fail("请选择包含 SKILL.md 的目录"));
                    }
                    if existing.is_some() {
                        return Err(fail("资源已接入，请勿重复添加"));
                    }
                    entries.push(source.to_string_lossy().into());
                }
                "inherit" if project.is_some() => (),
                _ => return Err(fail("资源不会删除源码；请使用停用或恢复继承")),
            }
            value[&change.kind] = json!(entries);
        }
    }
    commit(&path, &value)?;
    drop(locks);
    load(agent, home, project)
}
/// 详情重新通过目录发现验证身份，不开放任意文件读取，也不返回 MCP 密钥。
pub fn detail(
    agent: &Path,
    home: &Path,
    project: Option<&Path>,
    kind: &str,
    id: &str,
) -> Result<String> {
    let catalog = load(agent, home, project)?;
    let item = catalog
        .items
        .iter()
        .find(|p| p.kind == kind && p.id == id)
        .ok_or_else(|| fail("资源已不存在，请刷新"))?;
    if kind == "skills" {
        let path = Path::new(&item.id);
        let file = if path.is_dir() {
            path.join("SKILL.md")
        } else {
            path.into()
        };
        return Ok(String::from_utf8_lossy(&read(&file)?).into_owned());
    }
    Ok(if kind == "mcp" {
        "配置已保存在所示来源文件中。为保护凭据，此页不回传 command、args、env、headers 或完整 URL；连接状态请通过显式诊断检查。".into()
    } else {
        "仅展示配置接入信息。扩展可使用 Pi 进程的系统权限；静态扫描不会运行代码，也不推测它注册的命令、工具或权限。".into()
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn edit(
        dir: &Path,
        home: &Path,
        project: Option<&Path>,
        kind: &str,
        id: &str,
        action: &str,
        config: Option<Value>,
    ) -> Result<Catalog> {
        change(
            dir,
            home,
            project,
            Change {
                revision: revision(dir, project)?,
                kind: kind.into(),
                id: id.into(),
                action: action.into(),
                config,
            },
        )
    }
    #[test]
    fn mcp_override_preserves_secrets_and_unknown_fields() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("agent");
        let project = home.path().join("project");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("mcp.json"), r#"{"extra":42,"mcpServers":{"docs":{"url":"https://example.test/mcp","headers":{"Authorization":"secret"}}}}"#).unwrap();
        let result = edit(
            &dir,
            home.path(),
            Some(&project),
            "mcp",
            "docs",
            "disable",
            None,
        )
        .unwrap();
        assert!(
            !result
                .items
                .iter()
                .find(|p| p.id == "docs")
                .unwrap()
                .enabled
        );
        assert!(!serde_json::to_string(&result).unwrap().contains("secret"));
        assert_eq!(document(&dir.join("mcp.json")).unwrap()["extra"], 42);
        assert_eq!(
            document(&project.join(".pi/mcp.json")).unwrap()["mcpServers"]["docs"],
            json!({"enabled":false})
        );
        let restored = edit(
            &dir,
            home.path(),
            Some(&project),
            "mcp",
            "docs",
            "inherit",
            None,
        )
        .unwrap();
        assert!(
            restored
                .items
                .iter()
                .find(|p| p.id == "docs")
                .unwrap()
                .enabled
        );
    }
    #[test]
    fn stale_revision_locks_and_invalid_json_never_overwrite() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("agent");
        fs::create_dir_all(&dir).unwrap();
        let revision = revision(&dir, None).unwrap();
        fs::write(dir.join("settings.json"), "{\"other\":1}").unwrap();
        assert!(change(
            &dir,
            home.path(),
            None,
            Change {
                revision,
                kind: "mcp".into(),
                id: "x".into(),
                action: "add".into(),
                config: Some(json!({"url":"https://example.test"}))
            }
        )
        .is_err());
        fs::create_dir(dir.join("mcp.json.lock")).unwrap();
        assert!(edit(
            &dir,
            home.path(),
            None,
            "mcp",
            "x",
            "add",
            Some(json!({"url":"https://example.test"}))
        )
        .is_err());
        fs::remove_dir(dir.join("mcp.json.lock")).unwrap();
        fs::write(dir.join("mcp.json"), "{").unwrap();
        assert!(load(&dir, home.path(), None).is_err());
        assert_eq!(fs::read_to_string(dir.join("mcp.json")).unwrap(), "{");
    }
    #[test]
    fn skills_disable_does_not_modify_source() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("agent");
        // 分段拼接以匹配目录扫描返回的原生路径，避免 Windows 混用分隔符导致 ID 不一致。
        let skill = dir.join("skills").join("review");
        fs::create_dir_all(&skill).unwrap();
        let content = "---\nname: review\ndescription: Review code\n---\n# Instructions";
        fs::write(skill.join("SKILL.md"), content).unwrap();
        let result = edit(
            &dir,
            home.path(),
            None,
            "skills",
            &skill.to_string_lossy(),
            "disable",
            None,
        )
        .unwrap();
        assert!(
            !result
                .items
                .iter()
                .find(|p| p.name == "review")
                .unwrap()
                .enabled
        );
        assert_eq!(fs::read_to_string(skill.join("SKILL.md")).unwrap(), content);
        assert!(detail(&dir, home.path(), None, "skills", "unknown").is_err());
    }
    #[test]
    fn external_resource_declaration_survives_toggle() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("agent");
        let skill = home.path().join("external-skill");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: external\ndescription: External skill\n---\nInstructions",
        )
        .unwrap();
        let id = skill.to_string_lossy();
        edit(&dir, home.path(), None, "skills", &id, "add", None).unwrap();
        let disabled = edit(&dir, home.path(), None, "skills", &id, "disable", None).unwrap();
        assert!(
            !disabled
                .items
                .iter()
                .find(|p| p.name == "external")
                .unwrap()
                .enabled
        );
        let enabled = edit(&dir, home.path(), None, "skills", &id, "enable", None).unwrap();
        assert!(
            enabled
                .items
                .iter()
                .find(|p| p.name == "external")
                .unwrap()
                .enabled
        );
        assert!(document(&dir.join("settings.json")).unwrap()["skills"]
            .as_array()
            .unwrap()
            .contains(&json!(id)));
    }
    #[test]
    fn invalid_mcp_and_colliding_names_rejected() {
        assert!(validate_mcp("a b", &json!({"url":"https://example.test"})).is_err());
        assert!(validate_mcp("a", &json!({"type":"sse","url":"https://example.test"})).is_err());
        assert!(validate_mcp("a", &json!({"command":"node","args":[1]})).is_err());
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("agent");
        edit(
            &dir,
            home.path(),
            None,
            "mcp",
            "a-b",
            "add",
            Some(json!({"url":"https://example.test"})),
        )
        .unwrap();
        assert!(edit(
            &dir,
            home.path(),
            None,
            "mcp",
            "a_b",
            "add",
            Some(json!({"url":"https://example.test"}))
        )
        .is_err());
    }
}
