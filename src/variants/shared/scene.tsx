// 집 장면 조립 — 사물 위 고양이 자리, 고르기(키보드), 정보 패널 열고 닫기. 세 시안이 같이 쓴다.
// 위치는 시안이 정하고(x · bottom), 크기는 판 단위 × var(--u) (고양이 판 160 = 160u).
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CatFigure, type CatMotion, type CatPose } from "../../components/cat/CatFigure";
import { CAT_IDS, type CatId } from "../../components/cat/looks";
import { HouseObject, houseObjectSize, units, type HouseObjectName } from "../../components/house/HouseObject";
import { t } from "../../i18n/ko";
import { isWorking, type Activity, type AgentFixture } from "../fixtures";
import "./shared.css";

export const PANEL_ID = "house-cat-panel";

/** 고양이 고르기 · 정보 패널. Enter(버튼) 로 열고, Esc 로 닫으면 그 고양이 버튼으로 포커스가 돌아간다. */
/** 주소에 `&cat=nabi` 가 있으면 그 고양이 정보를 연 채로 시작 (스크린샷 · 고객 확인용) */
function catFromUrl(): CatId | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("cat");
  return CAT_IDS.find((id) => id === value) ?? null;
}

export function useCatPanel() {
  const [openCat, setOpenCat] = useState<CatId | null>(catFromUrl);
  const buttons = useRef(new Map<CatId, HTMLButtonElement>());

  const register = useCallback((cat: CatId, el: HTMLButtonElement | null) => {
    if (el) buttons.current.set(cat, el);
    else buttons.current.delete(cat);
  }, []);

  const toggle = useCallback((cat: CatId) => {
    setOpenCat((current) => (current === cat ? null : cat));
  }, []);

  const close = useCallback(() => {
    if (openCat) buttons.current.get(openCat)?.focus();
    setOpenCat(null);
  }, [openCat]);

  useEffect(() => {
    if (!openCat) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        buttons.current.get(openCat)?.focus();
        setOpenCat(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openCat]);

  return { openCat, register, toggle, close };
}

export type CatPanel = ReturnType<typeof useCatPanel>;

const POSE: Record<Activity, { pose: CatPose; motion: CatMotion }> = {
  wheel: { pose: "stand", motion: "run" },
  tower: { pose: "sit", motion: "idle" },
  window: { pose: "sit", motion: "idle" },
  sleep: { pose: "sleep", motion: "idle" },
  eat: { pose: "stand", motion: "eat" },
  box: { pose: "sit", motion: "idle" },
  walk: { pose: "stand", motion: "walk" },
  idle: { pose: "stand", motion: "idle" },
};

/** 사물 그림 + 그 위 고양이 자리(판 좌표) */
const STATION: Partial<Record<Activity, { back: HouseObjectName; front?: HouseObjectName; seat: [number, number] }>> = {
  wheel: { back: "cat-wheel", seat: [120, 214] },
  tower: { back: "cat-tower", seat: [80, 100] },
  window: { back: "window", seat: [100, 146] },
  sleep: { back: "cushion", seat: [75, 24] },
  box: { back: "box-back", front: "box-front", seat: [70, 92] },
};

/** 장면에 놓을 고양이 — 누구인지와 하는 일만 있으면 된다 */
export type CatAgent = Pick<AgentFixture, "cat" | "activity">;

interface CatButtonProps {
  agent: CatAgent;
  /** 없으면 누를 수 없는 그림 (작업 공간의 일하는 고양이) */
  panel?: CatPanel;
  /** 걷는 고양이는 방향을 CSS 로 뒤집는다 */
  flip?: boolean;
}

function CatButton({ agent, panel, flip }: CatButtonProps) {
  const { pose, motion } = POSE[agent.activity];
  const name = t(`cat.${agent.cat}.name`);
  const role = t(`cat.${agent.cat}.role`);
  const doing = t(`cat.activity.${agent.activity}`);
  const figure = <CatFigure cat={agent.cat} pose={pose} motion={motion} />;
  if (!panel) {
    return (
      <span className="cat-btn cat-btn--static" role="img" aria-label={`${name}, ${role}, ${doing}`}>
        <span className="cat-btn__figure">{flip ? <span className="walker__flip">{figure}</span> : figure}</span>
        <span className="cat-tag" aria-hidden="true">
          <b>{name}</b>
          <span className="cat-tag__role">{role}</span>
        </span>
      </span>
    );
  }
  const open = panel.openCat === agent.cat;
  return (
    <button
      type="button"
      className="cat-btn"
      data-working={isWorking(agent.activity) ? "true" : undefined}
      aria-label={`${name}, ${role}, ${doing}`}
      aria-expanded={open}
      aria-controls={open ? PANEL_ID : undefined}
      onClick={() => panel.toggle(agent.cat)}
      ref={(el) => panel.register(agent.cat, el)}
    >
      <span className="cat-btn__figure">{flip ? <span className="walker__flip">{figure}</span> : figure}</span>
      <span className="cat-tag" aria-hidden="true">
        <b>{name}</b>
        <span className="cat-tag__role">{role}</span>
      </span>
    </button>
  );
}

interface StationProps {
  agent: CatAgent;
  panel?: CatPanel;
  /** 장면 안 가로 위치 (CSS 길이, 사물 가운데) */
  x: string;
  /** 바닥(또는 벽)에서의 높이 (CSS 길이, 사물 아래 끝) */
  bottom: string;
  /** 걷는 고양이의 왕복 거리 (CSS 길이) */
  range?: string;
  /** 고양이 옆 말풍선 (시안 a) */
  bubble?: ReactNode;
  bubbleSide?: "above" | "left" | "right";
  bubbleAlign?: "top" | "bottom";
  className?: string;
  /** 앞뒤 (DOM 순서는 Tab 순서라 왼쪽 → 오른쪽으로 두고, 겹침은 z 로) */
  z?: number;
}

function Slot({
  agent,
  panel,
  bubble,
  bubbleSide = "above",
  bubbleAlign = "bottom",
  flip,
}: Pick<StationProps, "agent" | "panel" | "bubble" | "bubbleSide" | "bubbleAlign"> & { flip?: boolean }) {
  const open = panel?.openCat === agent.cat;
  return (
    <div className="cat-slot" data-open={open ? "true" : undefined} data-cat-slot={agent.cat}>
      <CatButton agent={agent} panel={panel} flip={flip} />
      {open && bubble && (
        <div className="cat-bubble" data-side={bubbleSide} data-align={bubbleAlign}>
          {bubble}
        </div>
      )}
    </div>
  );
}

/** 고양이 한 마리를 하는 일에 맞는 사물과 함께 놓는다 */
export function Station(props: StationProps) {
  const { agent, x, bottom, range, className, z } = props;
  const activity = agent.activity;
  const cls = `st st--${activity}${className ? ` ${className}` : ""}`;

  if (activity === "walk") {
    const style: CSSProperties = { left: x, bottom: `calc(${bottom} - ${units(12)})`, width: range ?? units(400), height: units(160), zIndex: z };
    return (
      <div className={cls} style={style}>
        <div className="walker">
          <Slot {...props} flip />
        </div>
      </div>
    );
  }

  if (activity === "eat" || activity === "idle") {
    const style: CSSProperties = {
      left: x,
      bottom: `calc(${bottom} - ${units(12)})`,
      width: units(activity === "eat" ? 240 : 160),
      height: units(160),
      marginLeft: units(activity === "eat" ? -120 : -80),
      zIndex: z,
    };
    const bowl = houseObjectSize("bowl");
    return (
      <div className={cls} style={style}>
        <div className="st__seat" style={{ left: 0, top: 0, width: units(160), height: units(160) }}>
          <Slot {...props} />
        </div>
        {activity === "eat" && (
          <div
            className="st__thing st__thing--front"
            style={{ left: units(125), top: units(148 - bowl.height + 1), width: units(bowl.width), height: units(bowl.height) }}
          >
            <HouseObject name="bowl" />
          </div>
        )}
      </div>
    );
  }

  const station = STATION[activity];
  if (!station) return null;
  const size = houseObjectSize(station.back);
  const [sx, sy] = station.seat;
  const style: CSSProperties = {
    left: x,
    bottom,
    width: units(size.width),
    height: units(size.height),
    marginLeft: units(-size.width / 2),
    zIndex: z,
  };
  return (
    <div className={cls} style={style}>
      <HouseObject name={station.back} spin={activity === "wheel"} />
      <div className="st__seat" style={{ left: units(sx - 80), top: units(sy - 148), width: units(160), height: units(160) }}>
        <Slot {...props} />
      </div>
      {station.front && (
        <div className="st__thing st__thing--front" style={{ inset: 0 }}>
          <HouseObject name={station.front} />
        </div>
      )}
    </div>
  );
}

/** 고양이 없는 사물 (장식 · 빈 모래 화장실 등) */
export function Thing({
  name,
  x,
  bottom,
  top,
  className,
  z,
}: {
  name: HouseObjectName;
  x: string;
  bottom?: string;
  top?: string;
  className?: string;
  z?: number;
}) {
  const size = houseObjectSize(name);
  const style: CSSProperties = {
    left: x,
    bottom,
    top,
    width: units(size.width),
    height: units(size.height),
    marginLeft: units(-size.width / 2),
    zIndex: z,
  };
  return (
    <div className={`thing thing--${name}${className ? ` ${className}` : ""}`} style={style} aria-hidden="true">
      <HouseObject name={name} />
    </div>
  );
}
