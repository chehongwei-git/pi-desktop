// Tauri 构建脚本只生成平台资源；业务与协议逻辑位于库中，便于独立测试。
fn main() {
    tauri_build::build()
}
