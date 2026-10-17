# CLI 실험 도구 (cli-probe)

실제 `claude` CLI 를 `stream-json` 으로 띄워, Nyanitor 가 기대하는 주고받기(D-18)가 **지금 설치된 CLI 에서 그대로 되는지** 확인하고 녹화한다.
CLI 가 업데이트되면 같은 시나리오를 다시 돌려 `src-tauri/tests/fixtures/cli/` 의 녹화본과 비교한다.

Node 기본 모듈만 쓴다 (새 의존성 없음). Node 20 이상.

## 돌리기

```
node scripts/cli-probe/probe.mjs list                                  # 시나리오 목록 · 예상 사용량
node scripts/cli-probe/probe.mjs run two-turns permission-allow        # 골라서
node scripts/cli-probe/probe.mjs run all                               # 전부 (기본 저장: scripts/cli-probe/out/<시각>/, git 에 안 들어감)
node scripts/cli-probe/probe.mjs run all --fixtures                    # 녹화본을 src-tauri/tests/fixtures/cli/ 에 덮어쓴다 (확인한 뒤에만)
node scripts/cli-probe/probe.mjs compare src-tauri/tests/fixtures/cli scripts/cli-probe/out/<시각>
node scripts/cli-probe/probe.mjs scan src-tauri/tests/fixtures/cli     # 개인 정보가 남았는지 검사
```

옵션: `--model <이름>` (기본 `haiku`), `--out <폴더>`, `--keep` (실험 임시 폴더를 지우지 않음).
`claude` 위치는 `where`/`which` 로 찾고, 다른 곳이면 `CLAUDE_PROBE_BIN=<경로>`.

CLI 가 바뀌었는지 보는 순서: `run all --out <새 폴더>` → 끝에 나오는 "확인" 실패 목록 → `compare 옛 새`.
`compare` 는 파일마다 **메시지 종류(방향 + type/subtype) 와 필드 모양**만 비교한다. 값 · 개수 · 순서는 모델이 매번 달라서 비교하지 않는다.

## 비용 · 주의

- **실제 Claude 구독 사용량이 쓰인다.** `run all` 은 짧은 haiku 턴 약 30개 (한 세션 시작마다 시스템 프롬프트 약 1만~3만 토큰이 캐시로 읽히고 쓰인다). 사용량 한도가 빠듯할 때는 시나리오를 골라서 돌린다.
- 허용하는 권한은 임시 폴더 안 파일 만들기 · `mkdir` · `echo` 뿐이다. `--dangerously-skip-permissions` · `bypassPermissions` 는 쓰지 않는다.
- 세션은 **OS 임시 폴더 아래 새 폴더**(`nyanitor-probe-<시나리오>-<8자>`)에서만 돈다. 끝나면 지운다 (저장소 안이면 시작을 거부한다).
- 인증 파일 · 토큰 · 키체인은 읽지 않는다. 로그인 확인은 `claude auth status --json` 출력만 쓴다. `claude auth login/logout` 은 실행하지 않는다.
  "로그인 안 됨" 모양은 빈 `CLAUDE_CONFIG_DIR` 로 `auth status` 만 불러 얻는다 (진짜 설정은 안 건드림).
- `~/.claude/` 는 고치지 않는다. 다만 `resume` · `resume-kill` 시나리오는 이어 하기를 보려고 세션 저장을 켜므로, **CLI 가 스스로** `~/.claude/projects/` 아래에 그 임시 폴더 이름의 기록을 남긴다 (`claude purge <그 임시 폴더 경로>` 로 지울 수 있다). 나머지 시나리오는 `--no-session-persistence`.
- 자식 프로세스 환경에서 뺀다: `CLAUDECODE`, `CLAUDE_AGENT_SDK_*`, `CLAUDE_PID`, `CLAUDE_CODE_*` (단 `CLAUDE_CODE_GIT_BASH_PATH` 는 사용자 설정이라 둠), `MCP_CONNECTION_NONBLOCKING`, `ANTHROPIC_API_KEY`.
  Claude Code 안에서 이 도구를 돌릴 때 부모가 넣어 둔 값이고 실제 앱 환경에는 없다. 특히 `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT` 는 질문 선택지에 미리보기를 켜 버려 결과가 달라진다. 뺀 이름은 녹화본 첫 줄(`meta.strippedEnv`)에 남는다.
- 끝나면 띄운 `claude` 프로세스가 모두 꺼졌는지 확인한다 (시나리오마다 "띄운 claude 프로세스가 모두 꺼짐"). 시간이 초과되면 프로세스 트리를 강제로 끈다.

## 녹화 형식 (`*.jsonl`, 한 줄에 JSON 하나)

첫 줄은 `meta` (형식 `nyanitor-cli-record/1`, 시나리오, CLI 버전, 모델, 실행 인자, 뺀 환경 변수). 그 다음은 시간 순서:

| `dir` | 뜻 |
|---|---|
| `send` | 앱 → CLI (stdin 에 쓴 줄). `msg` 에 JSON, JSON 이 아닌 줄이면 `raw` |
| `recv` | CLI → 앱 (stdout 에서 읽은 줄). `msg` 에 JSON, 아니면 `raw` |
| `stderr` | CLI 의 stderr 한 줄 (`raw`) |
| `exit` | 프로세스 종료 (`code`, `signal`) |
| `note` | 도구가 남긴 메모 (예: CLI 가 쓴 `settings.local.json` 내용). CLI 가 보낸 것이 아님 |

`t` 는 시작 뒤 경과 ms. 한 시나리오에 세션이 여러 개면 `<시나리오>.<라벨>.jsonl` 로 나뉜다 (예: `resume.first.jsonl`, `resume.second.jsonl`).

가짜 CLI 는 `recv` 줄을 순서대로 내보내되, `send` 줄 앞에서는 그 줄(또는 같은 종류의 줄)이 들어올 때까지 기다리면 된다.

## 가리기

녹화본을 쓰기 전에 `redact.mjs` 가 가짜 값으로 바꾼다 — 홈 경로 → `C:\Users\fake`, 이메일 → `user@example.com`, 조직 → `Example Org`, 호스트 이름, **모든 UUID(세션 ID 포함) → `00000000-0000-4000-8000-0000000000NN`**, 임시 폴더 이름 끝 8자 → `00000000`, thinking 서명, 사용량 수치, 긴 목록(스킬 · 에이전트 · 모델 · MCP, 일부만 남김). 키 · 순서 · 형식은 그대로다.
쓰기 전에 **남은 개인 정보 검사**를 하고, 남았으면 그 파일은 쓰지 않고 실패로 끝난다. `scan` 명령으로 이미 만든 파일도 다시 검사할 수 있다.
검사는 이 PC 에서 알아낸 값(홈 경로 · 사용자 이름 · 호스트 · `auth status` 의 이메일 · 조직)과 모양(이메일 · 다른 사용자 폴더 · 가리지 않은 UUID · API 키)을 본다. 다른 이름(예: WSL 사용자 이름)을 더 가리려면 `CLI_PROBE_EXTRA_LITERALS=이름1,이름2`.
**새 녹화를 저장소에 넣기 전에 `scan` 과 `git diff` 로 눈으로도 확인한다.**

## 파일

| 파일 | 역할 |
|---|---|
| `probe.mjs` | 실행기 (list · run · compare · scan) |
| `scenarios.mjs` | 시나리오와 "확인"(기대값) |
| `lib.mjs` | claude 찾기 · 환경 정리 · stream-json 세션 · 프로세스 끄기 |
| `redact.mjs` | 가리기 · 남은 개인 정보 검사 |
