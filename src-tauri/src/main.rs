#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutoLaunchExt};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 走系统 shell 打开文件/文件夹，等价于在资源管理器里双击，不再借助 explorer 命令行。
#[cfg(windows)]
mod win_shell {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> *mut core::ffi::c_void;
    }

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// verb 一般传 "open"。ShellExecuteW 返回值大于 32 才算成功。
    pub fn open(path: &Path, verb: &str) -> bool {
        let file = wide(path.as_os_str());
        let op = wide(OsStr::new(verb));
        let r = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        r as isize > 32
    }

}

struct AppState {
    data_dir: Mutex<PathBuf>,
    config_dir: PathBuf,
    /// 单实例锁文件。进程存活期间一直持有，进程一退出由系统自动释放。
    _instance: File,
}

fn lock_err<T>(r: Result<T, std::sync::PoisonError<T>>) -> Result<T, String> {
    r.map_err(|_| "内部状态锁失败".to_string())
}

fn norm(p: &Path) -> String {
    p.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// 红线：C 盘一律不落数据。
fn on_c_drive(p: &Path) -> bool {
    norm(p).starts_with("c:")
}

/// 程序自身所在目录。数据、配置、缓存全部放在它下面，绝不去 C 盘。
fn base_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 系统通知用的 AppUserModelID。便携版没有安装包，必须在 HKCU 里自行登记一条，
/// 否则 Windows 不认这个来源，toast 可能直接不显示。
#[cfg(windows)]
const TOAST_APP_ID: &str = "com.buyaowang.memo";

#[cfg(windows)]
fn ensure_toast_app_id() {
    use windows_registry::CURRENT_USER;
    let path = format!(r"SOFTWARE\Classes\AppUserModelId\{TOAST_APP_ID}");
    if let Ok(key) = CURRENT_USER.create(&path) {
        let _ = key.set_string("DisplayName", "不许忘！");
        let _ = key.set_string("IconBackgroundColor", "0");
    }
}

/// 单实例锁：独占锁定配置文件。抢不到说明已经有实例在跑。
fn acquire_instance(config_dir: &Path) -> Option<File> {
    let _ = std::fs::create_dir_all(config_dir);
    let f = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(config_dir.join("单实例.lock"))
        .ok()?;
    f.try_lock().ok().map(|_| f)
}

fn geom_file() -> PathBuf {
    base_dir().join("配置").join("窗口.json")
}

/// 记录窗口位置与大小。最大化时只记标记，保留还原后的尺寸。
fn save_geom(window: &tauri::WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let mut v = std::fs::read_to_string(geom_file())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    v["max"] = serde_json::json!(maximized);
    if !maximized {
        if let Ok(p) = window.outer_position() {
            v["x"] = serde_json::json!(p.x);
            v["y"] = serde_json::json!(p.y);
        }
        if let Ok(s) = window.inner_size() {
            v["w"] = serde_json::json!(s.width);
            v["h"] = serde_json::json!(s.height);
        }
    }
    let _ = std::fs::create_dir_all(base_dir().join("配置"));
    let _ = std::fs::write(geom_file(), v.to_string());
}

/// 还原前先确认窗口至少有可见的一块落在某块屏幕上，免得换显示器后窗口跑到屏幕外。
fn on_some_monitor(
    window: &tauri::WebviewWindow,
    pos: PhysicalPosition<i32>,
    w: u32,
    h: u32,
) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    for m in monitors {
        let mp = m.position();
        let ms = m.size();
        let ox = (pos.x + w as i32).min(mp.x + ms.width as i32) - pos.x.max(mp.x);
        let oy = (pos.y + h as i32).min(mp.y + ms.height as i32) - pos.y.max(mp.y);
        if ox >= 120 && oy >= 60 {
            return true;
        }
    }
    false
}

fn restore_geom(window: &tauri::WebviewWindow) {
    let Ok(raw) = std::fs::read_to_string(geom_file()) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let w = v.get("w").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let h = v.get("h").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    if w >= 600 && h >= 420 {
        let _ = window.set_size(PhysicalSize::new(w, h));
    }
    let px = v.get("x").and_then(|x| x.as_i64());
    let py = v.get("y").and_then(|x| x.as_i64());
    if let (Some(x), Some(y)) = (px, py) {
        let pos = PhysicalPosition::new(x as i32, y as i32);
        if on_some_monitor(window, pos, w.max(600), h.max(420)) {
            let _ = window.set_position(pos);
        }
    }
    if v.get("max").and_then(|x| x.as_bool()).unwrap_or(false) {
        let _ = window.maximize();
    }
}

/// 只允许访问数据目录内部的相对路径，防止前端借 `..` 或绝对路径越权。
fn resolve(state: &AppState, path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let raw = PathBuf::from(path);
    for c in raw.components() {
        match c {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => return Err("路径不合法".to_string()),
            _ => {}
        }
    }
    let root = lock_err(state.data_dir.lock())?.clone();
    let abs = root.join(&raw);
    let nr = norm(&root);
    let na = norm(&abs);
    if na != nr && !na.starts_with(&format!("{nr}\\")) {
        return Err("路径不在数据目录内".to_string());
    }
    Ok(abs)
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(from, to).map(|_| ())
    }
}

/// 跨盘符时 rename 会失败，退化成复制再删除。
fn move_entry(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_recursive(from, to)?;
    if from.is_dir() {
        std::fs::remove_dir_all(from)
    } else {
        std::fs::remove_file(from)
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn get_data_dir(state: State<AppState>) -> String {
    state
        .data_dir
        .lock()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn set_data_dir(state: State<AppState>, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if on_c_drive(&p) {
        return Err("数据目录不能放在 C 盘".to_string());
    }
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    *lock_err(state.data_dir.lock())? = p.clone();
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn read_text(state: State<AppState>, path: String) -> Result<String, String> {
    let p = resolve(&state, &path)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_text(state: State<AppState>, path: String, contents: String) -> Result<(), String> {
    let p = resolve(&state, &path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, contents).map_err(|e| e.to_string())
}

/// 分片写入：大视频经 base64 传输时分多次 IPC，避免单次负载过大。
#[tauri::command]
fn write_bytes(
    state: State<AppState>,
    path: String,
    b64: String,
    first: Option<bool>,
) -> Result<(), String> {
    let p = resolve(&state, &path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = STANDARD.decode(b64.as_bytes()).map_err(|e| e.to_string())?;
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true);
    if first.unwrap_or(true) {
        opts.truncate(true);
    } else {
        opts.append(true);
    }
    let mut f = opts.open(&p).map_err(|e| e.to_string())?;
    f.write_all(&data).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_media_b64(state: State<AppState>, path: String) -> Result<String, String> {
    let p = resolve(&state, &path)?;
    let data = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(data))
}

/// 剪贴板里指向本地文件的图片（聊天软件复制「文字+图片」时常见）没法用
/// 普通路径读进来，这里按用户粘贴动作给的源路径复制一份到条目的媒体目录。
/// 仍然只允许「外部文件 → 数据目录」这一个方向：目标路径照旧走数据目录沙箱，
/// 源文件必须能认出是图片（按后缀或文件头判断），且不超过 200MB。
#[tauri::command]
fn import_media_from_path(
    state: State<AppState>,
    source: String,
    dest: String,
) -> Result<(), String> {
    let src = PathBuf::from(&source);
    if !src.is_file() {
        return Err("源文件不存在".to_string());
    }
    let md = std::fs::metadata(&src).map_err(|e| e.to_string())?;
    if md.len() > 200 * 1024 * 1024 {
        return Err("文件超过 200MB".to_string());
    }
    if !is_media_source(&src) {
        return Err("不是可识别的图片或媒体文件".to_string());
    }
    let d = resolve(&state, &dest)?;
    if let Some(parent) = d.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &d).map_err(|e| e.to_string())?;
    Ok(())
}

/// 后缀在白名单里就算媒体；没有后缀（剪贴板临时图常见）则按文件头认图片。
fn is_media_source(src: &Path) -> bool {
    const EXT: [&str; 25] = [
        "png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "avif", "svg", "ico", "mp4", "webm",
        "mov", "mkv", "avi", "m4v", "wmv", "flv", "mp3", "wav", "m4a", "flac", "ogg", "aac",
        "opus",
    ];
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if EXT.contains(&ext.as_str()) {
        return true;
    }
    let Ok(mut f) = File::open(src) else {
        return false;
    };
    let mut head = [0u8; 16];
    let n = f.read(&mut head).unwrap_or(0);
    let h = &head[..n];
    h.starts_with(&[0x89, b'P', b'N', b'G'])
        || h.starts_with(&[0xFF, 0xD8, 0xFF])
        || h.starts_with(b"GIF8")
        || h.starts_with(b"BM")
        || h.starts_with(&[0x49, 0x49, 0x2A, 0x00])
        || h.starts_with(&[0x4D, 0x4D, 0x00, 0x2A])
        || (h.len() >= 12 && &h[0..4] == b"RIFF" && &h[8..12] == b"WEBP")
}

/// 切换数据目录：目标目录为空则把现有数据整体搬过去，否则只切换不搬。
#[tauri::command]
fn migrate_data_dir(
    state: State<AppState>,
    path: String,
) -> Result<serde_json::Value, String> {
    let target = PathBuf::from(&path);
    if on_c_drive(&target) {
        return Err("数据目录不能放在 C 盘".to_string());
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let cur = lock_err(state.data_dir.lock())?.clone();
    if norm(&target) == norm(&cur) {
        return Ok(serde_json::json!({ "changed": false, "moved": 0, "targetEmpty": true }));
    }
    let names: Vec<String> = std::fs::read_dir(&target)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .collect();
    let target_empty = names.is_empty();
    let mut moved = 0;
    if target_empty {
        for name in ["索引.json", "条目", "回收站"] {
            let from = cur.join(name);
            if from.exists() {
                move_entry(&from, &target.join(name)).map_err(|e| e.to_string())?;
                moved += 1;
            }
        }
    }
    *lock_err(state.data_dir.lock())? = target.clone();
    Ok(serde_json::json!({ "changed": true, "moved": moved, "targetEmpty": target_empty }))
}

#[tauri::command]
fn path_exists(state: State<AppState>, path: String) -> bool {
    resolve(&state, &path).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
fn list_dir(state: State<AppState>, path: String) -> Result<Vec<String>, String> {
    let p = resolve(&state, &path)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&p).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        out.push(entry.file_name().to_string_lossy().to_string());
    }
    Ok(out)
}

#[tauri::command]
fn mkdir(state: State<AppState>, path: String) -> Result<(), String> {
    let p = resolve(&state, &path)?;
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_path(state: State<AppState>, path: String) -> Result<(), String> {
    let p = resolve(&state, &path)?;
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn rename_path(state: State<AppState>, from: String, to: String) -> Result<(), String> {
    let f = resolve(&state, &from)?;
    let t = resolve(&state, &to)?;
    if let Some(parent) = t.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&f, &t).map_err(|e| e.to_string())
}

/// 打开文件所在的文件夹；传空串则打开数据目录本身。
///
/// 直接让系统 shell 打开「所在目录」这一层，不交给 explorer 解析 /select, 参数——
/// explorer 认不出那个开关时会退回默认的「文档」目录，落不到图片真正存放的位置。
#[tauri::command]
fn reveal(state: State<AppState>, path: String) -> Result<(), String> {
    let target = if path.trim().is_empty() {
        lock_err(state.data_dir.lock())?.clone()
    } else {
        resolve(&state, &path)?
    };
    if !target.exists() {
        return Err("路径不存在".to_string());
    }
    #[cfg(windows)]
    {
        let dir = if target.is_dir() {
            target.clone()
        } else {
            target
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| target.clone())
        };
        if win_shell::open(&dir, "open") {
            Ok(())
        } else {
            Err("打不开这个文件夹".to_string())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Ok(())
    }
}

#[tauri::command]
fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().map(|f| f.to_string())
}

#[tauri::command]
fn read_settings(state: State<AppState>) -> String {
    std::fs::read_to_string(state.config_dir.join("settings.json")).unwrap_or_else(|_| "{}".into())
}

#[tauri::command]
fn write_settings(state: State<AppState>, contents: String) -> Result<(), String> {
    std::fs::create_dir_all(&state.config_dir).map_err(|e| e.to_string())?;
    std::fs::write(state.config_dir.join("settings.json"), contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if on {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn register_shortcut(app: AppHandle, accel: String) -> Result<(), String> {
    let sc: Shortcut = accel.parse().map_err(|_| "快捷键格式无法识别".to_string())?;
    let _ = app.global_shortcut().unregister_all();
    app.global_shortcut().register(sc).map_err(|e| e.to_string())
}

#[tauri::command]
fn win_minimize(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command]
fn win_toggle_max(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize();
        } else {
            let _ = w.maximize();
        }
    }
}

#[tauri::command]
fn win_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 提醒到点时把窗口拉回前台（可能被最小化或收进托盘）。
#[tauri::command]
fn win_show(app: AppHandle) {
    show_main(&app);
}

/// 发一条 Windows 系统通知（右下角通知中心）。
/// Reminder 场景会被系统当作优先通知处理，能穿过「请勿打扰」显示横幅。
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Duration as ToastDuration, Scenario, Toast};
        let handle = app.clone();
        Toast::new(TOAST_APP_ID)
            .title(&title)
            .text1(&body)
            .duration(ToastDuration::Long)
            .scenario(Scenario::Reminder)
            .on_activated(move |_| {
                show_main(&handle);
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body);
        Ok(())
    }
}

/// 彻底退出：先把窗口位置大小记下来，再结束进程。
#[tauri::command]
fn win_exit(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        save_geom(&w);
    }
    app.exit(0);
}

/// 界面大小恢复默认：清掉记住的位置，回到 940×640 并居中。
#[tauri::command]
fn reset_window_geometry(app: AppHandle) -> Result<(), String> {
    let _ = std::fs::remove_file(geom_file());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unmaximize();
        let _ = w.set_size(LogicalSize::new(940.0, 640.0));
        let _ = w.center();
    }
    Ok(())
}

/// 用系统默认程序打开原图/原文件，不做任何转码。
#[tauri::command]
fn open_path(state: State<AppState>, path: String) -> Result<(), String> {
    let p = resolve(&state, &path)?;
    if !p.exists() {
        return Err("文件不存在".to_string());
    }
    #[cfg(windows)]
    {
        if win_shell::open(&p, "open") {
            Ok(())
        } else {
            Err("系统里没有能打开它的程序".to_string())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        Ok(())
    }
}

/// 前端启动完成后调用一次，把记住的位置、大小再落实一遍。
#[tauri::command]
fn apply_window_geometry(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        restore_geom(&w);
    }
}

fn main() {
    #[cfg(windows)]
    ensure_toast_app_id();

    let base = base_dir();
    let config_dir = base.join("配置");

    // 同一时间只允许一个实例。抢不到锁说明已有实例在跑：
    // 给它留一个唤醒标记（它会把自己的窗口弹出来），然后本进程直接退出。
    let Some(instance) = acquire_instance(&config_dir) else {
        let _ = std::fs::write(config_dir.join("唤醒.flg"), b"1");
        return;
    };
    // 抢到锁就立刻清掉上一次残留的唤醒标记，缩小「标记被误删」的窗口，
    // 也避免开机静默启动时被旧标记误弹出。
    let _ = std::fs::remove_file(config_dir.join("唤醒.flg"));

    // 红线：WebView2 的缓存目录显式指到程序所在目录，避免落到 C 盘。
    let wv_cache = base.join("缓存").join("WebView2");
    let _ = std::fs::create_dir_all(&wv_cache);
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &wv_cache);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .setup(move |app| {
            let config_dir = config_dir.clone();
            let _ = std::fs::create_dir_all(&config_dir);
            let settings =
                std::fs::read_to_string(config_dir.join("settings.json")).unwrap_or_else(|_| "{}".into());
            let data_dir = serde_json::from_str::<serde_json::Value>(&settings)
                .ok()
                .and_then(|v| v.get("dataDir").and_then(|d| d.as_str()).map(PathBuf::from))
                .filter(|p| !on_c_drive(p))
                .unwrap_or_else(|| base_dir().join("数据"));
            let _ = std::fs::create_dir_all(&data_dir);

            app.manage(AppState {
                data_dir: Mutex::new(data_dir),
                config_dir: config_dir.clone(),
                _instance: instance,
            });

            // 位置与大小留到事件循环启动后（Ready）再还原，见文件末尾。
            let win = app
                .get_webview_window("main")
                .ok_or("主窗口不存在")?;

            // 拖动/缩放过程中节流记录，避免频繁写盘。
            // on_window_event 只接受 Fn 闭包，所以用 Mutex 承载可变的节流时间戳。
            let ev_win = win.clone();
            let last = Mutex::new(Instant::now() - Duration::from_secs(1));
            win.on_window_event(move |ev| {
                if matches!(ev, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                    let Ok(mut t) = last.lock() else { return };
                    if t.elapsed() >= Duration::from_millis(600) {
                        *t = Instant::now();
                        drop(t);
                        save_geom(&ev_win);
                    }
                }
            });

            // 第二个实例启动时会留下唤醒标记，这里轮询到就把窗口弹回前台。
            let wake_app = app.handle().clone();
            let wake_dir = config_dir.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                let flag = wake_dir.join("唤醒.flg");
                if flag.exists() {
                    let _ = std::fs::remove_file(&flag);
                    show_main(&wake_app);
                }
            });

            let show_item = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("不许忘！")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => {
                        if let Some(w) = app.get_webview_window("main") {
                            save_geom(&w);
                        }
                        app.exit(0);
                    }
                    "show" => show_main(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let handle = app.handle().clone();
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |_app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            show_main(&handle);
                        }
                    })
                    .build(),
            )?;
            if let Ok(sc) = "Ctrl+Alt+Space".parse::<Shortcut>() {
                let _ = app.global_shortcut().register(sc);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data_dir,
            set_data_dir,
            read_text,
            write_text,
            write_bytes,
            read_media_b64,
            import_media_from_path,
            migrate_data_dir,
            path_exists,
            list_dir,
            mkdir,
            remove_path,
            rename_path,
            reveal,
            pick_folder,
            read_settings,
            write_settings,
            set_autostart,
            register_shortcut,
            win_minimize,
            win_toggle_max,
            win_hide,
            win_show,
            notify,
            win_exit,
            reset_window_geometry,
            apply_window_geometry,
            open_path
        ])
        .build(tauri::generate_context!())
        .expect("启动失败");

    // 还原窗口几何必须等事件循环跑起来（Ready）才生效：
    // 在 setup 阶段设置的位置/大小会被系统随后按配置覆盖，表现为「位置记住了、大小没记住」。
    let hidden = std::env::args().any(|a| a == "--hidden");
    app.run(move |app_handle, event| {
        if matches!(event, tauri::RunEvent::Ready) {
            if let Some(w) = app_handle.get_webview_window("main") {
                restore_geom(&w);
            }
            if !hidden {
                show_main(app_handle);
            }
        }
    });
}
