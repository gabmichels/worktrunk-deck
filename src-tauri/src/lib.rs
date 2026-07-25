mod commands;
mod config;
mod error;
mod external;
mod git;
mod gitwt;
mod process;
mod pty;

use std::sync::Arc;

pub use error::{DeckError, DeckResult};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry = Arc::new(pty::PtyRegistry::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::clone(&registry))
        .setup(|app| {
            if cfg!(debug_assertions) {
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
            commands::create_worktree,
            commands::merge_worktree,
            commands::remove_worktree,
            commands::list_commits,
            commands::open_in_editor,
            commands::open_url,
            commands::run_external,
            commands::pty_open,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_session_count,
        ])
        .build(tauri::generate_context!())
        .expect("error while building worktrunk-deck")
        .run(move |_app, event| {
            // Terminal sessions must not outlive the window that started them (REQ-7).
            // `Exit` fires once the app is committed to shutting down; killing here means a
            // dev server started in the deck dies with it instead of holding its port and
            // leaving the user hunting for an orphaned process (TASK-17).
            if let tauri::RunEvent::Exit = event {
                let killed = pty::kill_all(&registry);
                if killed > 0 {
                    log::info!("killed {killed} terminal session(s) on exit");
                }
            }
        });
}
