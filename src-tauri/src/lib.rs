mod commands;
mod config;
mod error;
mod gitwt;
mod process;

pub use error::{DeckError, DeckResult};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                use tauri::Manager;
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::validate_root,
            commands::resolve_gitwt,
            commands::list_worktrees,
        ])
        .run(tauri::generate_context!())
        .expect("error while running worktrunk-deck");
}
