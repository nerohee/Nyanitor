// 폴더 설정 확인 화면 (P10-10) — 종류마다 보이고, 빈 묶음은 안 보이고, `more` · 읽을 수 없는 이유 · 프로젝트 밖 파일 · 바뀜 띠 · 단추.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TrustFile } from "../../lib/ipc-types";
import { TrustDialog } from "./TrustDialog";
import type { TrustAsk } from "./sessionStore";

const list = <T,>(items: T[] = [], more = 0) => ({ items, more });
const file = (patch: Partial<TrustFile>): TrustFile => ({
  scope: "project",
  folder: null,
  path: ".claude/settings.json",
  unreadable: null,
  hooks: list(),
  commands: list(),
  allow: list(),
  permissionModes: [],
  additionalDirectories: list(),
  mcpServers: list(),
  plugins: list(),
  marketplaces: list(),
  switches: list(),
  envNames: list(),
  oddKeys: [],
  ...patch,
});
const ask = (files: TrustFile[], patch: Partial<TrustAsk> = {}): TrustAsk => ({ projectId: 1, stage: "ready", check: { required: true, hash: "h", summary: { files } }, changed: false, ...patch });
const show = (value: TrustAsk, handlers: { onGrant?: () => void; onCancel?: () => void } = {}) =>
  render(<TrustDialog ask={value} onGrant={handlers.onGrant ?? vi.fn()} onCancel={handlers.onCancel ?? vi.fn()} />);

describe("폴더 설정 확인 화면", () => {
  it("모든 종류가 보인다 — 훅(이벤트 · 매처 · 명령) · 명령 설정 · 허용 규칙 · 권한 모드 · 추가 폴더 · MCP · 플러그인 · 마켓 · 스위치 · env 이름 · 모양 이상한 키", () => {
    show(
      ask([
        file({
          hooks: list([
            { event: "PreToolUse", matcher: "Bash", kind: "command", text: "node check.js" },
            { event: "SessionStart", matcher: null, kind: "http", text: "https://example.test/x" },
          ]),
          commands: list([{ key: "statusLine", value: "node status.js" }]),
          allow: list(["Bash(npm run *)"]),
          permissionModes: [{ key: "permissions.defaultMode", value: "acceptEdits" }],
          additionalDirectories: list(["../shared"]),
          mcpServers: list([{ name: "files", target: "npx some-server" }]),
          plugins: list(["fancy@market"]),
          marketplaces: list([{ key: "market", value: "github:someone/market" }]),
          switches: list([{ key: "enableAllProjectMcpServers", value: "true" }]),
          envNames: list(["HTTPS_PROXY"]),
          oddKeys: ["hooks"],
        }),
      ]),
    );
    const dialog = screen.getByRole("dialog", { name: "이 폴더의 설정을 확인해 주세요" });
    for (const heading of [
      "자동 실행 명령 (훅)",
      "명령을 실행하는 설정",
      "허용 규칙 (묻지 않고 허용)",
      "권한 모드",
      "추가로 여는 폴더",
      "MCP 서버",
      "켜 둔 플러그인",
      "플러그인 마켓",
      "권한 · 격리를 넓히는 설정",
      "환경 변수 이름 (값은 보이지 않아요)",
      "모양이 이상한 설정 키 (내용을 알 수 없어요)",
    ]) {
      expect(within(dialog).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(within(dialog).getByText("PreToolUse · Bash · command")).toBeInTheDocument();
    expect(within(dialog).getByText("SessionStart · http")).toBeInTheDocument();
    expect(within(dialog).getByText("node check.js").tagName).toBe("CODE");
    expect(within(dialog).getByText("Bash(npm run *)")).toBeInTheDocument();
    expect(within(dialog).getByText("acceptEdits")).toBeInTheDocument();
    expect(within(dialog).getByText("HTTPS_PROXY")).toBeInTheDocument();
    expect(within(dialog).getByText("files")).toBeInTheDocument();
  });

  it("빈 묶음은 안 보이고, 목록 칸은 키보드로 스크롤할 수 있게 포커스를 받는다", () => {
    show(ask([file({ allow: list(["Edit"]) })]));
    expect(screen.getByRole("heading", { name: "허용 규칙 (묻지 않고 허용)" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "자동 실행 명령 (훅)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "MCP 서버" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "허용 규칙 (묻지 않고 허용) 내용 (길면 스크롤)" })).toHaveAttribute("tabindex", "0");
  });

  it("목록이 더 있으면 그 밖에 n개", () => {
    show(ask([file({ allow: list(["Edit"], 7), envNames: list([], 3) })]));
    expect(screen.getByText("그 밖에 7개")).toBeInTheDocument();
    // 보이는 항목이 없어도 더 있다고 하면 묶음은 보인다
    expect(screen.getByRole("heading", { name: "환경 변수 이름 (값은 보이지 않아요)" })).toBeInTheDocument();
    expect(screen.getByText("그 밖에 3개")).toBeInTheDocument();
  });

  it("읽을 수 없는 파일은 이유를 한국어로 — 이유마다", () => {
    const reasons = { link: "링크", too_large: "너무 커서", read_failed: "읽지 못했어요", not_a_file: "파일이 아니에요", invalid_json: "올바른 JSON", not_object: "객체가 아니에요" } as const;
    for (const [reason, text] of Object.entries(reasons)) {
      const view = show(ask([file({ unreadable: reason as keyof typeof reasons })]));
      expect(screen.getByText(new RegExp(`읽을 수 없어요.*${text}`))).toBeInTheDocument();
      view.unmount();
    }
  });

  it("프로젝트 밖(저장소 맨 위 · 본 저장소) 파일은 폴더와 함께 눈에 띄게 적는다 — 프로젝트 안 파일은 그렇지 않다", () => {
    show(
      ask([
        file({ path: ".claude/settings.json" }),
        file({ path: ".claude/settings.local.json", scope: "repo_root", folder: "C:\\dev\\bakery", allow: list(["Bash(git *)"]) }),
        file({ path: ".mcp.json", scope: "main_checkout", folder: "C:\\dev\\main", allow: list(["Edit"]) }),
      ]),
    );
    expect(screen.getByText("프로젝트 밖 · 저장소 맨 위 (C:\\dev\\bakery)")).toBeInTheDocument();
    expect(screen.getByText("프로젝트 밖 · 본 저장소 맨 위 (C:\\dev\\main)")).toBeInTheDocument();
    expect(screen.getByText("이 프로젝트 폴더")).toBeInTheDocument();
    expect(document.querySelectorAll('.wc-trust__file[data-outside="true"]')).toHaveLength(2);
  });

  it("바뀜 띠 · 읽는 중 · 단추", () => {
    const onGrant = vi.fn();
    const onCancel = vi.fn();
    const view = show(ask([file({ allow: list(["Edit"]) })], { changed: true }), { onGrant, onCancel });
    expect(screen.getByText(/확인하는 사이 바뀌었어요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "믿고 시작" }));
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onGrant).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    view.unmount();

    show({ projectId: 1, stage: "loading", check: null, changed: false });
    expect(screen.getByText("폴더 설정을 읽는 중이에요…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "믿고 시작" })).toBeDisabled();
  });

  it("적는 중에는 단추가 잠기고 Esc 로 닫히지 않는다", () => {
    const onCancel = vi.fn();
    show(ask([file({ allow: list(["Edit"]) })], { stage: "granting" }), { onCancel });
    expect(screen.getByRole("button", { name: "적는 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("열리면 제목에 포커스 · Esc = 취소", () => {
    const onCancel = vi.fn();
    show(ask([file({ allow: list(["Edit"]) })]), { onCancel });
    expect(screen.getByRole("heading", { level: 2 })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
