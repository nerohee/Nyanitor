// 고객의 실제 데이터 폴더가 시험 전후로 그대로인지 보는 도구 — 파일마다 (크기 · 수정 시각) 을 적어 비교한다.
import fs from "node:fs";
import path from "node:path";

export const IDENTIFIER = "io.github.nerohee.nyanitor";

/** 실제 앱이 쓰는 두 폴더 (식별자로 정해진다, D-10) */
export function realDataDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, IDENTIFIER));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, IDENTIFIER));
  return dirs;
}

export type Snapshot = Map<string, string>;

function walk(dir: string, out: Snapshot): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else {
      try {
        const stat = fs.statSync(full);
        out.set(full, `${stat.size}|${stat.mtimeMs}`);
      } catch {
        // 사이에 지워졌다
      }
    }
  }
}

export function takeSnapshot(dirs: string[] = realDataDirs()): Snapshot {
  const out: Snapshot = new Map();
  for (const dir of dirs) walk(dir, out);
  return out;
}

/** 바뀐 곳 (새 파일 · 사라진 파일 · 달라진 파일) 을 글로 — 비어 있으면 그대로다. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  for (const [file, stamp] of after) {
    if (!before.has(file)) changes.push(`새 파일: ${file}`);
    else if (before.get(file) !== stamp) changes.push(`바뀜: ${file} (${before.get(file)} → ${stamp})`);
  }
  for (const file of before.keys()) if (!after.has(file)) changes.push(`사라짐: ${file}`);
  return changes;
}

export function saveSnapshot(file: string, snapshot: Snapshot): void {
  fs.writeFileSync(file, JSON.stringify([...snapshot]));
}

export function loadSnapshot(file: string): Snapshot {
  return new Map(JSON.parse(fs.readFileSync(file, "utf8")) as [string, string][]);
}
