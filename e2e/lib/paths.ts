// 저장소 안의 위치들 — E2E 가 쓰는 실행 파일 · 시험 자료.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TAURI_DIR = path.join(REPO, "src-tauri");
/** 개발 빌드 앱 (`tauri build --debug --no-bundle`) — 격리 변수는 개발 빌드에서만 먹는다 */
export const APP_EXE = path.join(TAURI_DIR, "target", "debug", "nyanitor.exe");
/** 가짜 CLI (`cargo build --example fake_claude`) */
export const FAKE_CLAUDE_EXE = path.join(TAURI_DIR, "target", "debug", "examples", "fake_claude.exe");
export const CLI_FIXTURES = path.join(TAURI_DIR, "tests", "fixtures", "cli");
export const TAURI_DRIVER = path.join(process.env.USERPROFILE ?? "", ".cargo", "bin", "tauri-driver.exe");
export const EDGE_DRIVER = path.join(REPO, "msedgedriver.exe");
export const SPECS_DIR = path.join(REPO, "e2e", "specs");
