// P2-13 새 부품 — 입력칸 · 선택 상자 · 토글 · 고르기 단추 · 알림 띠 · 표 · 동전 · 진행 막대 · 단계 · 명령 상자 · 차이 보기.
// 모양은 parts.css (토큰은 tokens.css 의 "P2-13 부품" 절). 진짜 폼 요소를 쓴다 — 키보드 · 화면 읽기는 브라우저 기본 동작.
import { useEffect, useId, useState, type ReactNode } from "react";
import { HouseScene } from "../../components/house/HouseScene";
import { t, type TextKey } from "../../i18n/ko";
import type { DiffLine } from "../fixtures-screens";
import type { TimeOfDay } from "../query";
import { HouseNav, type NavPlace } from "../shared/HouseNav";
import { Icon, type IconName } from "../shared/icons";
import "../a/house.css";
import "../shared/shared.css";
import "./parts.css";

/** 새 화면들이 받는 것 (VariantFrame) */
export interface ScreenFrameProps {
  /** 지금 주소 — 다른 화면 · 상태로 가는 링크를 만든다 */
  search: string;
  /** 이 화면의 상태 (query.ts SCREEN_STATES) */
  state: string;
  time: TimeOfDay;
}

/** 왼쪽 메뉴 + 흐린 마당 위의 나무 쟁반 한 장 (작업 공간과 같은 짜임) */
export function ScreenShell({
  nav,
  time,
  className,
  children,
}: {
  nav: NavPlace;
  time: TimeOfDay;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`sc${className ? ` ${className}` : ""}`} data-nav={nav}>
      <HouseNav className="ha-nav" current={nav} />
      <div className="sc-stage">
        <HouseScene className="sc-backdrop" time={time} placements={[]} />
        {children}
      </div>
    </div>
  );
}

// ── 글자 ──

/** 화면 안에서만 읽히는 글 (화면 읽기 프로그램용) */
export function Sr({ children }: { children: ReactNode }) {
  return <span className="sr">{children}</span>;
}

// ── 상태 동전 ──

export type CoinStatus = "ok" | "missing" | "checking" | "waiting" | "failed" | "running" | "undone";

const COIN_ICON: Record<CoinStatus, IconName | null> = {
  ok: "check",
  missing: "alert",
  checking: null,
  running: null,
  waiting: "dot",
  failed: "close",
  undone: "undo",
};

/** 동그란 상태 표시 — 그림 기호만 (글자는 옆에 따로) */
export function Coin({ status, size }: { status: CoinStatus; size?: "sm" }) {
  const icon = COIN_ICON[status];
  return (
    <span className={`coin${size ? ` coin--${size}` : ""}`} data-status={status} aria-hidden="true">
      {icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : <span className="coin__spin" />}
    </span>
  );
}

// ── 칩 (짧은 표시) ──

export type ChipTone = "add" | "change" | "delete" | "keep" | "warn" | "plain" | "accent";

export function Chip({ tone = "plain", children }: { tone?: ChipTone; children: ReactNode }) {
  return (
    <span className="chip rnd" data-tone={tone}>
      {children}
    </span>
  );
}

// ── 알림 띠 ──

export type BannerTone = "info" | "ok" | "warn" | "danger";

const BANNER_ICON: Record<BannerTone, IconName> = { info: "info", ok: "check", warn: "alert", danger: "alert" };

export function Banner({
  tone,
  title,
  children,
  actions,
  live = false,
}: {
  tone: BannerTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** 바뀌면 읽어 주기 (오류 · 끝남) */
  live?: boolean;
}) {
  return (
    <div className="bnr" data-tone={tone} role={live ? (tone === "danger" ? "alert" : "status") : undefined}>
      <span className="bnr__icon" aria-hidden="true">
        <Icon name={BANNER_ICON[tone]} size={18} />
      </span>
      <div className="bnr__body">
        <p className="bnr__title rnd">{title}</p>
        {children}
      </div>
      {actions && <div className="bnr__actions">{actions}</div>}
    </div>
  );
}

// ── 입력칸 · 선택 상자 ──

export function Field({
  label,
  value,
  onChange,
  disabled,
  mono,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  mono?: boolean;
}) {
  return (
    <input
      className={`fld${mono ? " fld--mono" : ""}`}
      aria-label={label}
      value={value}
      disabled={disabled}
      spellCheck={false}
      onChange={(event) => onChange?.(event.target.value)}
    />
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <span className="sel" data-disabled={disabled ? "true" : undefined}>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.target.value);
          if (next) onChange(next.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevron" size={16} />
    </span>
  );
}

// ── 토글 ──

/** 켬 · 끔 스위치 — 손잡이 위치와 옆 글자로 알린다 (색만으로 알리지 않음) */
export function Toggle({ labelledBy, checked, onChange }: { labelledBy: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      className="tgl"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!checked)}
    >
      <span className="tgl__track" aria-hidden="true">
        <span className="tgl__knob" />
      </span>
      <span className="tgl__text" aria-hidden="true">
        {t(checked ? "variant.ui.on" : "variant.ui.off")}
      </span>
    </button>
  );
}

// ── 고르기 (진짜 라디오 — 화살표로 옮긴다) ──

/** 붙은 알약 단추 묶음 (짧은 선택지 2~4개) */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: IconName }>;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className="seg__opt rnd">
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          {option.icon && <Icon name={option.icon} size={16} />}
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/** 설명이 붙은 라디오 줄 (긴 선택지) */
export function RadioRows<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; desc?: string; badge?: ReactNode; extra?: ReactNode }>;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div className="rads" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <div key={option.value} className="rads__item" data-checked={value === option.value ? "true" : undefined}>
          <label className="rads__row">
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
            <span className="rads__dot" aria-hidden="true" />
            <span className="rads__text">
              <span className="rads__label">
                {option.label}
                {option.badge}
              </span>
              {option.desc && <span className="rads__desc">{option.desc}</span>}
            </span>
          </label>
          {option.extra && value === option.value && <div className="rads__extra">{option.extra}</div>}
        </div>
      ))}
    </div>
  );
}

// ── 진행 막대 ──

export function Progress({ label, value, max = 100 }: { label: string; value?: number; max?: number }) {
  const indeterminate = value === undefined;
  return (
    <div
      className="prg"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : value}
      data-indeterminate={indeterminate ? "true" : undefined}
    >
      <span style={indeterminate ? undefined : { width: `${(value / max) * 100}%` }} />
    </div>
  );
}

// ── 단계 ──

export function Stepper({ label, steps, current }: { label: string; steps: TextKey[]; current: number }) {
  return (
    <ol className="stp" aria-label={label}>
      {steps.map((key, i) => {
        const status = i < current ? "done" : i === current ? "now" : "todo";
        return (
          <li key={key} className="stp__item" data-status={status} aria-current={status === "now" ? "step" : undefined}>
            <span className="stp__num rnd" aria-hidden="true">
              {status === "done" ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span className="stp__label rnd">{t(key)}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ── 명령 상자 (복사) ──

export function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  const copy = () => {
    // 시제품 — 실제 앱에서는 Tauri clipboard 를 쓸 수도 있다 (P3)
    void navigator.clipboard?.writeText(command).catch(() => undefined);
    setCopied(true);
  };
  return (
    <div className="cmd">
      <code className="cmd__text selectable">{command}</code>
      <button type="button" className="hbtn cmd__copy" onClick={copy}>
        <Icon name={copied ? "check" : "copy"} size={16} />
        {t(copied ? "variant.ui.copied" : "variant.ui.copy")}
      </button>
      <span className="sr" role="status">
        {copied ? t("variant.ui.copied") : ""}
      </span>
    </div>
  );
}

// ── 차이 보기 ──

const SIGN_TEXT: Record<DiffLine["sign"], string> = { "+": "+", "-": "−", " ": " ", "@": "" };

export function DiffView({ lines, label }: { lines: readonly DiffLine[]; label: string }) {
  return (
    <div className="dif" role="region" aria-label={label} tabIndex={0}>
      <ol className="dif__lines">
        {lines.map((line, i) => (
          <li
            key={i}
            className="dif__line"
            data-sign={line.sign === " " ? "same" : line.sign === "+" ? "add" : line.sign === "-" ? "del" : "hunk"}
          >
            {line.sign === "@" ? (
              <span className="dif__hunk">{line.text}</span>
            ) : (
              <>
                <span className="dif__no" aria-hidden="true">
                  {line.old ?? ""}
                </span>
                <span className="dif__no" aria-hidden="true">
                  {line.new ?? ""}
                </span>
                <span className="dif__sign" aria-hidden="true">
                  {SIGN_TEXT[line.sign]}
                </span>
                {line.sign === "+" && <Sr>{t("variant.harness.kind.add")} </Sr>}
                {line.sign === "-" && <Sr>{t("variant.harness.kind.delete")} </Sr>}
                <code className="dif__text">{line.text || " "}</code>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── 설정 줄 (이름 · 설명 | 조작) ──

export function SettingRow({
  id,
  label,
  desc,
  control,
  children,
}: {
  id: string;
  label: ReactNode;
  desc?: ReactNode;
  control?: ReactNode;
  /** 줄 아래로 넓게 펼치는 것 (라디오 줄 · 띠) */
  children?: ReactNode;
}) {
  return (
    <div className="srow">
      <div className="srow__main">
        <div className="srow__text">
          <span className="srow__label" id={id}>
            {label}
          </span>
          {desc && <span className="srow__desc">{desc}</span>}
        </div>
        {control && <div className="srow__control">{control}</div>}
      </div>
      {children && <div className="srow__wide">{children}</div>}
    </div>
  );
}
