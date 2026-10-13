use serde::Serialize;

use crate::error::AppError;

/// 화면 머리말에 보이는 앱 이름과 버전.
#[derive(Debug, PartialEq, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

/// 값 만드는 로직. 이름이나 버전이 비면 설정이 깨진 것이므로 오류로 알린다.
pub fn build_app_info(name: &str, version: &str) -> Result<AppInfo, AppError> {
    let name = name.trim();
    let version = version.trim();
    if name.is_empty() || version.is_empty() {
        return Err(AppError::Internal(
            "app name or version is empty in the package info".into(),
        ));
    }
    Ok(AppInfo {
        name: name.to_string(),
        version: version.to_string(),
    })
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> Result<AppInfo, AppError> {
    let info = app.package_info();
    build_app_info(&info.name, &info.version.to_string()).map_err(AppError::logged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_info_from_name_and_version() {
        let info = build_app_info("Nyanitor", "0.1.0").unwrap();
        assert_eq!(
            info,
            AppInfo {
                name: "Nyanitor".into(),
                version: "0.1.0".into()
            }
        );
    }

    #[test]
    fn rejects_empty_or_blank_parts() {
        for (name, version) in [("", "0.1.0"), ("Nyanitor", ""), ("  ", "0.1.0")] {
            let err = build_app_info(name, version).unwrap_err();
            assert_eq!(err.kind(), "internal");
        }
    }

    #[test]
    fn info_serializes_with_name_and_version_keys() {
        let value = serde_json::to_value(build_app_info("Nyanitor", "0.1.0").unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "name": "Nyanitor", "version": "0.1.0" })
        );
    }
}
