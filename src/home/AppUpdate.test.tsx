// 앱 새 판 화면 (P11-02) — 상태마다 줄 문구 · 단추, 설치 → 경고 → 「그래도 설치」(force: true), 진행 막대 값, update_busy,
// 대화상자 포커스 · Esc · 키보드 흐름, 언마운트 때 듣기 끊기. IPC 는 브라우저 가짜(`fakeUpdate`) 또는 `vi.spyOn` 으로.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeUpdate, FAKE_UPDATE_RELEASE, type FakeUpdateMode } from "../lib/fakeUpdate";
import { ipc } from "../lib/ipc";
import { AppError, type AppUpdateStatus } from "../lib/ipc-types";
import { AppUpdateDialog } from "./AppUpdateDialog";
import { AppUpdateLine } from "./AppUpdateLine";
import { CURRENT_VERSION, useAppUpdate } from "./useAppUpdate";

/** Home 과 같은 짝 — 줄은 카드 안, 대화상자는 밖 */
function Harness() {
  const update = useAppUpdate();
  return (
    <div>
      <aside aria-label="카드">
        <AppUpdateLine update={update} />
      </aside>
      {update.dialogOpen && <AppUpdateDialog update={update} />}
    </div>
  );
}

beforeEach(() => {
  fakeUpdate.reset({ mode: "new", pace: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fakeUpdate.reset();
});

function mode(next: FakeUpdateMode) {
  fakeUpdate.reset({ mode: next, pace: 0 });
}

const card = () => screen.getByRole("complementary", { name: "카드" });
/** 줄의 제목 · 작은 글 (소리용 숨은 글과 겹쳐 잡히지 않게) */
const LINE_TEXT = { selector: ".hm-update__title strong, .hm-update__detail" };
const lineText = (text: string | RegExp) => within(card()).getByText(text, LINE_TEXT);
const findLineText = (text: string | RegExp) => within(card()).findByText(text, LINE_TEXT);
const queryLineText = (text: string | RegExp) => within(card()).queryByText(text, LINE_TEXT);
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

/** 줄의 확인 단추를 눌러 새 판이 나타날 때까지 */
async function checked(title: RegExp) {
  render(<Harness />);
  click("새 판 확인");
  await findLineText(title);
}

/** 이벤트를 직접 보내 줄 수 있는 짝 (진행 막대 값 · 처음 읽기 시험) */
function controlled(first: AppUpdateStatus = { state: "idle" }) {
  let handler: ((status: AppUpdateStatus) => void) | null = null;
  const off = vi.fn();
  vi.spyOn(ipc, "appUpdateStatus").mockResolvedValue(first);
  vi.spyOn(ipc, "onAppUpdate").mockImplementation((next) => {
    handler = next;
    return Promise.resolve(off);
  });
  return {
    off,
    send: (status: AppUpdateStatus) => act(() => handler?.(status)),
  };
}

describe("줄 — 상태마다 문구 · 단추", () => {
  it("처음에는 지금 판 번호와 「새 판 확인」", async () => {
    render(<Harness />);
    expect(lineText(`Nyanitor ${CURRENT_VERSION}`)).toBeTruthy();
    expect(within(card()).getByRole("button", { name: "새 판 확인" })).toBeTruthy();
  });

  it("최신이면 「최신이에요」", async () => {
    mode("latest");
    render(<Harness />);
    click("새 판 확인");
    expect(await findLineText("최신이에요")).toBeTruthy();
    expect(lineText(`Nyanitor ${CURRENT_VERSION}`)).toBeTruthy();
  });

  it("확인 중에는 문구가 바뀌고 단추는 눌리지 않는다", async () => {
    const control = controlled();
    render(<Harness />);
    await waitFor(() => expect(ipc.onAppUpdate).toHaveBeenCalled());
    control.send({ state: "checking" });
    expect(lineText("새 판을 확인하는 중…")).toBeTruthy();
    expect((within(card()).getByRole("button", { name: "새 판 확인" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("새 판이 있으면 번호와 「바뀐 점 보기」", async () => {
    await checked(/새 판 0\.2\.0 이 있어요/);
    expect(within(card()).getByRole("button", { name: "바뀐 점 보기" })).toBeTruthy();
  });

  it("받는 중에는 줄에 받은 양, 받고 나면 「설치」", async () => {
    const control = controlled();
    render(<Harness />);
    await waitFor(() => expect(ipc.onAppUpdate).toHaveBeenCalled());
    control.send({ state: "downloading", version: "0.2.0", received: 6_000_000, total: 24_000_000 });
    expect(lineText("새 판 0.2.0 을 받는 중…")).toBeTruthy();
    expect(lineText("6.0 / 24.0 MB")).toBeTruthy();
    control.send({ state: "downloading", version: "0.2.0", received: 6_000_000, total: null });
    expect(lineText("6.0 MB 받음")).toBeTruthy();
    control.send({ state: "ready", version: "0.2.0" });
    expect(lineText("새 판 0.2.0 을 받았어요")).toBeTruthy();
    expect(within(card()).getByRole("button", { name: "설치" })).toBeTruthy();
  });

  it("이 설치 방식으로는 안 되면(deb) 그렇게 알린다", async () => {
    mode("deb");
    await checked(/새 판 0\.2\.0$/);
    expect(lineText("앱 안에서는 설치할 수 없어요")).toBeTruthy();
  });

  it("확인 실패는 「확인하지 못했어요」 + 「다시」, 다시 누르면 다시 확인한다", async () => {
    mode("fail");
    await checked(/확인하지 못했어요/);
    mode("new");
    click("다시");
    expect(await findLineText(/새 판 0\.2\.0 이 있어요/)).toBeTruthy();
  });

  it("어느 상태든 줄의 구조(제목 · 작은 글 · 단추 한 개)가 같다 — 카드 높이가 덜컥이지 않게", async () => {
    const control = controlled();
    render(<Harness />);
    await waitFor(() => expect(ipc.onAppUpdate).toHaveBeenCalled());
    const states: AppUpdateStatus[] = [
      { state: "idle" },
      { state: "checking" },
      { state: "latest" },
      { state: "available", release: FAKE_UPDATE_RELEASE },
      { state: "downloading", version: "0.2.0", received: 1, total: null },
      { state: "ready", version: "0.2.0" },
      { state: "unsupported", reason: "not_app_image", release: FAKE_UPDATE_RELEASE },
      { state: "failed", stage: "download", message: "x" },
    ];
    for (const status of states) {
      control.send(status);
      const line = card().querySelector(".hm-update");
      expect(line?.querySelectorAll(".hm-update__title").length, status.state).toBe(1);
      expect(line?.querySelectorAll(".hm-update__detail").length, status.state).toBe(1);
      expect(line?.querySelectorAll("button").length, status.state).toBe(1);
    }
  });
});

describe("처음 읽기 · 이벤트 · 언마운트", () => {
  it("처음에 읽은 상태를 보이고, 이벤트가 오면 따라간다", async () => {
    const control = controlled({ state: "available", release: FAKE_UPDATE_RELEASE });
    render(<Harness />);
    expect(await findLineText(/새 판 0\.2\.0 이 있어요/)).toBeTruthy();
    control.send({ state: "latest" });
    expect(lineText("최신이에요")).toBeTruthy();
  });

  it("언마운트하면 듣기를 끊는다", async () => {
    const control = controlled();
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(ipc.onAppUpdate).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(control.off).toHaveBeenCalledTimes(1);
  });
});

describe("대화상자", () => {
  it("바뀐 점을 마크다운으로 보이고, 첫 포커스는 「나중에」, Esc 로 닫으면 연 단추로 돌아온다", async () => {
    await checked(/새 판 0\.2\.0 이 있어요/);
    const opener = screen.getByRole("button", { name: "바뀐 점 보기" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "새 판 0.2.0" });
    expect(within(dialog).getByText("2026-11-20")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "바뀐 점" })).toBeTruthy();
    expect(within(dialog).getByText("새 고양이가 집에 들어왔어요")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "나중에" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Tab 은 대화상자 안에서만 돈다 (나중에 → 설치하고 다시 시작 → 나중에)", async () => {
    await checked(/새 판 0\.2\.0 이 있어요/);
    click("바뀐 점 보기");
    const dialog = await screen.findByRole("dialog");
    const install = within(dialog).getByRole("button", { name: "설치하고 다시 시작" });
    install.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "나중에" }));
  });

  it("바뀐 점이 없으면 그렇게 말하고, 잘렸으면 GitHub Releases 주소를 글로 보인다", async () => {
    const control = controlled();
    render(<Harness />);
    await waitFor(() => expect(ipc.onAppUpdate).toHaveBeenCalled());
    control.send({ state: "available", release: { version: "0.2.0", date: null, notes: null, notesTruncated: false } });
    click("바뀐 점 보기");
    expect(await screen.findByText("바뀐 점이 적혀 있지 않아요.")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    control.send({ state: "available", release: { version: "0.2.0", date: "2026-11-20", notes: "- 길어요", notesTruncated: true } });
    click("바뀐 점 보기");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/바뀐 점이 더 있어요/)).toBeTruthy();
    expect(within(dialog).getByText("https://github.com/nerohee/Nyanitor/releases")).toBeTruthy();
  });

  it("deb 는 설치 단추 없이 「닫기」 와 주소만", async () => {
    mode("deb");
    await checked(/새 판 0\.2\.0$/);
    click("바뀐 점 보기");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /설치/ })).toBeNull();
    expect(within(dialog).getByText(/앱 안에서 바꿀 수 없어요/)).toBeTruthy();
    expect(within(dialog).getByText("https://github.com/nerohee/Nyanitor/releases")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "닫기" }));
  });
});

describe("설치", () => {
  it("설치하면 같은 대화상자에서 진행 막대가 올라가고, 끝나면 다시 시작한다고 알린다", async () => {
    const control = controlled({ state: "available", release: FAKE_UPDATE_RELEASE });
    let finish: (value: Awaited<ReturnType<typeof ipc.appUpdateInstall>>) => void = () => undefined;
    const install = vi.spyOn(ipc, "appUpdateInstall").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<Harness />);
    await findLineText(/새 판 0\.2\.0 이 있어요/);
    click("바뀐 점 보기");
    click("설치하고 다시 시작");
    expect(install).toHaveBeenCalledWith(false);

    control.send({ state: "downloading", version: "0.2.0", received: 6_000_000, total: 24_000_000 });
    const bar = screen.getByRole("progressbar", { name: "새 판 받은 양" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-valuetext")).toBe("6.0 / 24.0 MB");
    // 포커스가 body 로 빠지지 않는다
    expect(document.activeElement).toBe(within(screen.getByRole("dialog")).getByRole("button", { name: "닫기" }));

    control.send({ state: "downloading", version: "0.2.0", received: 12_000_000, total: null });
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("12.0 MB 받음");

    control.send({ state: "ready", version: "0.2.0" });
    expect(screen.getByText("설치하고 다시 시작하는 중이에요…")).toBeTruthy();
    // 다시 시작하는 중에는 Esc 로 닫지 않는다
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => finish({ outcome: "restarting", warning: null, status: { state: "ready", version: "0.2.0" } }));
    // 다시 시작 결과가 와도 앱이 꺼질 때까지(정리에 몇 초) "다시 시작하는 중" 그대로 — 설치 단추가 다시 살아나지 않는다 (P11-06 5)
    expect(screen.getByText("설치하고 다시 시작하는 중이에요…")).toBeTruthy();
    expect(screen.queryByText("받아 두었어요", { exact: false })).toBeNull();
    const installButton = screen.queryByRole("button", { name: "설치하고 다시 시작" });
    expect(installButton === null || (installButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("경고가 오면 같은 대화상자에서 고른다 — 「그래도 설치」는 force: true 로 부른다", async () => {
    mode("warn");
    const install = vi.spyOn(ipc, "appUpdateInstall");
    await checked(/새 판 0\.2\.0 이 있어요/);
    click("바뀐 점 보기");
    click("설치하고 다시 시작");
    const note = await screen.findByTestId("update-warning");
    expect(note.textContent).toBe("지금 일하는 중이에요. 설치하면 멈춰요.");
    expect(install).toHaveBeenLastCalledWith(false);
    // 경고에서도 첫 포커스는 안전한 쪽
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "나중에" }));
    click("그래도 설치");
    expect(install).toHaveBeenLastCalledWith(true);
    expect(install).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByTestId("update-warning")).toBeNull());
  });

  it("경고에서 「나중에」 를 누르면 아무것도 설치하지 않고 닫는다", async () => {
    mode("warn");
    const install = vi.spyOn(ipc, "appUpdateInstall");
    await checked(/새 판 0\.2\.0 이 있어요/);
    click("바뀐 점 보기");
    click("설치하고 다시 시작");
    await screen.findByTestId("update-warning");
    click("나중에");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("경고 종류마다 문구가 다르다", async () => {
    const cases = [
      ["harness_fetch", "지금 하네스를 받는 중이에요. 설치하면 멈춰요."],
      ["harness_install", "지금 하네스를 설치하는 중이에요. 설치하면 멈춰요."],
    ] as const;
    for (const [warning, text] of cases) {
      const status: AppUpdateStatus = { state: "available", release: FAKE_UPDATE_RELEASE };
      controlled(status);
      vi.spyOn(ipc, "appUpdateInstall").mockResolvedValue({ outcome: "warning", warning, status });
      const { unmount } = render(<Harness />);
      await findLineText(/새 판 0\.2\.0 이 있어요/);
      click("바뀐 점 보기");
      click("설치하고 다시 시작");
      expect((await screen.findByTestId("update-warning")).textContent).toBe(text);
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("받다가 실패하면 대화상자에 알리고 「다시 확인」 으로 처음부터", async () => {
    mode("download_fail");
    await checked(/새 판 0\.2\.0 이 있어요/);
    click("바뀐 점 보기");
    click("설치하고 다시 시작");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("새 판을 받지 못했어요. 연결을 확인하고 다시 확인해 보세요.");
    expect(lineText("받지 못했어요")).toBeTruthy();
    click("다시 확인");
    // 확인이 끝나면 다시 새 판 — 바뀐 점과 설치 단추가 돌아온다
    expect(await screen.findByRole("button", { name: "설치하고 다시 시작" })).toBeTruthy();
  });
});

describe("update_busy", () => {
  it("이미 확인하는 중이면 거절 문구를 보인다 (줄 · 소리), 다음 소식이 오면 지운다", async () => {
    const control = controlled();
    vi.spyOn(ipc, "appUpdateCheck").mockRejectedValue(new AppError("update_busy", "busy"));
    render(<Harness />);
    await waitFor(() => expect(ipc.onAppUpdate).toHaveBeenCalled());
    click("새 판 확인");
    const text = "앱 업데이트를 확인하거나 받는 중이에요. 끝나면 다시 눌러 주세요.";
    await waitFor(() => expect(within(card()).getByRole("status").textContent).toBe(text));
    expect(card().querySelector(".hm-update__detail")?.getAttribute("title")).toBe(text);
    control.send({ state: "latest" });
    expect(queryLineText(text)).toBeNull();
  });

  it("설치가 busy 로 거절되면 대화상자에 알린다", async () => {
    controlled({ state: "available", release: FAKE_UPDATE_RELEASE });
    vi.spyOn(ipc, "appUpdateInstall").mockRejectedValue(new AppError("update_busy", "busy"));
    render(<Harness />);
    await findLineText(/새 판 0\.2\.0 이 있어요/);
    click("바뀐 점 보기");
    click("설치하고 다시 시작");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("받는 중이에요");
  });
});
