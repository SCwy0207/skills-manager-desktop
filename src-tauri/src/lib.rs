mod commands;
mod db;
mod error;
mod managed;
mod models;
mod security;
mod sessions;
mod skill_descriptions;
mod skills;

use std::path::PathBuf;

use db::Database;
use tauri::Manager;

pub struct AppState {
    pub database: Database,
    pub app_data_dir: PathBuf,
    pub ai_descriptions: skill_descriptions::AiDescriptionService,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            let database = Database::open(&app_data_dir).map_err(|error| error.to_string())?;
            let ai_descriptions = skill_descriptions::AiDescriptionService::new()
                .map_err(|error| error.to_string())?;
            managed::recover_interrupted_operations(&database, &app_data_dir)
                .map_err(|error| error.to_string())?;
            app.manage(AppState {
                database,
                app_data_dir,
                ai_descriptions,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_capabilities,
            commands::list_projects,
            commands::list_audit_logs,
            commands::add_project,
            commands::remove_project,
            commands::index_sessions,
            commands::search_sessions,
            commands::get_session,
            commands::scan_skills,
            commands::scan_skill_security,
            commands::get_skill_security_scan,
            commands::get_skill,
            commands::read_skill_file,
            commands::import_skill,
            commands::remove_managed_binding,
            commands::set_skill_enabled,
            commands::write_skill_file,
            commands::get_ai_description_settings,
            commands::update_ai_description_settings,
            commands::set_ai_provider_secret,
            commands::delete_ai_provider_secret,
            commands::detect_local_ai_providers,
            commands::test_ai_description_provider,
            commands::generate_skill_description,
            commands::set_manual_skill_description,
            commands::clear_skill_description,
            commands::start_skill_description_job,
            commands::get_skill_description_job,
            commands::cancel_skill_description_job,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Skills Manager");
}

#[cfg(test)]
mod tests {
    #[test]
    fn main_window_can_close_and_destroy_itself() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json"))
                .expect("main capability must remain valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("main capability permissions must be an array");

        for required in ["core:window:allow-close", "core:window:allow-destroy"] {
            assert!(
                permissions.iter().any(|permission| permission == required),
                "main window is missing {required}"
            );
        }
    }
}
