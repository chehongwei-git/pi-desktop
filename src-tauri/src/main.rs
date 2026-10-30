// Windows release 隐藏控制台；进程诊断经受限 DTO 提供给桌面界面。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    pi_desktop_lib::run();
}
