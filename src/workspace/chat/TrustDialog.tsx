// 폴더 설정 확인 (P10-10, D-54) — 세션을 시작하기 전에 폴더의 Claude Code 설정(자동 실행 명령 · 허용 규칙 · MCP 등)을 보이고 믿을지 묻는다.
// 내용이 길어 대화상자(`Dialog` — 열리면 제목에 포커스 · Tab 가두기 · Esc = 취소)로 연다. 경고지만 겁주지 않는 말투.
// 요약의 글은 Rust 가 앞 200자 · 목록 50개로 잘라 보낸다 — 여기서는 그대로 보이고, 넘친 개수(`more`)만 "그 밖에 n개" 로 적는다.
import { useId, useRef, type ReactNode } from "react";
import { t, tf, type TextKey } from "../../i18n/ko";
import type { TrustFile, TrustKeyEntry, TrustList } from "../../lib/ipc-types";
import { Icon } from "../../variants/shared/icons";
import { Dialog } from "../Dialog";
import type { TrustAsk } from "./sessionStore";

interface Props {
  ask: TrustAsk;
  onGrant: () => void;
  onCancel: () => void;
  /** 닫힌 뒤 연 단추가 사라졌을 때 포커스를 줄 곳 (시작되면 입력줄) */
  fallbackFocus?: () => HTMLElement | null;
}

/** 목록 한 묶음 — 항목이 없고 더 있다는 것도 없으면 그리지 않는다 */
function Group({ label, count, more, children }: { label: TextKey; count: number; more?: number; children: ReactNode }) {
  const id = useId();
  if (count === 0 && !more) return null;
  return (
    <section className="wc-trust__group" aria-labelledby={id}>
      <h4 id={id} className="wc-trust__kind">
        {t(label)}
      </h4>
      {/* 길면 칸 안에서 스크롤 — 키보드로도 닿게 tabIndex 0 */}
      <ul className="wc-trust__list" tabIndex={0} aria-label={tf("ws.trust.scroll", { what: t(label) })}>
        {children}
      </ul>
      {more ? <p className="wc-trust__more">{tf("ws.trust.more", { n: more })}</p> : null}
    </section>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="wc-trust__code">{children}</code>;
}

function keyRows(list: TrustList<TrustKeyEntry> | TrustKeyEntry[]): ReactNode[] {
  const items = Array.isArray(list) ? list : list.items;
  return items.map((entry, index) => (
    <li key={`${entry.key}-${index}`}>
      <span className="wc-trust__name">{entry.key}</span>
      <Mono>{entry.value}</Mono>
    </li>
  ));
}

function textRows(list: TrustList<string>): ReactNode[] {
  return list.items.map((item, index) => (
    <li key={`${item}-${index}`}>
      <Mono>{item}</Mono>
    </li>
  ));
}

function FileBlock({ file }: { file: TrustFile }) {
  const titleId = useId();
  const outside = file.scope !== "project";
  return (
    <section className="wc-trust__file" data-outside={outside ? "true" : undefined} aria-labelledby={titleId}>
      <h3 id={titleId} className="wc-trust__path">
        <code>{file.path}</code>
      </h3>
      <p className="wc-trust__scope">
        {outside && <Icon name="alert" size={14} />}
        {outside ? tf(file.scope === "repo_root" ? "ws.trust.scope.repo_root" : "ws.trust.scope.main_checkout", { folder: file.folder ?? "" }) : t("ws.trust.scope.project")}
      </p>
      {outside && <p className="wc-trust__hint">{t("ws.trust.scope.outsideHint")}</p>}
      {file.unreadable !== null && (
        <p className="wc-trust__unreadable">
          <Icon name="alert" size={14} />
          <span>
            {t("ws.trust.unreadable")} {t(`ws.trust.unreadable.${file.unreadable}`)}
          </span>
        </p>
      )}
      <Group label="ws.trust.kind.hooks" count={file.hooks.items.length} more={file.hooks.more}>
        {file.hooks.items.map((hook, index) => (
          <li key={`${hook.event}-${index}`}>
            <span className="wc-trust__name">
              {hook.matcher === null ? tf("ws.trust.hook.noMatcher", { event: hook.event, kind: hook.kind }) : tf("ws.trust.hook", { event: hook.event, matcher: hook.matcher, kind: hook.kind })}
            </span>
            <Mono>{hook.text}</Mono>
          </li>
        ))}
      </Group>
      <Group label="ws.trust.kind.commands" count={file.commands.items.length} more={file.commands.more}>
        {keyRows(file.commands)}
      </Group>
      <Group label="ws.trust.kind.allow" count={file.allow.items.length} more={file.allow.more}>
        {textRows(file.allow)}
      </Group>
      <Group label="ws.trust.kind.permissionModes" count={file.permissionModes.length}>
        {keyRows(file.permissionModes)}
      </Group>
      <Group label="ws.trust.kind.additionalDirectories" count={file.additionalDirectories.items.length} more={file.additionalDirectories.more}>
        {textRows(file.additionalDirectories)}
      </Group>
      <Group label="ws.trust.kind.mcpServers" count={file.mcpServers.items.length} more={file.mcpServers.more}>
        {file.mcpServers.items.map((server, index) => (
          <li key={`${server.name}-${index}`}>
            <span className="wc-trust__name">{server.name}</span>
            <Mono>{server.target}</Mono>
          </li>
        ))}
      </Group>
      <Group label="ws.trust.kind.plugins" count={file.plugins.items.length} more={file.plugins.more}>
        {textRows(file.plugins)}
      </Group>
      <Group label="ws.trust.kind.marketplaces" count={file.marketplaces.items.length} more={file.marketplaces.more}>
        {keyRows(file.marketplaces)}
      </Group>
      <Group label="ws.trust.kind.switches" count={file.switches.items.length} more={file.switches.more}>
        {keyRows(file.switches)}
      </Group>
      <Group label="ws.trust.kind.envNames" count={file.envNames.items.length} more={file.envNames.more}>
        {textRows(file.envNames)}
      </Group>
      <Group label="ws.trust.kind.oddKeys" count={file.oddKeys.length}>
        {file.oddKeys.map((key, index) => (
          <li key={`${key}-${index}`}>
            <Mono>{key}</Mono>
          </li>
        ))}
      </Group>
    </section>
  );
}

export function TrustDialog({ ask, onGrant, onCancel, fallbackFocus }: Props) {
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const files = ask.check?.summary.files ?? [];
  return (
    <Dialog titleId={titleId} onClose={onCancel} busy={ask.stage === "granting"} initialFocus={() => title.current} fallbackFocus={fallbackFocus}>
      <header className="ws-dlg__head">
        <h2 id={titleId} ref={title} tabIndex={-1} className="ws-dlg__title">
          {t("ws.trust.title")}
        </h2>
      </header>
      <div className="ws-dlg__body wc-trust">
        {ask.changed && (
          <p className="ws-note ws-note--warn" role="status">
            <Icon name="alert" size={14} />
            <span>{t("ws.trust.changed")}</span>
          </p>
        )}
        <p className="wc-trust__lead">{t("ws.trust.lead")}</p>
        {ask.check === null ? (
          <p className="wc-trust__wait" role="status">
            {t("ws.trust.loading")}
          </p>
        ) : (
          <div className="wc-trust__files" role="group" aria-label={t("ws.trust.files")} aria-busy={ask.stage === "loading"}>
            {files.map((file, index) => (
              <FileBlock key={`${file.scope}-${file.folder ?? ""}-${file.path}-${index}`} file={file} />
            ))}
          </div>
        )}
      </div>
      <footer className="ws-dlg__foot">
        <span className="ws-dlg__foot-note" />
        <button type="button" className="ws-btn" onClick={onCancel} disabled={ask.stage === "granting"}>
          {t("ws.trust.cancel")}
        </button>
        <button type="button" className="ws-btn ws-btn--primary" onClick={onGrant} disabled={ask.stage !== "ready"}>
          {ask.stage === "granting" ? t("ws.trust.granting") : t("ws.trust.go")}
        </button>
      </footer>
    </Dialog>
  );
}
