// 앱 업데이트(새 판) 상태 — 처음에 한 번 읽고, 그 뒤는 Rust 의 `app:update` 이벤트를 따라간다 (시작 때 자동 확인은 Rust 가 조용히 한다).
// 확인 · 설치 명령의 결과도 같은 상태로 받는다. 한 번에 하나(`update_busy`)라 겹쳐 누르면 문구만 보인다.
import { useCallback, useEffect, useRef, useState } from "react";
import { isTextKey, t } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import { AppError, type AppUpdateRelease, type AppUpdateStatus, type AppUpdateWarning } from "../lib/ipc-types";
import pkg from "../../package.json";

/** 지금 판 번호 — `package.json` 의 `version` (`tauri.conf.json` 이 같은 파일을 가리킨다) */
export const CURRENT_VERSION: string = pkg.version;

export interface AppUpdateState {
  status: AppUpdateStatus;
  /** 마지막으로 본 새 판 정보 — 받는 중 · 준비됨 · 실패 때도 대화상자가 제목 · 바뀐 점을 보이도록 남긴다 */
  release: AppUpdateRelease | null;
  /** 앱을 끄면 안 되는 일이 있어 설치하지 않았다 — 사용자가 고를 차례 */
  warning: AppUpdateWarning | null;
  /** 명령이 거절된 까닭 (예: 이미 확인하는 중) — 다음 상태 소식이나 다음 누름에 지운다 */
  notice: string | null;
  /** 설치 명령이 아직 돌고 있다 */
  installing: boolean;
  dialogOpen: boolean;
  check: () => void;
  install: (force?: boolean) => void;
  openDialog: () => void;
  closeDialog: () => void;
}

/** 대화상자가 보일 수 있는 상태 */
const DIALOG_STATES: readonly AppUpdateStatus["state"][] = ["available", "downloading", "ready", "unsupported", "failed", "checking"];

function releaseOf(status: AppUpdateStatus): AppUpdateRelease | null {
  return status.state === "available" || status.state === "unsupported" ? status.release : null;
}

function noticeOf(error: unknown): string {
  const kind = error instanceof AppError ? error.kind : "internal";
  return isTextKey(`error.${kind}`) ? t(`error.${kind}`) : t("error.internal");
}

export function useAppUpdate(): AppUpdateState {
  const [status, setStatusRaw] = useState<AppUpdateStatus>({ state: "idle" });
  const [release, setRelease] = useState<AppUpdateRelease | null>(null);
  const [warning, setWarning] = useState<AppUpdateWarning | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [open, setOpen] = useState(false);
  /** 이벤트가 먼저 왔으면 처음 읽기의 (오래된) 답으로 덮지 않는다 */
  const heard = useRef(false);
  const alive = useRef(true);

  const apply = useCallback((next: AppUpdateStatus) => {
    setStatusRaw(next);
    const found = releaseOf(next);
    if (found) setRelease(found);
    // 새로 확인하거나 끝난 상태는 지난 경고 · 안내를 지운다
    if (next.state !== "downloading") setNotice(null);
    if (next.state === "idle" || next.state === "latest" || next.state === "checking") setWarning(null);
  }, []);

  useEffect(() => {
    alive.current = true;
    let unlisten: (() => void) | null = null;
    ipc
      .onAppUpdate((next) => {
        if (!alive.current) return;
        heard.current = true;
        apply(next);
      })
      .then(
        (off) => {
          if (alive.current) unlisten = off;
          else off();
        },
        () => undefined,
      );
    ipc.appUpdateStatus().then(
      (first) => {
        if (alive.current && !heard.current) apply(first);
      },
      () => undefined,
    );
    return () => {
      alive.current = false;
      unlisten?.();
    };
  }, [apply]);

  const check = useCallback(() => {
    setNotice(null);
    ipc.appUpdateCheck().then(
      (next) => {
        if (alive.current) apply(next);
      },
      (error: unknown) => {
        if (alive.current) setNotice(noticeOf(error));
      },
    );
  }, [apply]);

  const install = useCallback(
    (force = false) => {
      setNotice(null);
      setWarning(null);
      setInstalling(true);
      ipc.appUpdateInstall(force).then(
        (result) => {
          if (!alive.current) return;
          setInstalling(false);
          apply(result.status);
          if (result.outcome === "warning") setWarning(result.warning);
        },
        (error: unknown) => {
          if (!alive.current) return;
          setInstalling(false);
          setNotice(noticeOf(error));
        },
      );
    },
    [apply],
  );

  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => {
    setOpen(false);
    setWarning(null);
    setNotice(null);
  }, []);

  const dialogOpen = open && release !== null && DIALOG_STATES.includes(status.state) && !(status.state === "failed" && status.stage === "check");
  return { status, release, warning, notice, installing, dialogOpen, check, install, openDialog, closeDialog };
}
