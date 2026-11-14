// 시험 폴더의 앱 DB 에 프로젝트 줄을 넣는다 — 프로젝트 고르기는 OS 폴더 대화상자라 E2E 로 못 누른다.
// Node 24 내장 `node:sqlite` (의존성 없음). 구조는 앱이 첫 실행에서 만든 것 (`src-tauri/src/db/migrations.rs`).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sandbox } from "./ui.ts";

/** `claude::store::project_key` (Windows) 와 같은 뜻 — 구분자 `\` · 겹침 · 끝 구분자 없이 · 소문자 */
function projectKey(dir: string): string {
  return dir
    .replaceAll("/", "\\")
    .split("\\")
    .filter((part) => part !== "" && part !== ".")
    .join("\\")
    .toLowerCase();
}

export interface SeedProject {
  id: number;
  name: string;
  dir: string;
}

/** 프로젝트 폴더를 만들고 (`files` 는 폴더 안 상대 경로 → 내용) DB 에 올린다. 앱이 DB 를 열고 있어도 된다 (SQLite). */
export function seedProject(name: string, files: Record<string, string> = {}, skill: string | null = null): SeedProject {
  const dir = path.join(sandbox.projects, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const db = new DatabaseSync(path.join(sandbox.data, "nyanitor.db"));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const now = Math.floor(Date.now() / 1000);
    const result = db
      .prepare("INSERT INTO projects (path, path_key, name, skill, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(dir, projectKey(dir), name, skill, now, now);
    return { id: Number(result.lastInsertRowid), name, dir };
  } finally {
    db.close();
  }
}
