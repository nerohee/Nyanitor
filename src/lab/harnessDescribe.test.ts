import { describe, expect, it } from "vitest";
import type { GitResult, HarnessStatus, ScriptResult } from "../lib/ipc";
import {
  codeText,
  describeBackup,
  describeChange,
  describeGit,
  describeLocationSource,
  describeOrigin,
  describePruneSkipped,
  describeScriptHeadline,
  describeUnreadable,
  installSucceeded,
  isSandbox,
  planBlocker,
} from "./harnessDescribe";

const git = (patch: Partial<GitResult>): GitResult => ({
  outcome: "failed",
  reason: null,
  detail: null,
  head: null,
  before: null,
  update: null,
  pulled: [],
  pulledTotal: 0,
  ...patch,
});

const script = (patch: Partial<ScriptResult>): ScriptResult => ({
  outcome: "ran",
  exitCode: 0,
  report: null,
  raw: null,
  unreadable: null,
  restoreAdvised: false,
  script: null,
  prune: null,
  detail: null,
  reason: null,
  ...patch,
});

function report(patch: Record<string, unknown> = {}) {
  return {
    contract: 1,
    command: "install",
    ok: true,
    exitCode: 0,
    dryRun: true,
    claudeDir: null,
    harnessHome: null,
    repo: null,
    mode: null,
    developerMode: false,
    existingSource: null,
    restartNeeded: false,
    custom: null,
    changes: [],
    counts: { add: 0, change: 1, remove: 0, skip: 0, same: 2 },
    same: false,
    originChanged: [],
    problems: [],
    warnings: [],
    backup: null,
    backups: [],
    originHash: null,
    rolledBack: null,
    error: null,
    ...patch,
  } as NonNullable<ScriptResult["report"]>;
}

describe("코드를 글로 바꾸기", () => {
  it("아는 코드는 문구로, 모르는 코드는 글 그대로 (약속: 모르는 코드는 그대로 보인다)", () => {
    expect(codeText("lab.harness.action", "add")).toBe("새로");
    expect(codeText("lab.harness.action", "teleport")).toBe("teleport");
    expect(codeText("lab.harness.reason", "brandNew")).toBe("brandNew");
    expect(codeText("lab.harness.fileStatus", "Z")).toBe("Z");
  });

  it("바뀌는 목록 한 줄 — 모르는 동작 · 이유도 그대로", () => {
    expect(describeChange({ path: "agents/a.md", action: "change", type: "file", reason: null })).toBe("바뀜 — agents/a.md");
    expect(describeChange({ path: "x", action: "skip", type: "file", reason: "notOurs" })).toBe("건너뜀 — x (notOurs)");
    expect(describeChange({ path: "y", action: "warp", type: "file", reason: null })).toBe("warp — y");
  });
});

describe("받기 · 업데이트 결과", () => {
  it("모든 종류에 문구가 있고 해시가 비어도 죽지 않는다", () => {
    expect(describeGit(git({ outcome: "cloned", head: "abc1234" }))[0]).toBe("받았어요 — abc1234");
    expect(describeGit(git({ outcome: "updated", before: "a", head: "b" }))[0]).toBe("업데이트를 받았어요 — a → b");
    expect(describeGit(git({ outcome: "up_to_date" }))[0]).toBe("이미 최신이에요 — —");
    expect(describeGit(git({ outcome: "refused", reason: "dirty" }))[0]).toContain("직접 고친 파일");
    expect(describeGit(git({ outcome: "refused", reason: "somethingNew" }))[0]).toBe("받지 않았어요 — somethingNew");
    // 확인 없이 받으려 했다
    expect(describeGit(git({ outcome: "refused", reason: "check_first" }))[0]).toBe("받지 않았어요 — 먼저 업데이트를 확인해야 해요 — 확인한 커밋까지만 받아요");
  });

  it("git 의 말과 다른 원격 주소는 덧붙임 줄로", () => {
    expect(describeGit(git({ outcome: "failed", detail: "fatal: boom" }))).toEqual(["git 이 실패했어요", "git 의 말: fatal: boom"]);
    expect(
      describeGit(git({ outcome: "repo_unusable", reason: "remote_mismatch", detail: "https://example.com/a/b" })),
    ).toEqual([expect.stringContaining("원격 주소가 달라요"), "지금 원격 주소: https://example.com/a/b"]);
    // 원격이 아예 없으면 주소 줄은 없다
    expect(describeGit(git({ outcome: "repo_unusable", reason: "remote_mismatch" }))).toHaveLength(1);
  });

  it("미래의 결과 종류도 글 그대로 보인다", () => {
    expect(describeGit(git({ outcome: "teleported" as GitResult["outcome"] }))[0]).toBe("teleported");
  });
});

describe("원본 · 백업 · 스크립트 결과", () => {
  it("원본 표시: 종류마다, 읽을 수 없는 이유는 글로", () => {
    expect(describeOrigin({ kind: "none", path: null, marker: null, reason: null })).toContain("설치한 적이 없어요");
    expect(describeOrigin({ kind: "developer", path: "C:\\clone", marker: "link", reason: null })).toBe(
      "다른 원본을 가리켜요 (링크) — C:\\clone",
    );
    expect(describeOrigin({ kind: "unreadable", path: null, marker: "copy", reason: "mark_broken" })).toContain("원본 표시 파일이 깨졌어요");
    expect(describeOrigin({ kind: "unreadable", path: null, marker: null, reason: "weird" })).toContain("weird");
  });

  it("백업 한 줄: 읽을 수 없는 것은 그렇게 보인다", () => {
    const base = { id: "2026-10-18_143205", createdAt: "2026-10-18T14:32:05+0900", command: "install", added: 1, changed: 2, removed: 3, files: 5, bytes: 9, readable: true };
    expect(describeBackup(base)).toContain("새로 1 · 바뀜 2 · 지워짐 3 · 파일 5개");
    expect(describeBackup({ ...base, readable: false })).toBe("2026-10-18_143205 · 읽을 수 없는 백업");
  });

  it("스크립트 머리 줄과 읽을 수 없는 이유 (약속 버전은 글로)", () => {
    expect(describeScriptHeadline(script({ exitCode: 3 }))).toBe("끝났어요 (종료 코드 3)");
    expect(describeScriptHeadline(script({ outcome: "timed_out", exitCode: null }))).toContain("시간이 너무 오래");
    expect(describeScriptHeadline(script({ outcome: "no_script", exitCode: null }))).toContain("원본을 먼저 받아요");
    // 앱이 돌리지 않고 거절했다 — 이유가 같이 보이고, 모르는 이유는 글 그대로
    expect(describeScriptHeadline(script({ outcome: "refused", exitCode: null, reason: "plan_first" }))).toBe("하지 않았어요 — 미리보기를 본 적이 없어요 — 먼저 미리보기를 해 주세요");
    expect(describeScriptHeadline(script({ outcome: "refused", exitCode: null, reason: "source_changed" }))).toContain("원본이 바뀌었어요");
    expect(describeScriptHeadline(script({ outcome: "refused", exitCode: null, reason: "brandNew" }))).toBe("하지 않았어요 — brandNew");
    expect(
      describeUnreadable(script({ outcome: "unreadable", unreadable: { reason: "unknown_contract", contract: "2", head: "", stderrHead: "" } })),
    ).toBe("약속 버전을 몰라요 (contract 2)");
    expect(describeUnreadable(script({}))).toBeNull();
  });

  it("설치가 성공한 것은 읽혔고 · 종료 코드 0 · ok · 미리보기가 아닐 때뿐", () => {
    expect(installSucceeded(script({ report: report({ dryRun: false }) }))).toBe(true);
    expect(installSucceeded(script({ report: report({ dryRun: true }) }))).toBe(false);
    expect(installSucceeded(script({ report: report({ dryRun: false, ok: false }) }))).toBe(false);
    expect(installSucceeded(script({ exitCode: 3, report: report({ dryRun: false }) }))).toBe(false);
    expect(installSucceeded(script({ outcome: "unreadable", report: null }))).toBe(false);
  });
});

describe("설치를 눌러도 되는가 (미리보기 조건)", () => {
  it("미리보기가 없거나 낡았으면 막는다", () => {
    expect(planBlocker(null, false)).toContain("미리보기를 본 뒤");
    expect(planBlocker(script({ report: report() }), false)).toContain("다시 미리보기");
  });

  it("읽을 수 없음 · 종료 코드 아님 · 막는 문제가 있으면 막는다", () => {
    const blocked = "막는 문제가 있어서 설치할 수 없어요";
    expect(planBlocker(script({ outcome: "unreadable" }), true)).toBe(blocked);
    expect(planBlocker(script({ exitCode: 2, report: report({ ok: false }) }), true)).toBe(blocked);
    expect(planBlocker(script({ exitCode: 1, report: report() }), true)).toBe(blocked);
    expect(planBlocker(script({ report: report({ problems: [{ path: null, reason: "badPath", detail: null }] }) }), true)).toBe(blocked);
  });

  it("바뀔 것이 없으면 막고, 바뀔 것이 있고 문제가 없을 때만 통과", () => {
    expect(planBlocker(script({ report: report({ same: true }) }), true)).toContain("바뀔 것이 없어요");
    expect(planBlocker(script({ report: report() }), true)).toBeNull();
  });
});

describe("실제 폴더 판별 · 백업 정리 건너뜀", () => {
  const status = (patch: Partial<HarnessStatus>): HarnessStatus =>
    ({
      claudeDir: "C:/sandbox/claude",
      harnessHome: "C:/sandbox/hh",
      claudeDirFromEnv: true,
      harnessHomeFromEnv: true,
      claudeDirIsDefault: false,
      harnessHomeIsDefault: false,
      ...patch,
    }) as HarnessStatus;

  it("환경 변수로 정했고 기본 위치와 다를 때만 시험 폴더다", () => {
    expect(isSandbox(status({}))).toBe(true);
    expect(describeLocationSource(status({}))).toContain("환경 변수로 정한 위치");
  });

  it("환경 변수가 기본 위치를 가리키면 실제 폴더다 (한쪽만 가리켜도)", () => {
    for (const patch of [{ claudeDirIsDefault: true }, { harnessHomeIsDefault: true }, { claudeDirIsDefault: true, harnessHomeIsDefault: true }]) {
      expect(isSandbox(status(patch)), JSON.stringify(patch)).toBe(false);
      expect(describeLocationSource(status(patch))).toContain("기본 위치와 같은 폴더");
    }
  });

  it("환경 변수가 아닌 기본 위치 · 위치를 모르는 상태는 시험 폴더가 아니다", () => {
    expect(isSandbox(status({ claudeDirFromEnv: false, claudeDirIsDefault: true }))).toBe(false);
    expect(describeLocationSource(status({ claudeDirFromEnv: false, harnessHomeFromEnv: false, claudeDirIsDefault: true, harnessHomeIsDefault: true }))).toContain("기본 위치예요");
    expect(isSandbox(status({ claudeDir: null }))).toBe(false);
    expect(isSandbox(status({ harnessHome: null }))).toBe(false);
  });

  it("백업 정리를 건너뛴 이유: 잠금 · 링크 · 읽기 실패는 문구로, 모르는 이유는 글 그대로", () => {
    expect(describePruneSkipped("locked")).toContain("잠금이 남아 있어요");
    expect(describePruneSkipped("backups_is_link")).toContain("링크");
    expect(describePruneSkipped("read_failed")).toContain("읽지 못했어요");
    expect(describePruneSkipped("somethingNew")).toBe("somethingNew");
  });
});
