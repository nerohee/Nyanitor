// 원본 바뀜 탭 — 통째로 바꾼 파일의 원본이 달라졌을 때 고른다. 왼쪽: 고르기 전인 항목들, 오른쪽: 「내 것과 원본 다른 점」(원본 쪽 −, 내 것 쪽 +) + 「원본으로 바꾸기」(확인) · 「내 것 유지」.
// 원본 옛 판 → 새 판 비교는 없다 (옛 원본 글을 남기지 않고 해시만 둔다). 고른 것은 적용 안 한 것에 더해진다 — 적용하면 기록에 남는다.
import { useEffect, useMemo, useState } from "react";
import { t, tf } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import type { AppErrorKind, CustomItemInfo, CustomItemRead } from "../lib/ipc-types";
import { diffLines, diffTooLarge, foldSameLines } from "../lib/textDiff";
import { errorKind } from "../workspace/errors";
import { errorLine, itemCat, itemLabel, refuseText } from "./format";
import { Banner, Chip, ConfirmDialog, DiffView, ItemFace } from "./parts";
import type { EditData } from "./useCustom";

/** 접지 않고 남기는 바뀐 줄 둘레 (위 · 아래 줄 수) */
const CONTEXT = 3;

interface Props {
  /** 원본이 바뀐 통째 파일들 (`originChanged: true`) */
  items: readonly CustomItemInfo[];
  data: EditData;
  report: (kind: AppErrorKind) => void;
  /** 「골라 보기」로 들어왔을 때 먼저 고를 항목 (`n` 이 바뀔 때마다 다시 그 항목으로) */
  focus: { id: string; n: number } | null;
}

type Chosen = { name: string; how: "keep" | "origin" };

export function OriginTab({ items, data, report, focus }: Props) {
  const [current, setCurrent] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const selected = items.find((item) => item.id === current) ?? items[0] ?? null;
  // 「골라 보기」로 들어오면 그 항목을 고른다 (그려지는 중에 맞추는 방식 — 같은 요청은 한 번만)
  const [seenFocus, setSeenFocus] = useState<number | null>(null);
  if (focus && focus.n !== seenFocus) {
    setSeenFocus(focus.n);
    setCurrent(focus.id);
  }

  if (items.length === 0)
    return (
      <div className="ed-split">
        <nav className="ed-list" aria-label={t("edit.origin.list")}>
          <p className="ed-list__note">{t("edit.origin.note")}</p>
        </nav>
        <section className="ed-panel">
          <div className="ed-panel__scroll">
            {chosen && <Banner tone="ok" live title={tf(chosen.how === "keep" ? "edit.origin.doneKeep" : "edit.origin.doneOrigin", { name: chosen.name })} />}
            <div className="ed-state" role="status">
              <p className="ed-state__title">{t("edit.origin.none")}</p>
              <p>{t("edit.origin.noneBody")}</p>
            </div>
          </div>
        </section>
      </div>
    );

  return (
    <div className="ed-split">
      <nav className="ed-list" aria-label={t("edit.origin.list")}>
        <p className="ed-list__note">{t("edit.origin.note")}</p>
        <ul className="ed-list__items">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" className="ed-item" aria-current={item.id === selected?.id ? "true" : undefined} onClick={() => {
                  setCurrent(item.id);
                  setChosen(null);
                }}>
                <ItemFace cat={itemCat(item.kind, item.name, data.roles, data.cats)} kind={item.kind} />
                <span className="ed-item__text">
                  <span className="ed-item__name">{itemLabel(item.kind, item.name, data.roles, data.labels)}</span>
                  <span className="ed-item__file">{item.file}</span>
                </span>
                <span className="ed-item__marks">
                  <Chip tone="delete">{t("edit.origin.needChoice")}</Chip>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {selected && <ChoicePanel key={`${selected.id}:${data.rev}`} item={selected} data={data} report={report} chosen={chosen} onChosen={setChosen} />}
    </div>
  );
}

type ReadState = { status: "loading" } | { status: "failed"; kind: AppErrorKind } | { status: "done"; read: CustomItemRead };

function ChoicePanel({ item, data, report, chosen, onChosen }: { item: CustomItemInfo; data: EditData; report: Props["report"]; chosen: Chosen | null; onChosen: (chosen: Chosen) => void }) {
  const [state, setState] = useState<ReadState>({ status: "loading" });
  const [confirming, setConfirming] = useState<null | { busy: boolean; problem: string | null }>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const label = itemLabel(item.kind, item.name, data.roles, data.labels);

  useEffect(() => {
    let alive = true;
    ipc.customItemRead(item.id).then(
      (read) => alive && setState({ status: "done", read }),
      (raw) => alive && setState({ status: "failed", kind: errorKind(raw) }),
    );
    return () => {
      alive = false;
    };
  }, [item.id]);

  const detail = state.status === "done" && state.read.state === "ok" ? state.read : null;
  const compare = useMemo(() => {
    if (!detail) return null;
    if (detail.originText.state !== "text" || detail.replaceText.state !== "text") return { kind: "unreadable" as const };
    if (diffTooLarge(detail.originText.text, detail.replaceText.text)) return { kind: "large" as const };
    const { lines, added, removed } = diffLines(detail.originText.text, detail.replaceText.text);
    return { kind: "ok" as const, lines: foldSameLines(lines, CONTEXT, (n) => tf("edit.origin.folded", { n })), same: added === 0 && removed === 0 };
  }, [detail]);

  const choose = async (how: "keep" | "origin") => {
    if (how === "origin") setConfirming({ busy: true, problem: null });
    setBusy(true);
    setProblem(null);
    try {
      await data.flushAll();
      const result = how === "keep" ? await ipc.customOriginKeep(item.id) : await ipc.customReplaceStop(item.id);
      if (result.outcome === "refused") {
        const text = refuseText(result.reason);
        if (how === "origin") setConfirming({ busy: false, problem: text });
        else setProblem(text);
        return;
      }
      onChosen({ name: label, how });
      setConfirming(null);
      // 고른 항목은 이 탭에서 빠지고(원본 바뀜 숫자가 줄어든다) 적용 바에 적용 안 한 것이 더해진다
      await data.refreshAll();
    } catch (raw) {
      const kind = errorKind(raw);
      if (how === "origin") setConfirming({ busy: false, problem: errorLine(kind) });
      else setProblem(errorLine(kind));
      report(kind);
    } finally {
      setBusy(false);
    }
  };

  const gone = detail?.originGone === true;

  return (
    <section className="ed-panel" aria-labelledby="ed-cf-title">
      <header className="ed-panel__head">
        <span className="ed-panel__face">
          <ItemFace cat={itemCat(item.kind, item.name, data.roles, data.cats)} kind={item.kind} />
        </span>
        <div className="ed-panel__titles">
          <h2 id="ed-cf-title" className="ed-panel__title">
            {tf("edit.origin.title", { name: label })}
          </h2>
          <p className="ed-panel__sub">{t("edit.origin.lead")}</p>
        </div>
      </header>
      <div className="ed-panel__scroll">
        {chosen && <Banner tone="ok" live title={tf(chosen.how === "keep" ? "edit.origin.doneKeep" : "edit.origin.doneOrigin", { name: chosen.name })} />}
        <Banner tone="info" title={t("edit.origin.safe")}>
          <p>{t("edit.origin.safeBody")}</p>
        </Banner>
        {problem && <Banner tone="danger" live title={problem} />}
        {state.status === "loading" && (
          <p className="ed-state" role="status">
            {t("edit.item.loading")}
          </p>
        )}
        {state.status === "failed" && <Banner tone="danger" live title={tf("edit.item.failed", { reason: errorLine(state.kind) })} />}
        {state.status === "done" && state.read.state !== "ok" && <Banner tone="danger" live title={t(state.read.state === "not_found" ? "edit.item.gone" : "edit.item.unreadable")} />}
        {detail && (
          <section className="ed-compare" aria-labelledby="ed-compare-title">
            <h3 id="ed-compare-title" className="ed-sec__title">
              {t("edit.origin.compare")}
            </h3>
            {gone ? (
              <p className="ed-note">{t("edit.origin.goneBody")}</p>
            ) : (
              <>
                <p className="ed-sec__lead">{t("edit.origin.compareHint")}</p>
                {compare?.kind === "unreadable" && <p className="ed-note">{t("edit.origin.compareUnreadable")}</p>}
                {compare?.kind === "large" && <p className="ed-note">{t("edit.origin.compareLarge")}</p>}
                {compare?.kind === "ok" && (compare.same ? <p className="ed-note">{t("edit.origin.compareSame")}</p> : <DiffView lines={compare.lines} label={t("edit.origin.compare")} />)}
              </>
            )}
          </section>
        )}
      </div>
      <footer className="ed-foot">
        <p className="ed-foot__note">{t("edit.origin.foot")}</p>
        {!gone && (
          <button type="button" className="ws-btn" disabled={busy || !detail} onClick={() => setConfirming({ busy: false, problem: null })}>
            {t("edit.origin.toOrigin")}
          </button>
        )}
        <button type="button" className="ws-btn ws-btn--primary" disabled={busy || !detail} onClick={() => void choose("keep")}>
          {t("edit.origin.keep")}
        </button>
      </footer>
      {confirming && (
        <ConfirmDialog
          titleId="ed-origin-confirm"
          title={tf("edit.origin.confirmTitle", { name: label })}
          confirmLabel={t("edit.origin.toOrigin")}
          danger
          busy={confirming.busy}
          problem={confirming.problem}
          onConfirm={() => void choose("origin")}
          onCancel={() => setConfirming(null)}
        >
          <p>{t("edit.origin.confirmBody")}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
