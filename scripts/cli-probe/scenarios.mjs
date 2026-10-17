/* global process */
// 시나리오 — 실제 claude 와 stream-json 으로 주고받는 짧은 시험들.
// 각 시나리오는 { describe, cost, run(ctx) }. 확인(check)은 "지금 CLI 가 예전 녹화본과 같게 동작하는가" 를 보는 기대값이다.
// 허용하는 권한은 임시 폴더 안 파일 만들기 · mkdir · echo 같은 무해한 것만. (bypassPermissions 는 쓰지 않는다)
import fs from "node:fs";
import path from "node:path";
import {
  controlRequest,
  controlResponse,
  isResult,
  isControlRequest,
  killTree,
  listDescendants,
  pidAlive,
  sleep,
  userMessage,
} from "./lib.mjs";

// ---------------------------------------------------------------- 도우미

const canUse = isControlRequest("can_use_tool");

/** can_use_tool 요청을 모으고, policy 가 응답을 돌려주면 보낸다. policy 가 null 을 돌려주면 대기(응답 안 함). */
function watch(s, policy) {
  s.toolRequests = [];
  s.on((m) => {
    if (!canUse(m)) return;
    s.toolRequests.push(m.request);
    const resp = policy ? policy(m.request, s.toolRequests.length) : null;
    if (resp) s.send(controlResponse(m.request_id, resp));
  });
}

const allow = (req) => ({ behavior: "allow", updatedInput: req.input });

/** 사용자 메시지를 보내고 result 를 기다린다. */
async function turn(s, text, timeoutMs = 90000) {
  s.send(userMessage(text));
  return s.next(isResult, timeoutMs);
}

const initOf = (s) => s.recv.find((m) => m.type === "system" && m.subtype === "init");
const toolResultsOf = (s) =>
  s.recv
    .filter((m) => m.type === "user" && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content.filter((c) => c.type === "tool_result"));

const exists = (s, name) => fs.existsSync(path.join(s.cwd, name));
const hasKeys = (obj, keys) => !!obj && keys.every((k) => k in obj);

function readSettingsLocal(s) {
  try {
    return fs.readFileSync(path.join(s.cwd, ".claude", "settings.local.json"), "utf8");
  } catch {
    return null;
  }
}

function answerQuestions(req, pick) {
  const answers = {};
  req.input.questions.forEach((q, i) => {
    answers[q.question] = pick(q, i);
  });
  return { behavior: "allow", updatedInput: { questions: req.input.questions, answers } };
}

// ---------------------------------------------------------------- 시나리오

export const scenarios = {
  start: {
    describe: "1 시작 — initialize 요청 · 첫 출력 · --permission-prompt-tool stdio 없을 때와 있을 때",
    cost: "턴 3",
    async run(ctx) {
      const s = ctx.newSession({ maxTurns: 2 });
      watch(s, null);
      s.send(controlRequest("probe-init-1", { subtype: "initialize" }));
      const initResp = await s.next((m) => m.type === "control_response", 20000);
      ctx.check("initialize 에 control_response success 가 옴", initResp?.response?.subtype === "success");
      const body = initResp?.response?.response;
      ctx.check(
        "initialize 응답 필드 (commands · agents · models · account · pid · claude_code_version)",
        hasKeys(body, ["commands", "agents", "models", "account", "pid", "claude_code_version"]),
        body ? Object.keys(body).join(",") : "",
      );
      await sleep(2500);
      ctx.check(
        "system/init 은 첫 사용자 메시지를 보내기 전에는 오지 않음",
        !initOf(s),
        "initialize 만 보내고 2.5초 기다림",
      );
      const r = await turn(s, "Say only the word: pong");
      const init = initOf(s);
      ctx.check("첫 사용자 메시지 뒤에 system/init 이 옴", !!init);
      ctx.check(
        "system/init 필드",
        hasKeys(init, ["session_id", "tools", "model", "permissionMode", "claude_code_version", "capabilities", "cwd"]),
        init ? Object.keys(init).join(",") : "",
      );
      ctx.check("--permission-prompt-tool stdio 가 있으면 tools 에 AskUserQuestion 이 있음", !!init?.tools?.includes("AskUserQuestion"));
      ctx.info("CLI 버전 (system/init)", init?.claude_code_version);
      ctx.info("permissionMode", init?.permissionMode);
      ctx.info("capabilities", (init?.capabilities || []).join(","));
      ctx.check("result success", r?.subtype === "success" && r.result === "pong", r?.result);
      ctx.check("result 에 usage · total_cost_usd · session_id (D-24)", hasKeys(r, ["usage", "total_cost_usd", "session_id"]));
      await s.shutdown();
      ctx.info("정상 종료 (stdin 닫기) 종료 코드", JSON.stringify(s.exited));

      // --permission-prompt-tool 없이: 묻지 않고 바로 거부된다
      const n = ctx.newSession({ label: "no-stdio", stdioTool: false, maxTurns: 3 });
      watch(n, null);
      const r2 = await turn(n, "Use the Write tool to create a file named hello.txt containing the text hi. Then say done.");
      const init2 = initOf(n);
      ctx.check("stdio 없이는 can_use_tool 요청이 오지 않음", n.toolRequests.length === 0);
      ctx.check("stdio 없이는 tools 에 AskUserQuestion 이 없음", !!init2 && !init2.tools.includes("AskUserQuestion"));
      const denied = n.recv.find((m) => m.type === "system" && m.subtype === "permission_denied");
      ctx.check("stdio 없이는 system/permission_denied 가 옴", !!denied);
      ctx.check("stdio 없이는 result.permission_denials 가 채워짐", (r2?.permission_denials || []).length >= 1);
      ctx.check("파일이 만들어지지 않음", !exists(n, "hello.txt"));
      await n.shutdown();
    },
  },

  "two-turns": {
    describe: "2 두 턴 — 한 프로세스로 두 번 묻고 두 번 result",
    cost: "턴 2",
    async run(ctx) {
      const s = ctx.newSession({ maxTurns: 2 });
      watch(s, null);
      const r1 = await turn(s, "Say only the word: one");
      const r2 = await turn(s, [{ type: "text", text: "Say only the word: two" }]); // content 를 블록 배열로도 보낼 수 있는지
      ctx.check("result 두 개 (success)", r1?.subtype === "success" && r2?.subtype === "success");
      ctx.check("답이 맞음", r1?.result?.toLowerCase() === "one" && r2?.result?.toLowerCase() === "two", `${r1?.result} / ${r2?.result}`);
      ctx.check("같은 session_id", !!r1 && r1.session_id === r2?.session_id);
      ctx.check("system/init 이 턴마다 옴", s.recv.filter((m) => m.type === "system" && m.subtype === "init").length === 2);
      ctx.check("result 필드 (usage · total_cost_usd · modelUsage · num_turns · duration_ms)", hasKeys(r2, ["usage", "total_cost_usd", "modelUsage", "num_turns", "duration_ms", "stop_reason", "terminal_reason"]));
      ctx.info("total_cost_usd 턴1 → 턴2", `${r1?.total_cost_usd} → ${r2?.total_cost_usd}`);
      ctx.info("num_turns 턴1 · 턴2", `${r1?.num_turns} · ${r2?.num_turns}`);
      ctx.info("output_tokens 턴1 · 턴2", `${r1?.usage?.output_tokens} · ${r2?.usage?.output_tokens}`);
      await s.shutdown();
    },
  },

  "permission-allow": {
    describe: "3 권한 — 허용 (updatedInput 있게 / 없이 / 고쳐서)",
    cost: "턴 3",
    async run(ctx) {
      const s = ctx.newSession({ maxTurns: 4 });
      watch(s, allow);
      const r = await turn(s, "Use the Write tool to create a file named hello.txt containing exactly: hi. Then reply done.");
      const req = s.toolRequests[0];
      ctx.check("Write 에 can_use_tool 요청이 옴", req?.tool_name === "Write");
      ctx.check(
        "요청 필드 (tool_name · display_name · input · description · permission_suggestions · tool_use_id)",
        hasKeys(req, ["tool_name", "display_name", "input", "description", "permission_suggestions", "tool_use_id"]),
        req ? Object.keys(req).join(",") : "",
      );
      ctx.info("Write 의 permission_suggestions", JSON.stringify(req?.permission_suggestions));
      ctx.check("허용하면 파일이 만들어지고 result success", exists(s, "hello.txt") && r?.subtype === "success");
      await s.shutdown();

      const b = ctx.newSession({ label: "bare", maxTurns: 4 });
      watch(b, () => ({ behavior: "allow" })); // updatedInput 없이
      const rb = await turn(b, "Use the Write tool to create a file named bare.txt containing exactly: hi. Then reply done.");
      ctx.check("updatedInput 없이 allow 해도 실행됨", exists(b, "bare.txt") && rb?.subtype === "success");
      await b.shutdown();

      const e = ctx.newSession({ label: "edited", maxTurns: 4 });
      watch(e, (req2, n) =>
        n === 1 ? { behavior: "allow", updatedInput: { ...req2.input, file_path: path.join(e.cwd, "edited-by-user.txt") } } : allow(req2),
      );
      const re = await turn(e, "Use the Write tool to create a file named original.txt containing exactly: hi. Then reply done.");
      const firstResult = toolResultsOf(e)[0];
      ctx.check("updatedInput 으로 고친 파일 이름대로 만들어짐", exists(e, "edited-by-user.txt") && /edited-by-user\.txt/.test(String(firstResult?.content)), String(firstResult?.content).slice(0, 120));
      ctx.info("고친 입력으로 실행한 뒤 모델 동작", `요청 ${e.toolRequests.length}번, result ${re?.subtype}, original.txt ${exists(e, "original.txt") ? "만들어짐(모델이 알아채고 다시 씀)" : "없음"}`);
      await e.shutdown();
    },
  },

  "permission-deny": {
    describe: "3 권한 — 거부 (메시지만 / interrupt 붙이고 새 사용자 메시지로 방향 바꾸기 — '다르게 하라고 말하기')",
    cost: "턴 3",
    async run(ctx) {
      // 메시지를 붙여 거부 — 모델은 이 메시지를 tool_result 오류로 받는다
      const s = ctx.newSession({ maxTurns: 5 });
      watch(s, () => ({ behavior: "deny", message: "The user rejected this request and does not want any file named draft.txt." }));
      const r = await turn(s, "Use the Write tool to create a file named draft.txt containing exactly: hi. Then reply done.");
      ctx.check("거부하면 파일이 만들어지지 않음", !exists(s, "draft.txt"));
      const denied = toolResultsOf(s).find((t) => t.is_error);
      ctx.check("거부 메시지가 그대로 tool_result 오류(is_error)로 모델에게 감", /does not want any file named draft\.txt/.test(String(denied?.content)), String(denied?.content).slice(0, 120));
      ctx.check("result 가 옴 (모델이 알아서 마무리)", !!r, r ? `${r.subtype} / ${r.terminal_reason}` : "result 없음");
      ctx.info("거부 뒤 모델이 같은 요청을 다시 한 횟수", String(s.toolRequests.length - 1));
      ctx.info("result.permission_denials 개수", String((r?.permission_denials || []).length));
      await s.shutdown();

      // interrupt:true 로 거부하고, 사용자의 말을 새 사용자 메시지로 보내 방향을 바꾼다
      const i = ctx.newSession({ label: "interrupt", maxTurns: 5 });
      watch(i, (req, n) => (n === 1 ? { behavior: "deny", message: "The user stopped this request.", interrupt: true } : allow(req)));
      const ri = await turn(i, "Use the Write tool to create a file named draft.txt containing exactly: hi. Then reply done.", 60000);
      ctx.info("interrupt:true 로 거부했을 때 result", JSON.stringify({ subtype: ri?.subtype, is_error: ri?.is_error, terminal_reason: ri?.terminal_reason }));
      ctx.check("interrupt:true 거부 뒤 result 는 error_during_execution", ri?.subtype === "error_during_execution", ri?.subtype);
      ctx.check("파일이 만들어지지 않음", !exists(i, "draft.txt"));
      ctx.check("interrupt:true 거부 뒤에도 프로세스가 살아 있음", !i.exited);
      if (!i.exited) {
        const again = await turn(i, "Do not use the name draft.txt. Use the Write tool to create notes.txt containing exactly: hi. Then reply done.", 90000);
        ctx.check("사용자 메시지로 방향을 바꾸면 따름 (notes.txt 가 만들어짐)", again?.subtype === "success" && exists(i, "notes.txt") && !exists(i, "draft.txt"), again?.result);
      }
      await i.shutdown();
    },
  },

  "permission-always": {
    describe: "3 권한 — '이 프로젝트에서 항상 허용' (D-23): 제안을 그대로 돌려주면 CLI 가 settings.local.json 에 쓰는가",
    cost: "턴 1",
    async run(ctx) {
      const s = ctx.newSession({ maxTurns: 4 });
      watch(s, (req) => {
        const persist = (req.permission_suggestions || []).filter((p) => p.type === "addRules" && p.destination === "localSettings");
        return { behavior: "allow", updatedInput: req.input, updatedPermissions: persist };
      });
      const r = await turn(s, "Run exactly this command with the Bash tool: mkdir probe-dir");
      const req = s.toolRequests[0];
      ctx.check("Bash mkdir 에 can_use_tool 요청이 옴", req?.tool_name === "Bash");
      ctx.info("Bash 요청의 permission_suggestions", JSON.stringify(req?.permission_suggestions));
      ctx.check(
        "제안 중 addRules · destination localSettings 가 있음",
        (req?.permission_suggestions || []).some((p) => p.type === "addRules" && p.destination === "localSettings"),
      );
      const settings = readSettingsLocal(s);
      s.note(`CLI 가 쓴 .claude/settings.local.json: ${settings === null ? "(없음)" : settings.replace(/\s+/g, " ")}`);
      ctx.info(".claude/settings.local.json", settings === null ? "(없음)" : settings.replace(/\s+/g, " "));
      ctx.check("CLI 가 스스로 settings.local.json 의 permissions.allow 에 규칙을 씀", !!settings && /"allow"\s*:\s*\[\s*"Bash\(mkdir probe-dir \*\)"/.test(settings));
      ctx.check("result success · 폴더가 만들어짐", r?.subtype === "success" && exists(s, "probe-dir"));
      await s.shutdown();
    },
  },

  "permission-always-write": {
    describe: "3 권한 — 제안이 없는 도구(Write)는 앱이 규칙을 직접 만들어 보내면 되는가 + 다음 세션에서 이미 허용됨 (D-15)",
    cost: "턴 2",
    async run(ctx) {
      const s = ctx.newSession({ maxTurns: 4 });
      watch(s, (req) => ({
        behavior: "allow",
        updatedInput: req.input,
        updatedPermissions: [{ type: "addRules", rules: [{ toolName: req.tool_name }], behavior: "allow", destination: "localSettings" }],
      }));
      const r = await turn(s, "Use the Write tool to create a file named a.txt containing exactly: hi. Then reply done.");
      ctx.check("Write 에 요청이 옴", s.toolRequests[0]?.tool_name === "Write");
      ctx.info("Write 제안", JSON.stringify(s.toolRequests[0]?.permission_suggestions));
      const settings = readSettingsLocal(s);
      s.note(`CLI 가 쓴 .claude/settings.local.json: ${settings === null ? "(없음)" : settings.replace(/\s+/g, " ")}`);
      ctx.check('직접 만든 규칙 {toolName:"Write"} 이 settings.local.json 에 "Write" 로 쓰임', !!settings && /"allow"\s*:\s*\[\s*"Write"/.test(settings), settings?.replace(/\s+/g, " "));
      ctx.check("result success", r?.subtype === "success" && exists(s, "a.txt"));
      await s.shutdown();

      // 같은 폴더에서 새 프로세스 — 이제는 묻지 않아야 한다
      const p = ctx.newSession({ label: "preallowed", cwd: s.cwd, maxTurns: 4 });
      watch(p, () => ({ behavior: "deny", message: "이미 허용된 도구는 묻지 않아야 한다" }));
      const rp = await turn(p, "Use the Write tool to create a file named b.txt containing exactly: hi. Then reply done.");
      ctx.check("이미 허용된 도구는 can_use_tool 없이 실행됨", p.toolRequests.length === 0 && exists(p, "b.txt") && rp?.subtype === "success");
      const meta = toolResultsOf(p);
      ctx.info("두 번째 세션 tool_result", JSON.stringify(meta.map((t) => String(t.content).slice(0, 60))));
      await p.shutdown();
    },
  },

  "permission-scope": {
    describe: "3 권한 — Write · Edit '항상 허용' 을 폴더로 좁히는 규칙 `Edit(/폴더/**)` 이 되는가 (P3-02)",
    cost: "턴 2",
    async run(ctx) {
      // 앱(Rust)이 만들 규칙과 같은 모양: 도구 이름은 Edit (파일 고치기 도구 묶음), 내용은 프로젝트 기준 `/폴더/**`
      const rule = { toolName: "Edit", ruleContent: "/sub/**" };
      const dir = ctx.scratch("scope");
      fs.mkdirSync(path.join(dir, "sub"));
      fs.mkdirSync(path.join(dir, "other"));
      const s = ctx.newSession({ label: "first", cwd: dir, maxTurns: 6 });
      watch(s, (req) => ({
        behavior: "allow",
        updatedInput: req.input,
        updatedPermissions: [{ type: "addRules", rules: [rule], behavior: "allow", destination: "localSettings" }],
      }));
      const r = await turn(s, "Use the Write tool to create the file sub/a.txt containing exactly: hi. Then reply done.");
      ctx.check("Write 요청이 오고 제안은 setMode 뿐 (addRules 없음)", s.toolRequests[0]?.tool_name === "Write" && !(s.toolRequests[0]?.permission_suggestions || []).some((p) => p.type === "addRules"));
      const settings = readSettingsLocal(s);
      s.note(`CLI 가 쓴 .claude/settings.local.json: ${settings === null ? "(없음)" : settings.replace(/\s+/g, " ")}`);
      ctx.info(".claude/settings.local.json", settings === null ? "(없음)" : settings.replace(/\s+/g, " "));
      ctx.check('{toolName:"Edit", ruleContent:"/sub/**"} 이 "Edit(/sub/**)" 로 쓰임', !!settings && /"allow"\s*:\s*\[\s*"Edit\(\/sub\/\*\*\)"/.test(settings), settings?.replace(/\s+/g, " "));
      ctx.check("result success · sub/a.txt 만들어짐", r?.subtype === "success" && exists(s, "sub/a.txt"));
      await s.shutdown();

      // 같은 폴더에서 새 프로세스 — sub 안은 묻지 않고, 밖(other)은 여전히 물어야 한다. Edit 도구도 규칙을 따른다.
      const p = ctx.newSession({ label: "second", cwd: dir, maxTurns: 10 });
      watch(p, (req) => allow(req));
      const rp = await turn(
        p,
        "Do these in order. 1) Use the Write tool to create sub/b.txt containing exactly: hi. 2) Use the Write tool to create sub/deep/d.txt containing exactly: hi. 3) Use the Write tool to create other/c.txt containing exactly: hi. 4) Use the Edit tool on sub/a.txt to replace the text hi with ho. Then reply done.",
        120000,
      );
      const asked = p.toolRequests.map((q) => path.relative(p.cwd, q.input?.file_path ?? "").replace(/\\/g, "/"));
      ctx.info("두 번째 세션에서 물어 온 것", JSON.stringify(asked));
      ctx.check("폴더 안(sub/b.txt · sub/deep/d.txt)은 묻지 않고 만들어짐", exists(p, "sub/b.txt") && exists(p, "sub/deep/d.txt") && !asked.some((a) => a.startsWith("sub/")), JSON.stringify(asked));
      ctx.check("폴더 밖(other/c.txt)은 여전히 물어 옴", asked.includes("other/c.txt"), JSON.stringify(asked));
      let edited = null;
      try {
        edited = fs.readFileSync(path.join(p.cwd, "sub", "a.txt"), "utf8");
      } catch {
        /* 없음 */
      }
      ctx.check("Edit 도구도 같은 규칙으로 묻지 않음 (sub/a.txt 가 ho 로 바뀜)", edited !== null && edited.trim() === "ho" && !asked.includes("sub/a.txt"), `${edited} / ${JSON.stringify(asked)}`);
      ctx.check("result success", rp?.subtype === "success", rp?.subtype);
      await p.shutdown();
    },
  },

  "permission-readonly": {
    describe: "3 권한 — 읽기 전용 명령(echo)은 묻지 않고 지나감 (D-15)",
    cost: "턴 1",
    async run(ctx) {
      const s = ctx.newSession({ maxTurns: 4 });
      watch(s, () => ({ behavior: "deny", message: "묻지 않아야 한다" }));
      const r = await turn(s, "Run exactly this command with the Bash tool: echo probe-ok");
      ctx.check("echo 는 can_use_tool 없이 실행됨", s.toolRequests.length === 0 && toolResultsOf(s).some((t) => t.content === "probe-ok"));
      const um = s.recv.find((m) => m.type === "user" && m.tool_result_meta);
      ctx.info("tool_result_meta (왜 묻지 않았나)", JSON.stringify(um?.tool_result_meta));
      ctx.check("result success", r?.subtype === "success");
      await s.shutdown();
    },
  },

  question: {
    describe: "4 AskUserQuestion — 하나 고르기 · 여러 개(미리보기) · 기타 직접 쓰기 · 닫고 말하기 · 거부",
    cost: "턴 4",
    async run(ctx) {
      // 하나 고르기
      const s = ctx.newSession({ maxTurns: 4 });
      watch(s, (req) => (req.tool_name === "AskUserQuestion" ? answerQuestions(req, () => "Blue") : allow(req)));
      const r = await turn(
        s,
        "Use the AskUserQuestion tool to ask me which color I prefer: red or blue (one question, header Color). After I answer, reply with only the chosen color.",
      );
      const req = s.toolRequests[0];
      ctx.check("AskUserQuestion 이 can_use_tool 로 옴", req?.tool_name === "AskUserQuestion");
      ctx.check("요청 필드에 requires_user_interaction", req?.requires_user_interaction === true);
      const q = req?.input?.questions?.[0];
      ctx.check("질문 필드 (question · header · options[label,description] · multiSelect)", hasKeys(q, ["question", "header", "options", "multiSelect"]) && hasKeys(q?.options?.[0], ["label", "description"]));
      ctx.check("미리보기 설정이 없으면 preview 필드가 없음", !q?.options?.some((o) => "preview" in o));
      ctx.check("모델이 답을 받음 (Blue)", /blue/i.test(r?.result || ""), r?.result);
      await s.shutdown();

      // 여러 개 + 미리보기 + 기타 직접 쓰기 (initialize 의 toolConfig)
      const m = ctx.newSession({ label: "multi", maxTurns: 4 });
      watch(m, (req2) =>
        req2.tool_name === "AskUserQuestion"
          ? answerQuestions(req2, (qq) => (qq.multiSelect ? ["Alpha", "Gamma"] : "Purple (my own idea)"))
          : allow(req2),
      );
      m.send(controlRequest("probe-init-1", { subtype: "initialize", toolConfig: { askUserQuestion: { previewFormat: "markdown" } } }));
      await m.next((x) => x.type === "control_response", 20000);
      const rm = await turn(
        m,
        "Use the AskUserQuestion tool with exactly two questions in ONE call. Q1 (header Features, multiSelect true): which features do I want, options Alpha, Beta, Gamma. Q2 (header Layout, single select): which UI layout, options Sidebar, Tabs - include a markdown preview for each Layout option. Afterwards reply with one line summarizing my answers.",
      );
      const mr = m.toolRequests[0];
      const qs = mr?.input?.questions || [];
      ctx.check("질문 두 개가 한 요청에 옴 (multiSelect 하나 포함)", qs.length === 2 && qs.some((x) => x.multiSelect));
      ctx.check("initialize toolConfig.askUserQuestion.previewFormat 를 주면 options[].preview 가 옴", qs.some((x) => x.options?.some((o) => typeof o.preview === "string")));
      ctx.check("모델이 여러 개 + 기타 직접 쓴 답을 받음", /alpha/i.test(rm?.result || "") && /gamma/i.test(rm?.result || "") && /purple/i.test(rm?.result || ""), rm?.result);
      const tr = toolResultsOf(m).find((t) => /answered/i.test(String(t.content)));
      ctx.info("여러 개(배열) 답이 모델에게 전달된 모양", JSON.stringify(String(tr?.content).slice(0, 220)));
      await m.shutdown();

      // 여러 개를 쉼표 문자열로
      const j = ctx.newSession({ label: "joined", maxTurns: 4 });
      watch(j, (req2) => (req2.tool_name === "AskUserQuestion" ? answerQuestions(req2, () => "Alpha, Gamma") : allow(req2)));
      const rj = await turn(
        j,
        "Use the AskUserQuestion tool with one question (header Features, multiSelect true): which features do I want, options Alpha, Beta, Gamma. Afterwards reply with only the chosen features.",
      );
      ctx.check("여러 개를 ', ' 로 이은 문자열로 답해도 됨", /alpha/i.test(rj?.result || "") && /gamma/i.test(rj?.result || "") && !/beta/i.test(rj?.result || ""), rj?.result);
      const jt = toolResultsOf(j).find((t) => /answered/i.test(String(t.content)));
      ctx.info("쉼표 문자열 답이 모델에게 전달된 모양", JSON.stringify(String(jt?.content).slice(0, 200)));
      await j.shutdown();

      // 카드를 닫고 말로 답하기(response) · 질문 거부(deny)
      const d = ctx.newSession({ label: "dismissed", maxTurns: 4 });
      watch(d, (req2) =>
        req2.tool_name === "AskUserQuestion"
          ? { behavior: "allow", updatedInput: { questions: req2.input.questions, answers: {}, response: "I would rather decide later. Just say: ok, later." } }
          : allow(req2),
      );
      const rd = await turn(
        d,
        "Use the AskUserQuestion tool to ask me which color I prefer: red or blue (one question, header Color). After I answer, follow what I say and reply in one short line.",
      );
      const dt = toolResultsOf(d).find((t) => /responded|answered/i.test(String(t.content)));
      ctx.info("response 로 답했을 때 모델에게 전달된 모양", JSON.stringify(String(dt?.content).slice(0, 200)));
      ctx.check("response 로 답해도 turn 이 정상으로 끝남", rd?.subtype === "success", rd?.result);
      await d.shutdown();

      const x = ctx.newSession({ label: "denied", maxTurns: 4 });
      watch(x, (req2) => (req2.tool_name === "AskUserQuestion" ? { behavior: "deny", message: "The user dismissed the question. Do not ask again; reply only: skipped" } : allow(req2)));
      const rx = await turn(
        x,
        "Use the AskUserQuestion tool to ask me which color I prefer: red or blue (one question, header Color). If I dismiss it, follow my message.",
      );
      ctx.info("질문을 deny 했을 때 result", JSON.stringify({ subtype: rx?.subtype, result: rx?.result }));
      await x.shutdown();
    },
  },

  interrupt: {
    describe: "5 중단 — 도구 실행 중 · 권한 요청이 기다리는 중 · 아무것도 안 하는 중",
    cost: "턴 3",
    async run(ctx) {
      // 도구가 도는 중에 interrupt
      const s = ctx.newSession({ maxTurns: 4 });
      watch(s, allow);
      s.send(userMessage('Run this exact command with the Bash tool (foreground, no background): node -e "setTimeout(()=>console.log(\'finished\'),40000)"'));
      await s.next((m) => canUse(m), 60000);
      await sleep(2500);
      s.send(controlRequest("probe-int-1", { subtype: "interrupt" }));
      const ack = await s.next((m) => m.type === "control_response", 15000);
      ctx.check("interrupt 에 control_response success 가 옴", ack?.response?.subtype === "success", JSON.stringify(ack?.response));
      ctx.info("interrupt 응답 본문", JSON.stringify(ack?.response?.response));
      const r = await s.next(isResult, 30000);
      ctx.check("중단된 턴의 result 는 error_during_execution", r?.subtype === "error_during_execution", `${r?.subtype} / ${r?.terminal_reason}`);
      ctx.info("중단 result", JSON.stringify({ subtype: r?.subtype, is_error: r?.is_error, terminal_reason: r?.terminal_reason, stop_reason: r?.stop_reason }));
      ctx.check("40초를 기다리지 않고 바로 끝남", r !== null && (r.duration_ms ?? 0) < 30000, `duration_ms=${r?.duration_ms}`);
      const stopMsg = s.recv.find((m) => m.type === "user" && JSON.stringify(m.message).includes("Request interrupted"));
      ctx.check('"[Request interrupted by user]" 사용자 메시지가 옴', !!stopMsg);
      ctx.check("중단 뒤에도 프로세스가 살아 있음", !s.exited);
      const again = await turn(s, "Say only: alive", 60000);
      ctx.check("중단 뒤 다음 메시지에 정상 답함", again?.subtype === "success" && /alive/i.test(again.result || ""), again?.result);
      await s.shutdown();
      ctx.info("정상 종료 (stdin 닫기) 종료 코드", JSON.stringify(s.exited));

      // 권한 요청이 대답을 기다리는 중에 interrupt
      const p = ctx.newSession({ label: "pending-permission", maxTurns: 4 });
      watch(p, null);
      p.send(userMessage("Use the Write tool to create a file named w.txt containing exactly: hi."));
      await p.next((m) => canUse(m), 60000);
      await sleep(1000);
      p.send(controlRequest("probe-int-2", { subtype: "interrupt" }));
      const rp = await p.next(isResult, 30000);
      const kinds = p.recv.map((m) => `${m.type}${m.subtype ? "/" + m.subtype : m.request ? "/" + m.request.subtype : ""}`);
      ctx.info("권한 대기 중 interrupt 뒤 받은 메시지 종류", kinds.join(" "));
      ctx.check("권한 대기 중 interrupt 도 result 로 끝남", !!rp, rp ? `${rp.subtype} / ${rp.terminal_reason}` : "result 없음");
      ctx.check("파일이 만들어지지 않음", !exists(p, "w.txt"));
      if (!p.exited) {
        const ap = await turn(p, "Say only: alive", 60000);
        ctx.check("대기 중 중단 뒤 다음 메시지에 정상 답함", ap?.subtype === "success", ap?.result);
      }
      await p.shutdown();

      // 아무것도 안 하는 중 interrupt
      const i = ctx.newSession({ label: "idle", maxTurns: 2 });
      i.send(controlRequest("probe-int-3", { subtype: "interrupt" }));
      const ia = await i.next((m) => m.type === "control_response", 20000);
      ctx.info("대기 중(턴 없음) interrupt 응답", JSON.stringify(ia?.response));
      await i.shutdown();
    },
  },

  resume: {
    describe: "6 이어 하기 — stdin 닫아 정상 종료한 뒤 --resume",
    cost: "턴 2",
    async run(ctx) {
      await resumeFlow(ctx, { kill: false });
    },
  },

  "resume-kill": {
    describe: "6 이어 하기 — 강제 종료(프로세스 트리 끄기)한 뒤 --resume",
    cost: "턴 2",
    async run(ctx) {
      await resumeFlow(ctx, { kill: true });
    },
  },

  "strange-input": {
    describe: "8 이상한 입력 — 모르는 control 요청 · 모르는 type · JSON 아닌 줄",
    cost: "턴 1",
    async run(ctx) {
      const s = ctx.newSession({ maxTurns: 2 });
      watch(s, null);
      s.send(controlRequest("probe-bogus-1", { subtype: "bogus_subtype" }));
      const e1 = await s.next((m) => m.type === "control_response", 15000);
      ctx.info("모르는 control 요청 subtype 에 대한 응답", JSON.stringify(e1?.response));
      ctx.check("모르는 control 요청에는 error 로 응답함", e1?.response?.subtype === "error", JSON.stringify(e1?.response));
      s.send({ type: "bogus_type", payload: 1 });
      s.send(controlResponse("no-such-request", { behavior: "allow" }));
      await sleep(1500);
      ctx.check("모르는 type · 짝 없는 control_response 를 보내도 프로세스가 살아 있음", !s.exited);
      const r = await turn(s, "Say only the word: ok");
      ctx.check("그 뒤에도 정상 턴", r?.subtype === "success", r?.result);
      s.sendRaw("this is not json");
      await sleep(2000);
      ctx.info("JSON 아닌 줄을 보낸 뒤", s.exited ? `프로세스 종료 ${JSON.stringify(s.exited)}` : "프로세스 살아 있음");
      if (!s.exited) {
        s.send(controlRequest("probe-init-after-bad", { subtype: "initialize" }));
        const ok = await s.next((m) => m.type === "control_response", 15000);
        ctx.info("JSON 아닌 줄 뒤 initialize 응답", ok ? ok.response?.subtype : "응답 없음");
      }
      const errs = s.records.filter((x) => x.dir === "stderr").map((x) => x.raw);
      ctx.info("stderr", JSON.stringify(errs));
      await s.shutdown();
    },
  },

  "strange-kill": {
    describe: "8 · 7 CLI 가 중간에 죽을 때 — 마지막 출력 · 종료 코드, 자식 프로세스까지 끄는 법",
    cost: "턴 2",
    async run(ctx) {
      for (const mode of ["parent-only", "tree"]) {
        const s = ctx.newSession({ label: mode, maxTurns: 4 });
        watch(s, allow);
        s.send(userMessage('Run this exact command with the Bash tool (foreground): node -e "setTimeout(()=>console.log(\'finished\'),40000)"'));
        await s.next((m) => canUse(m), 60000);
        await sleep(3500);
        const before = listDescendants(s.pid);
        s.note(`죽이기 전 자손 프로세스: ${before.join(" | ") || "(없음)"}`);
        ctx.info(`[${mode}] 죽이기 전 자손 프로세스`, before.join(" | ") || "(없음)");
        const pids = before.map((l) => Number(l.split(" ")[0])).filter(Boolean);
        if (mode === "parent-only") {
          try {
            process.kill(s.pid); // 부모만 (Windows 에서는 TerminateProcess)
          } catch (e) {
            s.note(`kill 오류 ${e.message}`);
          }
        } else {
          killTree(s.pid);
        }
        await s.waitExit(8000);
        await sleep(1000);
        const survivors = pids.filter(pidAlive);
        ctx.info(`[${mode}] 죽인 뒤 살아 있는 자손 pid`, survivors.join(",") || "(없음)");
        ctx.info(`[${mode}] 종료 정보`, JSON.stringify(s.exited));
        const lastRecv = [...s.records].reverse().find((r) => r.dir === "recv");
        ctx.info(`[${mode}] 마지막으로 받은 줄`, lastRecv?.msg ? `${lastRecv.msg.type}/${lastRecv.msg.subtype || ""}` : JSON.stringify(lastRecv?.raw));
        ctx.check(`[${mode}] claude 프로세스가 사라짐`, !pidAlive(s.pid));
        if (mode === "tree") ctx.check("[tree] 자손까지 모두 사라짐", survivors.length === 0);
        for (const pid of survivors) killTree(pid); // 정리
        await s.shutdown();
      }
    },
  },

  "strange-background": {
    describe: "8 · 6 백그라운드로 돌고 있는 작업이 있을 때 stdin 을 닫으면 정상 종료되는가",
    cost: "턴 1",
    async run(ctx) {
      const s = ctx.newSession({ maxTurns: 4 });
      watch(s, allow);
      const r = await turn(
        s,
        'Run this exact command with the Bash tool and set run_in_background to true: node -e "setTimeout(()=>{},45000)"',
      );
      ctx.check("백그라운드 작업을 시작하고 턴이 끝남", r?.subtype === "success", r?.subtype);
      const started = s.recv.some((m) => m.type === "system" && m.subtype === "task_started");
      ctx.info("system/task_started 가 옴", String(started));
      s.closeStdin();
      const exited = await s.waitExit(10000);
      ctx.info("백그라운드 작업이 도는 중 stdin 을 닫고 10초 기다린 결과", exited ? `종료 ${JSON.stringify(exited)}` : "종료되지 않음 → 앱이 직접 끝내야 함");
      ctx.check("(기록용) 종료 여부", true);
      await s.shutdown();
      ctx.info("강제 종료 정보", JSON.stringify(s.exited));
    },
  },

  "strange-max-turns": {
    describe: "8 --max-turns 에 걸릴 때",
    cost: "턴 1",
    async run(ctx) {
      const s = ctx.newSession({ maxTurns: 1 });
      watch(s, allow);
      const r = await turn(s, "Run exactly this command with the Bash tool: mkdir x1");
      ctx.check("result 가 error_max_turns", r?.subtype === "error_max_turns", `${r?.subtype} / ${r?.terminal_reason}`);
      ctx.info("result", JSON.stringify({ subtype: r?.subtype, is_error: r?.is_error, terminal_reason: r?.terminal_reason }));
      await s.shutdown();
      ctx.info("종료 정보", JSON.stringify(s.exited));
    },
  },

  "strange-bad-args": {
    describe: "8 잘못된 실행 옵션 — 없는 세션 ID 로 --resume · 없는 모델 · 잘못된 --permission-prompt-tool",
    cost: "없음에 가까움",
    async run(ctx) {
      const fakeId = "11111111-2222-4333-8444-555555555555";
      const a = ctx.newSession({ label: "bad-resume", extra: ["--resume", fakeId], maxTurns: 1 });
      a.send(userMessage("Say only: hi"));
      await a.waitExit(30000);
      ctx.info("없는 세션 ID 로 --resume", `종료 ${JSON.stringify(a.exited)} / stderr ${JSON.stringify(a.records.filter((r) => r.dir === "stderr").map((r) => r.raw))} / 받은 종류 ${a.recv.map((m) => m.type + (m.subtype ? "/" + m.subtype : "")).join(" ")}`);
      await a.shutdown();

      const b = ctx.newSession({ label: "bad-model", model: "not-a-real-model", maxTurns: 1 });
      const rb = await turn(b, "Say only: hi", 40000);
      ctx.info("없는 모델 이름", JSON.stringify({ subtype: rb?.subtype, is_error: rb?.is_error, terminal_reason: rb?.terminal_reason, api_error_status: rb?.api_error_status, result: String(rb?.result).slice(0, 160) }));
      await b.shutdown();

      const c = ctx.newSession({ label: "bad-prompt-tool", stdioTool: false, extra: ["--permission-prompt-tool", "nope"], maxTurns: 1 });
      const rc = await turn(c, "Say only: hi", 40000);
      ctx.info("잘못된 --permission-prompt-tool 값 (권한이 필요 없는 턴)", `result ${rc?.subtype} / stderr ${JSON.stringify(c.records.filter((r) => r.dir === "stderr").map((r) => r.raw))}`);
      await c.shutdown();
    },
  },

  env: {
    describe: "7 환경 — auth status · 로그인 안 됨 · 실행 파일 위치 · API 키가 있을 때 (가짜 키)",
    cost: "턴 1 (가짜 키라 실제 호출 안 됨)",
    async run(ctx) {
      const files = {};
      files.version = ctx.cliVersion;
      files.claudeExecutable = ctx.binPath;
      // 로그인된 상태 (이 PC)
      const st = ctx.run(["auth", "status", "--json"]);
      let parsed = null;
      try {
        parsed = JSON.parse(st.stdout);
      } catch {
        /* */
      }
      ctx.check("auth status --json 이 JSON 을 돌려줌", !!parsed && "loggedIn" in parsed, `종료 ${st.status}`);
      files.authStatusLoggedIn = { exitCode: st.status, json: parsed };
      ctx.info("auth status 키", parsed ? Object.keys(parsed).join(",") : "(없음)");
      // 로그인 안 된 상태: 빈 설정 폴더 (진짜 설정은 건드리지 않음)
      const emptyCfg = ctx.scratch("emptycfg");
      const out = ctx.run(["auth", "status", "--json"], { CLAUDE_CONFIG_DIR: emptyCfg });
      let parsedOut = null;
      try {
        parsedOut = JSON.parse(out.stdout);
      } catch {
        /* */
      }
      files.authStatusLoggedOut = { exitCode: out.status, json: parsedOut };
      ctx.check("로그인 안 됨: loggedIn false · 종료 코드 1", parsedOut?.loggedIn === false && out.status === 1, `종료 ${out.status}`);
      // 가짜 API 키가 환경에 있으면 구독이 아니라 그 키를 쓰려 한다
      const k = ctx.newSession({ label: "apikey", maxTurns: 1, env: { ANTHROPIC_API_KEY: "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE" } });
      const rk = await turn(k, "Say only: hi", 40000);
      const initk = initOf(k);
      ctx.check("환경에 ANTHROPIC_API_KEY 가 있으면 system/init.apiKeySource 가 'ANTHROPIC_API_KEY'", initk?.apiKeySource === "ANTHROPIC_API_KEY", initk?.apiKeySource);
      ctx.info("가짜 키 result", JSON.stringify({ subtype: rk?.subtype, is_error: rk?.is_error, terminal_reason: rk?.terminal_reason, api_error_status: rk?.api_error_status, result: rk?.result }));
      ctx.info("가짜 키일 때 stderr", JSON.stringify(k.records.filter((r) => r.dir === "stderr").map((r) => r.raw)));
      await k.shutdown();
      // 키를 뺀 정상 세션은 apiKeySource none (구독)
      const n = ctx.newSession({ label: "no-key", maxTurns: 1 });
      const rn = await turn(n, "Say only: hi", 60000);
      const initn = initOf(n);
      ctx.check("키를 뺀 자식 환경은 구독으로 돎 (apiKeySource none)", initn?.apiKeySource === "none" && rn?.subtype === "success", initn?.apiKeySource);
      await n.shutdown();
      files.strippedEnvNames = ctx.strippedEnv;
      return { files: { "env.json": files } };
    },
  },
};

// ---------------------------------------------------------------- 이어 하기 공용

async function resumeFlow(ctx, { kill }) {
  const a = ctx.newSession({ label: "first", persist: true, maxTurns: 2 });
  watch(a, null);
  const r1 = await turn(a, "Remember this secret word: PINEAPPLE. Reply only: noted");
  const sid = r1?.session_id;
  ctx.check("첫 세션 result 에 session_id", !!sid);
  ctx.info("첫 세션 session_id 모양", sid ? sid.replace(/[0-9a-f]/g, "x") : "(없음)");
  if (kill) {
    a.note("프로세스 트리를 강제 종료");
    killTree(a.pid);
    await a.waitExit(8000);
  } else {
    a.closeStdin();
    await a.waitExit(10000);
  }
  ctx.info(kill ? "강제 종료 정보" : "stdin 닫은 뒤 종료 정보", JSON.stringify(a.exited));
  await a.shutdown();

  const b = ctx.newSession({ label: "second", persist: true, cwd: a.cwd, extra: ["--resume", sid || "missing"], maxTurns: 2 });
  watch(b, null);
  const r2 = await turn(b, "What was the secret word? Reply only the word.");
  ctx.check("이어 하기: 앞 대화를 기억함 (PINEAPPLE)", /pineapple/i.test(r2?.result || ""), r2?.result);
  ctx.check("이어 하기: 같은 session_id 를 씀", r2?.session_id === sid && initOf(b)?.session_id === sid);
  b.closeStdin();
  await b.waitExit(10000);
  ctx.info("이어 한 뒤 정상 종료 정보", JSON.stringify(b.exited));
  await b.shutdown();
}

export const scenarioNames = Object.keys(scenarios);
