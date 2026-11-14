// 하네스 시험 복사본 — 「내 수정」 이 읽는 원본 (`<CLAUDE_HARNESS_HOME>/repo`) 을 최소로 만든다 (모양은 `src-tauri/tests/common/mod.rs` 의 `CustomRoot::new` 와 같다).
// 앱을 띄우기 전 · 뒤 어느 쪽에 만들어도 된다 (화면을 열 때 읽는다).
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./ui.ts";

const AGENT_UI = "---\nname: harness-builder-ui\ndescription: 화면 구현자\nmodel: sonnet\neffort: medium\ncolor: blue\n---\n\n너는 화면 구현자다.\n";
const AGENT_DESIGNER = "---\nname: harness-designer\ndescription: 디자이너\nmodel: opus\neffort: high\n---\n\n너는 디자이너다.\n";
const SKILL_DESKTOP = "---\nname: desktop-app\ndescription: 데스크톱 앱 만들기\n---\n\n앱을 만든다.\n";
const CONFIG_EXAMPLE = '{\n  "language": "ko",\n  "planner": {\n    "model": "opus",\n    "effort": "high"\n  },\n  "agents": {\n    "ui": "harness-builder-ui"\n  }\n}\n';

export function seedHarness(): { source: string; custom: string } {
  const source = path.join(sandbox.harnessHome, "repo");
  const files: Record<string, string> = {
    "agents/harness-builder-ui.md": AGENT_UI,
    "agents/harness-designer.md": AGENT_DESIGNER,
    "agents/_common/rules.md": "공통 규칙\n",
    "skills/desktop-app/SKILL.md": SKILL_DESKTOP,
    "config.example.json": CONFIG_EXAMPLE,
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { source, custom: path.join(sandbox.harnessHome, "custom") };
}
