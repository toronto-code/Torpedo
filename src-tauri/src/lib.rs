use std::fs;
use tauri::Manager;

#[tauri::command]
fn export_text(
    app: tauri::AppHandle,
    file_name: String,
    contents: String,
) -> Result<String, String> {
    let safe_name: String = file_name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || ['-', '_', '.'].contains(character))
        .collect();
    if safe_name.is_empty() || safe_name == "." || safe_name == ".." {
        return Err("invalid export file name".to_string());
    }
    let documents = app.path().document_dir().map_err(|error| error.to_string())?;
    let export_directory = documents.join("Guidance Estimation Laboratory");
    fs::create_dir_all(&export_directory).map_err(|error| error.to_string())?;
    let path = export_directory.join(safe_name);
    fs::write(&path, contents).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![export_text])
        .run(tauri::generate_context!())
        .expect("failed to run the native simulation application");
}
