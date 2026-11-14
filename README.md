# Nyanitor

[claude-harness](https://github.com/nerohee/claude-harness) 를 창에서 쓰고 고치는 데스크톱 앱입니다. 에이전트는 고양이이고, 첫 화면은 고양이들이 사는 한옥 집입니다.

작업 공간에서 아이디어를 적고 오케스트레이터에게 스킬을 맡기면, 진행이 단계 보드와 일하는 고양이로 보입니다. 앱은 이 PC 에 설치된 Claude Code 를 실행할 뿐이고, 계정 · 인증 정보에는 손대지 않습니다.

> 지금은 한국어만 지원합니다. 아직 첫 출시 전입니다.

## 할 수 있는 것

- **준비 확인** — Claude Code 설치 · 로그인 · git · 하네스 상태를 보고, 빠진 것을 순서대로 안내합니다.
- **하네스 설치 · 업데이트** — 바뀌는 파일을 미리 보여 준 뒤 설치합니다. `~/.claude` 를 백업하고 되돌릴 수 있습니다.
- **고양이 집** — 에이전트마다 고양이 한 마리. 고양이를 누르면 그 에이전트의 역할 · 모델 · 수준을 보여 줍니다. Claude 사용량도 여기서 봅니다.
- **작업 공간** — 프로젝트 폴더, 요구사항 편집기(마크다운), 오케스트레이터와 채팅. 질문 · 단계 승인 · 권한 요청은 카드로 답합니다.
- **진행 보기** — 단계 보드, 일하는 고양이, 요약 로그, 프로젝트 문서.
- **내 수정** — 에이전트 · 스킬 파일 편집, 모델 · 수준 바꾸기, 새로 만들기, 기록 · 되돌리기. 하네스 원본이 업데이트돼도 내 수정은 남습니다.
- **트레이 · 알림** — 창을 닫아도 작업은 계속되고, 내가 할 일이 생겼을 때만 알립니다.

## 쓰기 전에 필요한 것

- Windows 10 · 11 (macOS · Linux 설치본은 준비 중)
- [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI — 설치하고 터미널에서 한 번 로그인해 두세요
- git

## 설치

출시 전이라 아직 설치본이 없습니다. 출시되면 [Releases](https://github.com/nerohee/Nyanitor/releases) 에 올라갑니다.

설치본에는 코드 서명이 없습니다. 그래서 처음 실행할 때 Windows 의 "Windows의 PC 보호" 창이 뜰 수 있습니다. 「추가 정보」 → 「실행」을 누르면 됩니다.

## 데이터와 개인 정보

| 무엇 | 어디에 | 앱을 지우면 |
|---|---|---|
| 프로젝트 목록 · 채팅 기록 · 사용량 · 폴더 신뢰 기록 | `%APPDATA%\io.github.nerohee.nyanitor\` (SQLite) | 남음. 제거할 때 「앱 데이터 지우기」를 고르면 지워짐 |
| 로그 · 화면 캐시 | `%LOCALAPPDATA%\io.github.nerohee.nyanitor\` | 위와 같음 |
| 하네스 원본 · 내 수정 · 백업 | `~/.claude-harness/` | 남음 — 앱 없이 터미널에서도 쓰는 곳 |
| 설치된 하네스 · Claude Code 설정 | `~/.claude/` | 남음 |

- 채팅 기록에는 도구 입력 · 성공한 도구 결과 · CLI 오류 출력을 저장하지 않습니다. 비밀값이 섞일 수 있어서입니다. DB 에서 지운 글은 파일에서도 덮어씁니다.
- 대화 전문은 Claude Code 가 스스로 `~/.claude/projects/` 에 남깁니다. 이것은 앱이 아니라 Claude Code 의 기록입니다.
- 남이 만든 폴더를 프로젝트로 등록하면, 그 폴더의 Claude Code 설정(자동 실행 명령 · 허용 규칙 · MCP 등)을 먼저 보여 주고 믿을지 묻습니다.
- 앱은 외부 서버로 아무것도 보내지 않습니다. 네트워크는 Claude Code 와 git 이 씁니다.

## 개발

필요한 것: [Rust](https://rustup.rs/) (Windows 는 MSVC 도구 모음 + Visual Studio Build Tools 의 "C++를 사용한 데스크톱 개발"), Node.js 24, WebView2 (Windows 10 최신 · 11 에는 있음). 자세한 목록은 [Tauri 의 Prerequisites](https://v2.tauri.app/start/prerequisites/) 를 보세요.

```powershell
npm install
npm run tauri dev
```

- `npm run dev` — 화면만 브라우저로 (`http://localhost:1420`). Tauri 밖에서는 가짜 데이터로 돕니다.
- 하네스 위치는 `CLAUDE_CONFIG_DIR` · `CLAUDE_HARNESS_HOME` 환경 변수로 바꿀 수 있습니다. 실제 설정을 건드리지 않고 시험할 때 씁니다.

### 검사 · 시험

```powershell
npm run check   # 타입 검사 · eslint · clippy · rustfmt
npm run test    # Vitest (화면) + cargo test (시스템 쪽, 가짜 CLI 로)
npm run e2e     # 실제 앱 창 E2E (Windows) — tauri-driver · WebdriverIO · 가짜 CLI
```

`npm run e2e` 를 돌리려면 먼저 다음이 필요합니다.

- `cargo install tauri-driver --locked`
- 이 PC 의 Edge(WebView2) 판에 맞는 `msedgedriver.exe` 를 저장소 뿌리에 둡니다. 받는 도구는 [msedgedriver-tool](https://github.com/chippers/msedgedriver-tool) 입니다.

E2E 는 시험용 임시 폴더에서 돌고, 실제 앱 데이터를 건드리지 않습니다.

### 빌드

```powershell
npm run tauri build
```

설치본은 `src-tauri/target/release/bundle/nsis/` 에 생깁니다.

## 기술

- [Tauri 2](https://v2.tauri.app/) — 화면은 Vite + React + TypeScript, 시스템 쪽은 Rust
- 상태 zustand, 편집기 CodeMirror 6, 마크다운 react-markdown + remark-gfm
- 데이터 SQLite (rusqlite)
- Claude Code 연결 — CLI 를 `stream-json` 으로 실행 (`-p --input-format stream-json --output-format stream-json`)
- 화면 권한은 이벤트 듣기 둘만 엽니다. 파일 · 프로그램 실행은 모두 Rust 명령이 정해진 범위 안에서만 합니다.

## 그림

고양이와 집 그림은 AI 로 생성했습니다 (OpenAI 이미지 API). 쓴 프롬프트와 맞춤 스크립트는 [`scripts/cat-art/`](scripts/cat-art/) 에 있습니다.

## 라이선스

출시 전에 정합니다.
