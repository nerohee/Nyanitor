// 내 수정 IPC (P9-01) — 명령 이름 · 인자 (경로를 보내는 길이 없다), 브라우저 가짜 내 수정(진짜와 같은 규칙: 목록 · 읽기 · 저장 · 적용 · 기록 · 되돌리기 · 원본 바뀜 · 고양이), 출시 빌드에서 가짜로 돌지 않음.
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCustom, parseFakeCustomQuery } from "./fakeCustom";
import { AppError, ipc, type CustomItemInfo, type CustomList } from "./ipc";

beforeEach(() => {
  fakeCustom.reset();
});

afterEach(() => {
  clearMocks();
  vi.unstubAllEnvs();
});

function item(list: CustomList, id: string): CustomItemInfo {
  const found = list.items.find((entry) => entry.id === id);
  if (found?.state !== "ok") throw new Error(`${id} 가 읽을 수 있는 항목으로 없다: ${JSON.stringify(list.items.map((e) => [e.id, e.state]))}`);
  return found;
}

async function failure(call: Promise<unknown>): Promise<AppError> {
  const error = await call.then(
    () => null,
    (raw: unknown) => raw,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("내 수정 ipc (Tauri 안)", () => {
  it("함수마다 정해진 명령을 부르고, 넘기는 인자는 항목 id · 값 · 글 · 새 항목 요청 · 커밋 번호 · 에이전트 이름 · 고양이 id · 보이는 이름 뿐이다", async () => {
    const handler = vi.fn(() => null);
    mockIPC(handler);
    await ipc.customList();
    await ipc.customItemRead("agent:harness-designer");
    await ipc.customValuesSave("skill:web-full", { model: "opus", effort: null });
    await ipc.customAppendSave("agent:harness-tester", "- 글");
    await ipc.customReplaceStart("agent:harness-designer");
    await ipc.customTextSave("agent:harness-designer", "---\n---\n");
    await ipc.customReplaceStop("agent:harness-designer");
    await ipc.customOriginKeep("agent:harness-designer");
    await ipc.customNew({ kind: "agent", name: "translator", description: "번역" });
    await ipc.customMineDelete("agent:translator");
    await ipc.customChanges();
    await ipc.customDiscard();
    await ipc.customApply("한 줄 요약");
    await ipc.customApply();
    await ipc.customHistory();
    await ipc.customCommitDiff("abcdef1");
    await ipc.customRestore("abcdef1");
    await ipc.customCatsRead();
    await ipc.customCatSave("designer", "mulgam");
    await ipc.customCatSave("designer", null);
    await ipc.customCatsSave([
      { agent: "ui", cat: "mulgam" },
      { agent: "designer", cat: null },
    ]);
    await ipc.customLabelsRead();
    await ipc.customLabelSave("translator", "번역");
    await ipc.customLabelSave("translator", null);
    expect(handler.mock.calls).toEqual([
      ["custom_list", {}],
      ["custom_item_read", { itemId: "agent:harness-designer" }],
      ["custom_values_save", { itemId: "skill:web-full", values: { model: "opus", effort: null } }],
      ["custom_append_save", { itemId: "agent:harness-tester", text: "- 글" }],
      ["custom_replace_start", { itemId: "agent:harness-designer" }],
      ["custom_text_save", { itemId: "agent:harness-designer", text: "---\n---\n" }],
      ["custom_replace_stop", { itemId: "agent:harness-designer" }],
      ["custom_origin_keep", { itemId: "agent:harness-designer" }],
      ["custom_new", { request: { kind: "agent", name: "translator", description: "번역" } }],
      ["custom_mine_delete", { itemId: "agent:translator" }],
      ["custom_changes", {}],
      ["custom_discard", {}],
      ["custom_apply", { summary: "한 줄 요약" }],
      ["custom_apply", { summary: null }],
      ["custom_history", {}],
      ["custom_commit_diff", { commit: "abcdef1" }],
      ["custom_restore", { commit: "abcdef1" }],
      ["custom_cats_read", {}],
      ["custom_cat_save", { agent: "designer", cat: "mulgam" }],
      ["custom_cat_save", { agent: "designer", cat: null }],
      [
        "custom_cats_save",
        {
          changes: [
            { agent: "ui", cat: "mulgam" },
            { agent: "designer", cat: null },
          ],
        },
      ],
      ["custom_labels_read", {}],
      ["custom_label_save", { agent: "translator", label: "번역" }],
      ["custom_label_save", { agent: "translator", label: null }],
    ]);
  });

  it("Rust 의 { kind: 'harness_busy' } · { kind: 'invalid_input' } 오류를 같은 종류의 AppError 로 받는다", async () => {
    for (const kind of ["harness_busy", "invalid_input", "file_write_failed"]) {
      mockIPC(() => {
        throw { kind, message: "x" };
      });
      expect(await failure(ipc.customApply())).toMatchObject({ kind });
    }
  });
});

describe("내 수정 ipc (브라우저 가짜)", () => {
  it("처음 모습: 오케스트레이터 + 여섯 작업자 + 스킬 넷 + 내가 만든 것 둘, 통째로 바꿔 원본이 바뀐 디자이너, 적용 안 한 것 없음", async () => {
    const list = await ipc.customList();
    expect(list).toMatchObject({ available: true, reason: null, developerMode: false, history: { state: "ok" }, unapplied: { known: true, count: 0, files: [] } });
    expect(list.items.map((entry) => entry.id)).toEqual([
      "main",
      "agent:harness-builder-system",
      "agent:harness-builder-ui",
      "agent:harness-designer",
      "agent:harness-helper",
      "agent:harness-reviewer",
      "agent:harness-tester",
      "agent:translator",
      "skill:desktop-app",
      "skill:harness-resume",
      "skill:translate-docs",
      "skill:web-full",
      "skill:web-lite",
    ]);
    expect(item(list, "main")).toMatchObject({ kind: "main", model: "opus", effort: "high", file: "config.local.json", marks: [] });
    expect(item(list, "agent:harness-builder-ui")).toMatchObject({ model: "sonnet", effort: "medium", myEffort: "high", currentEffort: "high", marks: ["values", "append"], originChanged: null });
    expect(item(list, "agent:harness-designer")).toMatchObject({ marks: ["replace"], originChanged: true });
    expect(item(list, "agent:harness-tester").marks).toEqual(["append"]);
    expect(item(list, "agent:translator")).toMatchObject({ marks: ["mine"], file: "agents/translator.md" });
    expect(item(list, "skill:translate-docs").marks).toEqual(["mine"]);
    expect(item(list, "skill:web-full").marks).toEqual(["append"]);
    expect(item(list, "agent:harness-helper")).toMatchObject({ model: "haiku", effort: "low", marks: [] });
    // 어느 항목에도 경로 글자가 없다 (표시용 상대 파일 이름뿐)
    expect(JSON.stringify(list)).not.toMatch(/[A-Za-z]:\\|\/home\/|\.claude/);
  });

  it("항목 하나 읽기: 원본 글 · 덧붙임 글 · 통째 글 · 원본에서 사라짐 · 없는 항목 · 모양이 틀린 id", async () => {
    const designer = await ipc.customItemRead("agent:harness-designer");
    expect(designer).toMatchObject({ state: "ok", originGone: false, info: { originChanged: true } });
    if (designer.state !== "ok") throw new Error("ok 여야 한다");
    expect(designer.originText.state).toBe("text");
    expect(designer.replaceText.state).toBe("text");
    expect(designer.appendText).toEqual({ state: "absent" });
    const ui = await ipc.customItemRead("agent:harness-builder-ui");
    expect(ui).toMatchObject({ state: "ok", appendText: { state: "text" }, replaceText: { state: "absent" } });
    expect(await ipc.customItemRead("agent:nothing-here")).toEqual({ state: "not_found" });
    for (const bad of ["", "agent:", "agent:../x", "agent:A", "skill:a/b", "agent:_common", "main ", "x", "agent:main"]) {
      expect(await failure(ipc.customItemRead(bad)), bad).toMatchObject({ kind: "invalid_input" });
    }
  });

  it("값 바꾸기: 원본 → 내 값 → 원본으로 (파일이 사라지고 표시도 사라진다), 목록 밖 값은 오류, 오케스트레이터도 된다", async () => {
    const result = await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: "medium" });
    expect(result).toMatchObject({ outcome: "saved", changed: true });
    let list = await ipc.customList();
    expect(item(list, "agent:harness-helper")).toMatchObject({ myModel: "sonnet", myEffort: "medium", currentModel: "sonnet", model: "haiku", marks: ["values"] });
    expect(list.unapplied).toMatchObject({ known: true, count: 1, files: [{ path: "agents/harness-helper.values.yml", status: "added" }] });
    expect(await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: "medium" })).toMatchObject({ outcome: "saved", changed: false });
    await ipc.customValuesSave("agent:harness-helper", { model: null, effort: null });
    list = await ipc.customList();
    expect(item(list, "agent:harness-helper").marks).toEqual([]);
    expect(list.unapplied.count).toBe(0);
    for (const values of [{ model: "banana", effort: null }, { model: null, effort: "max" }, { model: "OPUS", effort: null }]) {
      expect(await failure(ipc.customValuesSave("agent:harness-helper", values))).toMatchObject({ kind: "invalid_input" });
    }
    expect(await failure(ipc.customValuesSave("agent:harness-helper", { model: "opus", effort: null, path: "/x" } as never))).toMatchObject({ kind: "invalid_input" });
    // 오케스트레이터 — 원본(예시) 값과 다른 것만 내 값
    await ipc.customValuesSave("main", { model: "haiku", effort: "high" });
    const main = item(await ipc.customList(), "main");
    expect(main).toMatchObject({ myModel: "haiku", myEffort: null, currentModel: "haiku", currentEffort: "high", marks: ["values"] });
    // 내가 만든 것은 그 파일의 앞머리를 고친다
    await ipc.customValuesSave("agent:translator", { model: "opus", effort: null });
    expect(item(await ipc.customList(), "agent:translator")).toMatchObject({ model: "opus", effort: null, myModel: null });
  });

  it("덧붙임 · 통째 · 원본 바뀜: 시작 → 저장 → 원본이 바뀌면 true → 내 것 유지(false) / 원본으로(표시가 사라짐, 값 · 덧붙임은 남음)", async () => {
    expect(await ipc.customAppendSave("skill:web-lite", "- 덧붙임\n")).toMatchObject({ outcome: "saved", changed: true });
    expect(item(await ipc.customList(), "skill:web-lite").marks).toEqual(["append"]);
    expect(await ipc.customAppendSave("skill:web-lite", "  \n")).toMatchObject({ outcome: "saved", changed: true });
    expect(await ipc.customAppendSave("skill:web-lite", "")).toMatchObject({ outcome: "saved", changed: false });
    expect(await ipc.customAppendSave("main", "x")).toMatchObject({ outcome: "refused", reason: "not_supported" });
    expect(await ipc.customAppendSave("agent:translator", "x")).toMatchObject({ outcome: "refused", reason: "not_supported" });

    expect(await ipc.customReplaceStart("agent:harness-reviewer")).toMatchObject({ outcome: "saved", changed: true });
    expect(item(await ipc.customList(), "agent:harness-reviewer")).toMatchObject({ marks: ["replace"], originChanged: false });
    expect(await ipc.customReplaceStart("agent:harness-reviewer")).toMatchObject({ outcome: "refused", reason: "already_replaced" });
    expect(await ipc.customTextSave("agent:harness-reviewer", "---\nname: other\n---\n")).toMatchObject({ outcome: "refused", reason: "invalid_agent" });
    expect(await ipc.customTextSave("agent:harness-reviewer", "---\nname: harness-reviewer\nhooks:\n  x: y\n---\n")).toMatchObject({ outcome: "refused", reason: "invalid_agent" });
    expect(await ipc.customTextSave("agent:harness-reviewer", "---\nname: harness-reviewer\ndescription: 내 소개\n---\n새 글\n")).toMatchObject({ outcome: "saved", changed: true });
    expect(await ipc.customTextSave("agent:harness-helper", "x")).toMatchObject({ outcome: "refused", reason: "not_replaced" });

    // 원본이 바뀌었다 (디자이너는 이미 바뀐 상태 — 원본 바뀜 고르기)
    expect(item(await ipc.customList(), "agent:harness-designer").originChanged).toBe(true);
    expect(await ipc.customOriginKeep("agent:harness-designer")).toMatchObject({ outcome: "saved", changed: true });
    expect(item(await ipc.customList(), "agent:harness-designer")).toMatchObject({ originChanged: false, marks: ["replace"] });
    fakeCustom.simulateOriginUpdate();
    expect(item(await ipc.customList(), "agent:harness-designer").originChanged).toBe(true);
    // 원본으로 — 통째 글과 `.origin` 이 사라지고 값 · 덧붙임은 남는다
    await ipc.customValuesSave("agent:harness-designer", { model: "haiku", effort: null });
    expect(await ipc.customReplaceStop("agent:harness-designer")).toMatchObject({ outcome: "saved", changed: true });
    expect(item(await ipc.customList(), "agent:harness-designer")).toMatchObject({ marks: ["values"], originChanged: null });
    expect(await ipc.customReplaceStop("agent:harness-designer")).toMatchObject({ outcome: "refused", reason: "not_replaced" });
  });

  it("새로 만들기 · 지우기: 이름 규칙 · 원본에 같은 이름 · 이미 있는 이름 · 사용자 자신의 파일 알림 · 스킬은 폴더째", async () => {
    expect(await ipc.customNew({ kind: "agent", name: "reviewer-two", description: "문서: 두 번째 점검", model: "sonnet", effort: "low" })).toMatchObject({ outcome: "saved", changed: true, notOurs: false });
    const created = await ipc.customItemRead("agent:reviewer-two");
    if (created.state !== "ok") throw new Error("만든 것이 읽혀야 한다");
    expect(created.info).toMatchObject({ marks: ["mine"], model: "sonnet", effort: "low", description: "문서: 두 번째 점검" });
    expect(created.replaceText).toMatchObject({ state: "text" });
    if (created.replaceText.state !== "text") throw new Error("글이어야 한다");
    expect(created.replaceText.text.split("\n")[1]).toBe("name: reviewer-two");
    expect(created.replaceText.text).not.toContain("hooks:");
    expect(await ipc.customNew({ kind: "agent", name: "harness-designer", description: "x" })).toMatchObject({ outcome: "refused", reason: "name_in_source" });
    expect(await ipc.customNew({ kind: "agent", name: "reviewer-two", description: "x" })).toMatchObject({ outcome: "refused", reason: "name_taken" });
    expect(await ipc.customNew({ kind: "skill", name: "reviewer-two", description: "x" })).toMatchObject({ outcome: "saved" });
    expect(await ipc.customNew({ kind: "agent", name: "my-own-agent", description: "x" })).toMatchObject({ outcome: "saved", notOurs: true });
    for (const request of [
      { kind: "agent", name: "Bad", description: "x" },
      { kind: "agent", name: "main", description: "x" },
      { kind: "agent", name: "a/b", description: "x" },
      { kind: "agent", name: "ok", description: "" },
      { kind: "agent", name: "ok", description: "두 줄\n입니다" },
      { kind: "agent", name: "ok", description: "가".repeat(301) },
      { kind: "agent", name: "ok", description: "x", model: "banana" },
      { kind: "team", name: "ok", description: "x" },
      { kind: "agent", name: "ok", description: "x", path: "/etc" },
    ]) {
      expect(await failure(ipc.customNew(request as never)), JSON.stringify(request)).toMatchObject({ kind: "invalid_input" });
    }
    // 지우기 — 원본에 있는 것은 못 지운다
    expect(await ipc.customMineDelete("agent:harness-designer")).toMatchObject({ outcome: "refused", reason: "not_mine" });
    expect(await ipc.customMineDelete("skill:reviewer-two")).toMatchObject({ outcome: "saved", changed: true });
    expect(await ipc.customItemRead("skill:reviewer-two")).toEqual({ state: "not_found" });
    expect(await ipc.customMineDelete("skill:reviewer-two")).toMatchObject({ outcome: "refused", reason: "not_found" });
  });

  it("적용: 적용 안 한 것이 있을 때만 설치하고 커밋한다 — 한 줄 요약은 200자 · 한 줄로 다듬는다, 없으면 기본 문구", async () => {
    expect(await ipc.customApply()).toMatchObject({ outcome: "nothing", script: null, commit: "skipped", files: 0 });
    await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null });
    await ipc.customAppendSave("agent:harness-tester", "- 새 글\n");
    const before = (await ipc.customHistory()).commits.length;
    const applied = await ipc.customApply("  헬퍼 모델을\n\t바꿨다 ");
    expect(applied).toMatchObject({ outcome: "applied", commit: "committed", files: 2 });
    expect(applied.script?.report?.ok).toBe(true);
    const history = await ipc.customHistory();
    expect(history.commits.length).toBe(before + 1);
    expect(history.commits[0]).toMatchObject({ message: "헬퍼 모델을 바꿨다", kind: "apply", short: applied.commitShort });
    expect(history.commits[0]?.files).toEqual(["agents/harness-helper.values.yml", "agents/harness-tester.append.md"]);
    expect((await ipc.customList()).unapplied.count).toBe(0);
    // 기본 문구 · 200자 자르기
    await ipc.customValuesSave("agent:harness-helper", { model: null, effort: "high" });
    expect((await ipc.customApply("가".repeat(250))).commitShort).not.toBeNull();
    expect([...((await ipc.customHistory()).commits[0]?.message ?? "")].length).toBe(200);
    await ipc.customValuesSave("agent:harness-helper", { model: null, effort: "low" });
    await ipc.customApply("   ");
    expect((await ipc.customHistory()).commits[0]?.message).toBe("적용 — 파일 1개");
    // 새 에이전트가 든 적용은 `new`
    await ipc.customNew({ kind: "agent", name: "scribe", description: "기록" });
    await ipc.customApply();
    expect((await ipc.customHistory()).commits[0]?.kind).toBe("new");
  });

  it("적용이 실패하면 커밋하지 않고 적용 안 한 것으로 남는다 (설치 결과가 그대로 온다)", async () => {
    await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null });
    const before = (await ipc.customHistory()).commits.length;
    fakeCustom.failNextInstall();
    const failed = await ipc.customApply("실패");
    expect(failed).toMatchObject({ outcome: "failed", commit: "skipped", commitShort: null, files: 1 });
    expect(failed.script?.report).toMatchObject({ ok: false, exitCode: 2 });
    expect(failed.script?.report?.problems[0]?.reason).toBe("badValues");
    expect((await ipc.customHistory()).commits.length).toBe(before);
    expect((await ipc.customList()).unapplied.count).toBe(1);
    expect(await ipc.customApply()).toMatchObject({ outcome: "applied", commit: "committed" });
  });

  it("적용하면 바뀌는 것: 파일별 줄 단위 차이 (바뀜 · 새 파일 · 지움)와 버리기", async () => {
    await ipc.customValuesSave("agent:harness-builder-ui", { model: "opus", effort: "low" }); // 바뀜 (파일에 effort: high 줄이 있다)
    await ipc.customAppendSave("agent:harness-reviewer", "- 첫째\n- 둘째\n"); // 새 파일
    await ipc.customAppendSave("agent:harness-tester", ""); // 지움
    const changes = await ipc.customChanges();
    expect(changes).toMatchObject({ state: "ok", filesTotal: 3 });
    const by = Object.fromEntries(changes.files.map((file) => [file.path, file]));
    expect(by["agents/harness-builder-ui.values.yml"]).toMatchObject({ status: "changed", added: 2, removed: 1 });
    expect(by["agents/harness-builder-ui.values.yml"]?.lines.some((line) => line.sign === "+" && line.text === "model: opus")).toBe(true);
    expect(by["agents/harness-reviewer.append.md"]).toMatchObject({ status: "added", added: 2, removed: 0 });
    expect(by["agents/harness-reviewer.append.md"]?.lines[0]).toMatchObject({ sign: "@", text: "@@ -0,0 +1,2 @@" });
    expect(by["agents/harness-tester.append.md"]).toMatchObject({ status: "removed", added: 0, removed: 1 });
    expect(await ipc.customDiscard()).toEqual({ outcome: "discarded", files: 3 });
    expect((await ipc.customList()).unapplied.count).toBe(0);
    expect(await ipc.customDiscard()).toEqual({ outcome: "nothing", files: 0 });
    expect(item(await ipc.customList(), "agent:harness-tester").marks).toEqual(["append"]);
  });

  it("기록 목록 · 커밋 하나의 차이: 짧은 번호 · 종류 · 바뀐 파일, 모양이 틀린 번호는 오류, 없는 번호는 결과", async () => {
    const history = await ipc.customHistory();
    expect(history).toMatchObject({ state: "ok", truncated: false });
    expect(history.commits.map((c) => c.kind)).toEqual(["origin_update", "new", "apply", "apply", "new", "apply", "start"]);
    for (const commit of history.commits) {
      expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(commit.short).toBe(commit.hash.slice(0, 7));
      expect(commit.date).toMatch(/^2026-11-\d\dT\d\d:\d\d:00\+09:00$/);
    }
    const apply = history.commits.find((c) => c.message === "빌더 UI 수준 높임 · 지시 덧붙임");
    if (!apply) throw new Error("커밋이 있어야 한다");
    for (const ref of [apply.short, apply.hash]) {
      const diff = await ipc.customCommitDiff(ref);
      expect(diff).toMatchObject({ state: "ok", commit: { hash: apply.hash }, filesTotal: 2 });
      if (diff.state !== "ok") throw new Error("ok 여야 한다");
      expect(diff.files.map((f) => f.path)).toEqual(["agents/harness-builder-ui.append.md", "agents/harness-builder-ui.values.yml"]);
      expect(diff.files[0]?.status).toBe("added");
    }
    expect(await ipc.customCommitDiff("deadbee")).toEqual({ state: "unknown_commit" });
    for (const bad of ["", "abc", "ABCDEF1", "HEAD", "../x", "abc1234 --all"]) {
      expect(await failure(ipc.customCommitDiff(bad)), bad).toMatchObject({ kind: "invalid_input" });
    }
  });

  it("어느 때로 되돌리기: 적용 안 한 것이 있으면 거절 · 같은 모습이면 할 것 없음 · 그때 모습 + 새 커밋(이력은 그대로) · 설치가 실패하면 원래대로", async () => {
    const before = await ipc.customHistory();
    const target = before.commits.find((c) => c.message === "테스터 지시 덧붙임");
    if (!target) throw new Error("커밋이 있어야 한다");
    // 적용 안 한 것이 있으면 거절
    await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null });
    expect(await ipc.customRestore(target.short)).toMatchObject({ outcome: "has_unapplied", script: null, commit: "skipped" });
    await ipc.customDiscard();
    // 지금과 같은 모습
    expect(await ipc.customRestore(before.commits[0]?.hash ?? "")).toMatchObject({ outcome: "same_as_now" });
    expect(await ipc.customRestore("deadbee")).toMatchObject({ outcome: "unknown_commit" });
    expect(await failure(ipc.customRestore("HEAD"))).toMatchObject({ kind: "invalid_input" });
    // 설치가 실패하면 처음 모습으로
    fakeCustom.failNextInstall();
    expect(await ipc.customRestore(target.short)).toMatchObject({ outcome: "failed", commit: "skipped" });
    expect((await ipc.customHistory()).commits.length).toBe(before.commits.length);
    expect(item(await ipc.customList(), "skill:web-full").marks).toEqual(["append"]);
    // 되돌리기 — 그때는 웹 서비스 덧붙임도 새 스킬도 없었다
    const restored = await ipc.customRestore(target.short);
    expect(restored).toMatchObject({ outcome: "restored", commit: "committed" });
    const after = await ipc.customHistory();
    expect(after.commits.length).toBe(before.commits.length + 1);
    expect(after.commits[0]).toMatchObject({ kind: "restore", message: `${target.short} 때로 되돌림`, short: restored.commitShort });
    expect(after.commits.slice(1).map((c) => c.hash)).toEqual(before.commits.map((c) => c.hash));
    const list = await ipc.customList();
    expect(list.items.some((entry) => entry.id === "skill:translate-docs")).toBe(false);
    expect(item(list, "skill:web-full").marks).toEqual([]);
    expect(list.unapplied.count).toBe(0);
    expect(item(list, "agent:harness-tester").marks).toEqual(["append"]);
  });

  it("고양이 연결: 읽기 · 쓰기(그 파일만 커밋, 다른 적용 안 한 것은 그대로) · 지우기 · 모양이 틀린 이름 · 고양이 id 는 오류", async () => {
    expect(await ipc.customCatsRead()).toEqual({ state: "ok", agents: { translator: "dubu" } });
    await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null }); // 적용 안 한 것
    const before = (await ipc.customHistory()).commits.length;
    const saved = await ipc.customCatSave("designer", "mulgam");
    expect(saved).toMatchObject({ outcome: "saved", changed: true, commit: "committed" });
    const history = await ipc.customHistory();
    expect(history.commits.length).toBe(before + 1);
    expect(history.commits[0]).toMatchObject({ kind: "cats", files: ["agent-cats.json"], short: saved.commitShort });
    expect((await ipc.customList()).unapplied.files.map((f) => f.path)).toEqual(["agents/harness-helper.values.yml"]);
    expect((await ipc.customCatsRead()).agents).toEqual({ translator: "dubu", designer: "mulgam" });
    expect(await ipc.customCatSave("designer", "mulgam")).toMatchObject({ changed: false, commit: "skipped" });
    expect(await ipc.customCatSave("designer", null)).toMatchObject({ changed: true, commit: "committed" });
    expect((await ipc.customCatsRead()).agents).toEqual({ translator: "dubu" });
    await ipc.customCatSave("main", "mukmul");
    for (const [agent, cat] of [["Bad", "x"], ["a/b", "x"], ["", "x"], ["ui", "Bad Cat"], ["ui", "../x"], ["ui", ""]] as const) {
      expect(await failure(ipc.customCatSave(agent, cat)), `${agent} ${cat}`).toMatchObject({ kind: "invalid_input" });
    }
  });

  it("고양이 여러 줄: 한 번 쓰고 커밋 하나 · 맞바꿈 · 지움 섞기 · 바뀐 것 없음 · 하나라도 틀리면 아무것도 안 씀", async () => {
    await ipc.customCatsSave([
      { agent: "ui", cat: "danchu" },
      { agent: "designer", cat: "mulgam" },
    ]);
    await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null }); // 적용 안 한 것
    const before = (await ipc.customHistory()).commits.length;
    const swapped = await ipc.customCatsSave([
      { agent: "ui", cat: "mulgam" },
      { agent: "designer", cat: "danchu" },
      { agent: "translator", cat: null },
    ]);
    expect(swapped).toMatchObject({ outcome: "saved", changed: true, commit: "committed" });
    const history = await ipc.customHistory();
    expect(history.commits.length).toBe(before + 1);
    expect(history.commits[0]).toMatchObject({ kind: "cats", files: ["agent-cats.json"], short: swapped.commitShort });
    expect((await ipc.customCatsRead()).agents).toEqual({ ui: "mulgam", designer: "danchu" });
    expect((await ipc.customList()).unapplied.files.map((f) => f.path)).toEqual(["agents/harness-helper.values.yml"]);
    // 바뀐 것 없음 — 커밋 없음
    expect(await ipc.customCatsSave([{ agent: "designer", cat: "danchu" }])).toMatchObject({ changed: false, commit: "skipped", commitShort: null });
    expect((await ipc.customHistory()).commits.length).toBe(before + 1);
    // 하나라도 틀리면 아무것도 쓰지 않는다 (줄 수 · 같은 agent 두 번 · 틀린 이름 · 틀린 고양이 id · `cat` 빠뜨림 · 모르는 필드)
    const many = Array.from({ length: 65 }, (_, i) => ({ agent: `agent-${i}`, cat: "nabi" }));
    const wrong: Array<[string, unknown]> = [
      ["빈 목록", []],
      ["65 줄", many],
      ["같은 agent 두 번", [{ agent: "ui", cat: "nabi" }, { agent: "ui", cat: null }]],
      ["뒤의 틀린 이름", [{ agent: "system", cat: "nabi" }, { agent: "Bad", cat: "nabi" }]],
      ["뒤의 틀린 고양이", [{ agent: "system", cat: "nabi" }, { agent: "ui", cat: "Bad Cat" }]],
      ["cat 빠뜨림", [{ agent: "system", cat: "nabi" }, { agent: "ui" }]],
      ["모르는 필드", [{ agent: "system", cat: "nabi", extra: 1 }]],
    ];
    for (const [name, changes] of wrong) {
      expect(await failure(ipc.customCatsSave(changes as never)), name).toMatchObject({ kind: "invalid_input" });
    }
    expect((await ipc.customCatsRead()).agents).toEqual({ ui: "mulgam", designer: "danchu" });
    expect((await ipc.customHistory()).commits.length).toBe(before + 1);
    // 64 줄은 된다
    expect(await ipc.customCatsSave(many.slice(0, 64))).toMatchObject({ changed: true, commit: "committed" });
  });

  it("보이는 이름: 처음 모습의 translator 는 「번역」 · 쓰기(그 파일만 커밋, 종류 labels) · 앞뒤 공백 떼기 · 지우기 · 규칙 어긋남은 refused · 틀린 에이전트 이름은 오류", async () => {
    expect(await ipc.customLabelsRead()).toEqual({ state: "ok", agents: { translator: "번역" } });
    await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null }); // 적용 안 한 것
    const before = (await ipc.customHistory()).commits.length;
    const saved = await ipc.customLabelSave("summarizer", "  요약  ");
    expect(saved).toMatchObject({ outcome: "saved", reason: null, changed: true, commit: "committed" });
    const history = await ipc.customHistory();
    expect(history.commits.length).toBe(before + 1);
    expect(history.commits[0]).toMatchObject({ kind: "labels", message: "보이는 이름을 바꿈", files: ["agent-labels.json"], short: saved.commitShort });
    expect((await ipc.customList()).unapplied.files.map((f) => f.path)).toEqual(["agents/harness-helper.values.yml"]);
    expect((await ipc.customLabelsRead()).agents).toEqual({ translator: "번역", summarizer: "요약" });
    // 같은 이름 · 이미 없는 줄 지우기 = 바뀐 것 없음
    expect(await ipc.customLabelSave("summarizer", "요약")).toMatchObject({ changed: false, commit: "skipped" });
    expect(await ipc.customLabelSave("nobody", null)).toMatchObject({ changed: false, commit: "skipped" });
    // 빈 글 · null = 지움
    expect(await ipc.customLabelSave("summarizer", "   ")).toMatchObject({ changed: true, commit: "committed" });
    expect(await ipc.customLabelSave("translator", null)).toMatchObject({ changed: true, commit: "committed" });
    expect(await ipc.customLabelsRead()).toEqual({ state: "ok", agents: {} });
    // 규칙에 어긋난 이름은 refused + bad_label (아무것도 쓰지 않는다)
    const count = (await ipc.customHistory()).commits.length;
    for (const bad of ["가".repeat(21), "줄\n바꿈", "탭\t안", "제어\u001b문자", "문단\u2029나눔"]) {
      expect(await ipc.customLabelSave("translator", bad), bad).toMatchObject({ outcome: "refused", reason: "bad_label", changed: false, commit: "skipped" });
    }
    expect(await ipc.customLabelSave("translator", "가".repeat(20))).toMatchObject({ changed: true });
    expect((await ipc.customHistory()).commits.length).toBe(count + 1);
    for (const agent of ["main", "Bad", "a/b", "", "../x"]) {
      expect(await failure(ipc.customLabelSave(agent, "이름")), agent).toMatchObject({ kind: "invalid_input" });
    }
  });

  it("한 번에 하나: 쓰는 일이 겹치면 두 번째는 harness_busy, 읽기는 겹쳐도 된다", async () => {
    const first = ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null });
    const second = ipc.customAppendSave("agent:harness-tester", "- 겹침\n");
    const read = ipc.customList();
    expect(await failure(second)).toMatchObject({ kind: "harness_busy" });
    expect(await first).toMatchObject({ outcome: "saved" });
    expect((await read).available).toBe(true);
    expect((await ipc.customList()).unapplied.count).toBe(1);
  });
});

describe("내 수정 ipc (가짜 모드)", () => {
  it("주소 쿼리를 읽고 모르는 값은 기본값이다", () => {
    expect(parseFakeCustomQuery("")).toBe("full");
    expect(parseFakeCustomQuery("?custom=dirty")).toBe("dirty");
    expect(parseFakeCustomQuery("?custom=nope")).toBe("full");
    expect(parseFakeCustomQuery("?custom=no_git&x=1")).toBe("no_git");
  });

  it("dirty: 적용 안 한 것 둘이 처음부터 있다", async () => {
    fakeCustom.reset("dirty");
    const list = await ipc.customList();
    expect(list.unapplied).toMatchObject({ known: true, count: 2 });
    expect(list.unapplied.files.map((f) => f.path)).toEqual(["agents/harness-helper.values.yml", "agents/harness-reviewer.append.md"]);
    expect((await ipc.customChanges()).filesTotal).toBe(2);
  });

  it("fresh: 내 수정도 기록도 없다 — 처음 저장할 때 기록이 시작된다 (처음 기록 한 줄)", async () => {
    fakeCustom.reset("fresh");
    const list = await ipc.customList();
    expect(list).toMatchObject({ available: true, history: { state: "not_started" }, unapplied: { known: true, count: 0 } });
    expect(list.items.every((entry) => entry.state === "ok" && entry.marks.length === 0)).toBe(true);
    expect(await ipc.customHistory()).toMatchObject({ state: "not_started", commits: [] });
    expect(await ipc.customChanges()).toMatchObject({ state: "not_started", files: [] });
    expect(await ipc.customApply()).toMatchObject({ outcome: "nothing" });
    expect(await ipc.customDiscard()).toEqual({ outcome: "not_started", files: 0 });
    expect(await ipc.customRestore("abcdef1")).toMatchObject({ outcome: "not_started" });
    expect(await ipc.customCommitDiff("abcdef1")).toEqual({ state: "not_started" });
    await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null });
    const history = await ipc.customHistory();
    expect(history.commits.map((c) => [c.kind, c.message])).toEqual([["start", "처음 기록"]]);
    expect((await ipc.customList()).unapplied.count).toBe(1);
  });

  it("no_source: 하네스를 아직 받지 않았다 — 오류가 아니라 available: false", async () => {
    fakeCustom.reset("no_source");
    expect(await ipc.customList()).toMatchObject({ available: false, reason: "no_source", items: [] });
    expect(await ipc.customNew({ kind: "agent", name: "scribe", description: "기록" })).toMatchObject({ outcome: "refused", reason: "no_source" });
  });

  it("no_git: 저장 · 적용은 되고 기록만 없다 (오류가 아니다)", async () => {
    fakeCustom.reset("no_git");
    const list = await ipc.customList();
    expect(list.history.state).toBe("no_git");
    expect(list.unapplied).toEqual({ known: false, count: 0, files: [] });
    expect(await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null })).toMatchObject({ outcome: "saved", changed: true });
    expect(item(await ipc.customList(), "agent:harness-helper").myModel).toBe("sonnet");
    expect(await ipc.customHistory()).toMatchObject({ state: "no_git", commits: [] });
    expect(await ipc.customChanges()).toMatchObject({ state: "no_git" });
    expect(await ipc.customCommitDiff("abcdef1")).toEqual({ state: "no_git" });
    expect(await ipc.customDiscard()).toEqual({ outcome: "no_git", files: 0 });
    expect(await ipc.customRestore("abcdef1")).toMatchObject({ outcome: "no_git" });
    expect(await ipc.customApply()).toMatchObject({ outcome: "applied", commit: "no_git", commitShort: null });
    expect(await ipc.customCatSave("main", "mukmul")).toMatchObject({ outcome: "saved", changed: true, commit: "no_git" });
    expect(await ipc.customCatsSave([{ agent: "ui", cat: "mulgam" }, { agent: "designer", cat: "danchu" }])).toMatchObject({ outcome: "saved", changed: true, commit: "no_git" });
    expect(await ipc.customLabelSave("translator", "번역가")).toMatchObject({ outcome: "saved", changed: true, commit: "no_git" });
    expect((await ipc.customLabelsRead()).agents).toEqual({ translator: "번역가" });
  });

  it("install_fails: 적용 · 되돌리기가 늘 실패한다 (실패 화면을 눌러 볼 수 있게)", async () => {
    fakeCustom.reset("install_fails");
    await ipc.customValuesSave("agent:harness-helper", { model: "sonnet", effort: null });
    expect(await ipc.customApply()).toMatchObject({ outcome: "failed", commit: "skipped" });
    expect((await ipc.customList()).unapplied.count).toBe(1);
  });
});

describe("내 수정 ipc (출시 빌드 · Tauri 밖)", () => {
  it("가짜로 돌지 않고 모든 내 수정 명령이 internal 오류를 낸다", async () => {
    vi.stubEnv("DEV", false);
    const calls = [
      () => ipc.customList(),
      () => ipc.customItemRead("main"),
      () => ipc.customValuesSave("main", { model: null, effort: null }),
      () => ipc.customAppendSave("agent:x", "x"),
      () => ipc.customReplaceStart("agent:x"),
      () => ipc.customTextSave("agent:x", "x"),
      () => ipc.customReplaceStop("agent:x"),
      () => ipc.customOriginKeep("agent:x"),
      () => ipc.customNew({ kind: "agent", name: "x", description: "x" }),
      () => ipc.customMineDelete("agent:x"),
      () => ipc.customChanges(),
      () => ipc.customDiscard(),
      () => ipc.customApply(),
      () => ipc.customHistory(),
      () => ipc.customCommitDiff("abcdef1"),
      () => ipc.customRestore("abcdef1"),
      () => ipc.customCatsRead(),
      () => ipc.customCatSave("main", null),
      () => ipc.customCatsSave([{ agent: "main", cat: null }]),
      () => ipc.customLabelsRead(),
      () => ipc.customLabelSave("translator", null),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ kind: "internal" });
    }
  });

  it("Tauri 안에서는 DEV 가 false 여도 실제 명령을 부른다", async () => {
    vi.stubEnv("DEV", false);
    const handler = vi.fn(() => ({ outcome: "nothing", script: null, commit: "skipped", commitShort: null, files: 0, detail: null }));
    mockIPC(handler);
    await expect(ipc.customApply("요약")).resolves.toMatchObject({ outcome: "nothing" });
    expect(handler).toHaveBeenCalledWith("custom_apply", { summary: "요약" });
  });
});
