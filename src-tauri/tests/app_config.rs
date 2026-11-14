//! 앱 설정 · 화면 권한 고정 시험 (P10-06, D-54 · D-55) — `tauri.conf.json` 과 `capabilities/` 가 정한 값에서 벗어나면 여기서 실패한다.
//! 창 · 권한 설정은 `tauri dev` 에서는 일부만 붙으므로(CSP 는 안 붙는다) 값 자체를 파일에서 읽어 지킨다.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn read_json(relative: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    let text = fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

fn conf() -> Value {
    read_json("tauri.conf.json")
}

fn main_window(conf: &Value) -> &Value {
    let windows = conf["app"]["windows"].as_array().expect("app.windows");
    assert_eq!(windows.len(), 1, "창은 메인 하나");
    &windows[0]
}

#[test]
fn the_screen_may_only_listen_and_unlisten_to_events() {
    let capability = read_json("capabilities/default.json");
    assert_eq!(capability["identifier"], "default");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    // 화면(`src/lib/ipc.ts`)이 쓰는 Tauri API 는 `invoke`(앱 명령 — 권한 목록과 무관)와 `listen`(+ unlisten)뿐이다.
    // `core:default` 를 다시 넣으면 화면이 아무 PNG 읽기(`image:allow-from-path`) · 이벤트 꾸며 보내기 · 트레이 · 메뉴 바꾸기를 얻는다.
    assert_eq!(
        capability["permissions"],
        serde_json::json!(["core:event:allow-listen", "core:event:allow-unlisten"])
    );
    // 다른 창 · 원격 주소에는 아무것도 열지 않는다
    assert!(capability.get("remote").is_none());
    assert!(capability.get("webviews").is_none());
}

#[test]
fn there_is_only_one_capability_file() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let files: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        files,
        ["default.json"],
        "권한 파일이 늘면 이 시험의 고정이 새 파일을 놓친다"
    );
}

#[test]
fn the_csp_closes_base_uri_and_form_action_and_stays_strict() {
    let conf = conf();
    let csp = conf["app"]["security"]["csp"].as_str().expect("csp");
    let directives: Vec<&str> = csp.split(';').map(str::trim).collect();
    for wanted in [
        "default-src 'self'",
        "connect-src ipc: http://ipc.localhost",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
    ] {
        assert!(
            directives.contains(&wanted),
            "CSP 에 `{wanted}` 가 있어야 한다: {csp}"
        );
    }
    // 스크립트는 `default-src 'self'` 로 막혀 있다 — 인라인 · eval 을 열지 않는다
    assert!(!csp.contains("script-src"), "{csp}");
    assert!(!csp.contains("unsafe-eval"), "{csp}");
    // `style-src 'unsafe-inline'` 은 실제 창에서 CodeMirror 를 확인한 뒤에 뺀다 (P10-06 보고) — 지금은 그대로
    assert!(
        directives.contains(&"style-src 'self' 'unsafe-inline'"),
        "{csp}"
    );
}

#[test]
fn the_first_window_fits_a_small_laptop_work_area_and_does_not_flash_white() {
    let conf = conf();
    let window = main_window(&conf);
    assert_eq!(
        window["visible"], false,
        "window-state 가 옮긴 뒤 setup 에서 보인다"
    );
    assert_eq!(window["center"], true);
    assert_eq!(window["preventOverflow"], true);
    assert_eq!(window["minWidth"], 1024);
    assert_eq!(
        window["backgroundColor"], "#fbf8f3",
        "밝은 테마 바탕 (tokens.css 의 --color-bg) — 어두운 테마는 setup 에서 OS 테마를 읽어 바꾼다"
    );

    // 1366x768 · 배율 125%: 논리 1092.8 x 614.4, 작업 표시줄 48 논리 px 를 빼면 작업 영역 높이는 약 574.
    // 최소 높이는 안쪽(웹뷰) 높이이므로 제목 줄 · 테두리(논리 약 31 px)를 더해도 작업 영역 안이어야 한다.
    const WORK_AREA_HEIGHT: f64 = 574.0;
    const TITLE_BAR_AND_FRAME: f64 = 31.0;
    const WORK_AREA_WIDTH: f64 = 1092.0;
    let min_height = window["minHeight"].as_f64().expect("minHeight");
    let min_width = window["minWidth"].as_f64().expect("minWidth");
    assert!(
        min_height + TITLE_BAR_AND_FRAME <= WORK_AREA_HEIGHT,
        "최소 높이 {min_height} + 제목 줄 {TITLE_BAR_AND_FRAME} 이 작업 영역 {WORK_AREA_HEIGHT} 에 들어가야 한다"
    );
    assert!(min_width <= WORK_AREA_WIDTH);
    // 처음 크기는 최소보다 작을 수 없다
    assert!(window["width"].as_f64().unwrap() >= min_width);
    assert!(window["height"].as_f64().unwrap() >= min_height);
}

#[test]
fn installers_are_nsis_and_the_other_systems_not_msi() {
    let conf = conf();
    let targets = conf["bundle"]["targets"]
        .as_array()
        .expect("targets 는 목록 (\"all\" 이면 Windows 에서 MSI 도 만든다)");
    let names: Vec<&str> = targets.iter().map(|t| t.as_str().unwrap()).collect();
    assert_eq!(names, ["nsis", "dmg", "app", "appimage", "deb"]);
    assert!(!names.contains(&"msi"));
}

#[test]
fn the_app_identifier_and_data_folder_name_are_unchanged() {
    // D-10 — 개발 빌드와 설치본이 같은 데이터 폴더를 쓴다
    assert_eq!(conf()["identifier"], "io.github.nerohee.nyanitor");
}
