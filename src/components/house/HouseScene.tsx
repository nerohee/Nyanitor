// 고양이 집 장면 — 한옥 마당 그림 위에 물건 · 고양이를 겹침 순서(발 y)대로 놓는다 (cat-art-guide.md §2 · §4).
// 모든 위치는 배경 원본 픽셀(1536 × 1024)이고, `--u` (배경 1px 가 화면에서 얼마인가) 한 값으로 창 크기에 맞춘다.
// 배경은 상자를 꽉 채우고 넘치는 쪽을 자른다 (`crop` 으로 일부만 보일 수도 있다 — 작업 공간의 둥근 창문).
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { catScale, findCat, FALLBACK_CAT, PLATE, type CatEntry, type CatId } from "../cat/catalog";
import { CatSprite, motionForPose, type PoseName } from "../cat/CatFigure";
import { t } from "../../i18n/ko";
import type { CatPanel } from "./useCatPanel";
import { PANEL_ID } from "./useCatPanel";
import type { CatPlacement } from "./schedule";
import type { TimeOfDay } from "./time";
import {
  activityTextKey,
  ART,
  CHIME,
  depth,
  PROPS,
  SPOTS,
  spotDepth,
  STAGE,
  WORLD_SCALE,
  WHEEL_PLANE,
  type Prop,
  type Spot,
} from "./spots";
import "./house.css";

const houseImages = import.meta.glob<string>("../../assets/house/*.webp", {
  query: "?url",
  import: "default",
  eager: true,
});

function houseImageUrl(name: string): string {
  return houseImages[`../../assets/house/${name}.webp`] ?? "";
}

/** 배경 px → CSS 길이 */
function bg(n: number): string {
  return `calc(${n} * var(--u))`;
}

/** 이름표는 장면의 맨 위층 (시간대 덧씌우기 위) */
const TAG_Z = 100_002;

/** 자세마다 고양이가 차지하는 판 안 크기 (맞춘 그림에서 잰 값 — 누르는 자리의 크기) */
const POSE_BOX: Record<PoseName, { w: number; h: number }> = {
  sit: { w: 366, h: 362 },
  loaf: { w: 372, h: 253 },
  sleep: { w: 421, h: 305 },
  walk: { w: 466, h: 309 },
  eat: { w: 472, h: 299 },
  back: { w: 306, h: 380 },
  play: { w: 472, h: 343 },
  run: { w: 472, h: 267 },
  groom: { w: 424, h: 407 },
};

/** 그림자 타원 폭 (판 px) — 그림 폭의 약 55% (cat-assets.md §A6) */
const SHADOW_W: Record<PoseName, number> = {
  sit: 200,
  loaf: 200,
  sleep: 230,
  walk: 240,
  eat: 250,
  back: 160,
  play: 250,
  run: 250,
  groom: 230,
};
const SHADOW_RATIO = 0.22;

/**
 * 누운 자세(자기 · 식빵)는 몸 아래가 둥글어 바닥에 닿는 면이 좁아 붕 떠 보인다 —
 * 판을 이만큼(판 px) 내려 바닥 · 방석에 가라앉히고, 그림자는 작게 몸 아래로 바짝 붙인다. 다른 자세는 그대로.
 */
const SINK: Partial<Record<PoseName, number>> = { sleep: 16, loaf: 12 };
const SHADOW_TIGHT: Partial<Record<PoseName, number>> = { sleep: 175, loaf: 165 };

export interface Crop {
  /** 보여 줄 배경 영역 (배경 px) */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneInteraction {
  panel: CatPanel;
  /** 정보 패널 내용 — 열린 고양이의 것 */
  renderPanel: (cat: CatId) => ReactNode;
  /** 정보 패널이 놓일 층 — 장면 위 카드들보다도 앞에 있는 같은 크기의 빈 상자 (없으면 패널은 아직 안 보인다) */
  bubbleLayer: HTMLElement | null;
}

interface HouseSceneProps {
  time: TimeOfDay;
  /** 고양이 자리 (DOM · Tab 순서 그대로) */
  placements: readonly CatPlacement[];
  /** 있으면 고양이를 눌러 고를 수 있다 (집 화면). 없으면 장식 (작업 공간의 창문 · 배경) */
  interaction?: SceneInteraction;
  /** 일부만 보이게 자르기 (기본: 배경 전체를 꽉 채움) */
  crop?: Crop;
  /** 이름표 (기본: 누를 수 있을 때만) */
  tags?: boolean;
  /** 자리 표시 십자 — 좌표를 맞출 때만 */
  debug?: boolean;
  /** 있으면 이 이름의 영역(region)으로 알린다 (집 화면). 없으면 장식 */
  label?: string;
  className?: string;
}

// ── 물건 ──

function PropImage({ prop, spin, roll }: { prop: Prop; spin?: boolean; roll?: boolean }) {
  const art = ART[prop.art];
  const k = WORLD_SCALE * (prop.scale ?? 1);
  // 캣휠은 장면 각도(툇마루 방향)에 맞춰 기울인 판 안에 놓는다 — 바퀴와 받침이 같은 판을 쓴다
  const plane = prop.plane ? WHEEL_PLANE : null;
  const origin = plane ?? { x: 0, y: 0 };
  const style: CSSProperties = {
    left: bg(prop.at.x - art.ax * k - origin.x),
    top: bg(prop.at.y - art.ay * k - origin.y),
    width: bg(art.w * k),
    height: bg(art.h * k),
    zIndex: plane ? undefined : prop.z,
    transformOrigin: `${(art.ax / art.w) * 100}% ${(art.ay / art.h) * 100}%`,
  };
  const image = (
    <img
      className={`hs-prop hs-prop--${prop.id}`}
      data-spin={spin ? "true" : undefined}
      data-roll={roll ? "true" : undefined}
      src={houseImageUrl(art.file)}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={style}
    />
  );
  if (!plane) return image;
  return (
    <div
      className="hs-plane"
      style={{ left: bg(plane.x), top: bg(plane.y), width: bg(plane.w), height: bg(plane.h), zIndex: prop.z }}
    >
      {image}
    </div>
  );
}

// ── 고양이 ──

interface SceneCatProps {
  placement: CatPlacement;
  interaction?: SceneInteraction;
  tag: boolean;
  debug: boolean;
}

/** 정보 패널을 고양이 옆 빈 곳에 놓는다 — 자리마다 정한 쪽 순서대로, 장면 안에 들어가고 고양이를 가리지 않는 첫 곳 */
function placeBubble(bubble: HTMLElement, layer: HTMLElement, button: HTMLElement, spot: Spot) {
  const gap = 10;
  const margin = 8;
  const area = layer.getBoundingClientRect();
  const cat = button.getBoundingClientRect();
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  const tagRoom = 30; // 발 아래 이름표
  const centerX = cat.left + cat.width / 2;
  const centerY = cat.top + cat.height / 2;

  const candidates = spot.bubble.map((side) => {
    switch (side) {
      case "above":
        return { left: centerX - w / 2, top: cat.top - gap - h };
      case "below":
        return { left: centerX - w / 2, top: cat.bottom + tagRoom };
      case "left":
        return { left: cat.left - gap - w, top: centerY - h / 2 };
      case "right":
        return { left: cat.right + gap, top: centerY - h / 2 };
    }
  });
  const fits = (c: { left: number; top: number }) =>
    c.left >= area.left + margin &&
    c.top >= area.top + margin &&
    c.left + w <= area.right - margin &&
    c.top + h <= area.bottom - margin;
  const chosen = candidates.find(fits) ?? candidates[0];
  const left = Math.min(Math.max(chosen.left, area.left + margin), Math.max(area.left + margin, area.right - margin - w));
  const top = Math.min(Math.max(chosen.top, area.top + margin), Math.max(area.top + margin, area.bottom - margin - h));
  bubble.style.left = `${left - area.left}px`;
  bubble.style.top = `${top - area.top}px`;
}

function SceneCat({ placement, interaction, tag, debug }: SceneCatProps) {
  const { cat: catId, spot: spotId, pose, facing, walking, walkMs, fade, instant } = placement;
  const spot = SPOTS[spotId];
  const entry = findCat(catId) ?? (findCat(FALLBACK_CAT) as CatEntry);
  const k = WORLD_SCALE * catScale(entry);
  const box = POSE_BOX[pose];
  // 걷는 동안은 가는 자리의 깊이로 (옮겨 가는 길의 깊이는 따로 바꾸지 않는다)
  const z = walking ? depth(spot.feet.y) : spotDepth(spot);
  const motion = spot.motion?.[pose] ?? motionForPose(pose);
  // 상자에 "들어가 있는" 모습은 자리에 앉은 뒤부터 — 걸어 들어오는 동안은 몸이 다 보여야 한다
  const clip = walking ? undefined : spot.clip;
  const name = t(`cat.${catId}.name`);
  const role = t(`cat.${catId}.role`);
  const doing = t(`cat.activity.${activityTextKey(walking ? "walk" : spotId)}`);
  const open = interaction?.panel.openCat === catId;

  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // 정보 패널 자리 — 열릴 때, 고양이가 자리를 옮길 때, 창 크기가 바뀔 때
  const layer = interaction?.bubbleLayer ?? null;
  useLayoutEffect(() => {
    if (!open || !layer) return;
    const place = () => {
      if (bubbleRef.current && buttonRef.current) placeBubble(bubbleRef.current, layer, buttonRef.current, spot);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, layer, spot, walking]);

  const wrapperStyle: CSSProperties = {
    left: bg(spot.feet.x),
    top: bg(spot.feet.y),
    ["--k" as string]: bg(k),
    transitionDuration: walking ? `${walkMs}ms` : undefined,
    ["--walk-ms" as string]: `${walkMs}ms`,
  };
  const sink = SINK[pose] ?? 0;
  const hitStyle: CSSProperties = {
    left: `calc(${-box.w / 2} * var(--k))`,
    top: `calc(${-box.h + sink} * var(--k))`,
    width: `calc(${box.w} * var(--k))`,
    height: `calc(${box.h} * var(--k))`,
    zIndex: z,
  };
  // 판(512)은 누르는 상자 안에서 발 기준점이 상자 아래 가운데에 오도록
  const plateStyle: CSSProperties = {
    left: `calc(${box.w / 2 - PLATE.feetX} * var(--k))`,
    top: `calc(${box.h - PLATE.feetY + sink} * var(--k))`,
    width: `calc(${PLATE.size} * var(--k))`,
    height: `calc(${PLATE.size} * var(--k))`,
    // 상자: 앞 테두리(V) 아래는 잘라서 "들어가 있는" 모습
    clipPath:
      clip === undefined
        ? undefined
        : `polygon(${clip
            .map((pt) => `calc(${PLATE.feetX} * var(--k) + ${pt.x} * var(--u)) calc(${PLATE.feetY} * var(--k) + ${pt.y} * var(--u))`)
            .join(", ")})`,
  };
  const sprite = (
    <span className="hs-cat__plate" style={plateStyle}>
      <span className="hs-cat__lift" data-peek={spot.peek && !walking ? "true" : undefined}>
        <CatSprite cat={catId} pose={pose} motion={motion} facing={facing} />
      </span>
    </span>
  );

  const shadowW = SHADOW_TIGHT[pose] ?? SHADOW_W[pose];
  const shadowStyle: CSSProperties = {
    left: `calc(${-shadowW / 2} * var(--k))`,
    top: `calc(${(-shadowW * SHADOW_RATIO) / 2 + sink * 0.7} * var(--k))`,
    width: `calc(${shadowW} * var(--k))`,
    height: `calc(${shadowW * SHADOW_RATIO} * var(--k))`,
    zIndex: z - 1,
  };

  return (
    <div
      className="hs-cat"
      data-cat={catId}
      data-spot={spotId}
      data-walking={walking ? "true" : undefined}
      data-instant={instant ? "true" : undefined}
      data-fade={fade ?? undefined}
      data-open={open ? "true" : undefined}
      style={wrapperStyle}
    >
      {clip === undefined && <span className="hs-cat__shadow" aria-hidden="true" style={shadowStyle} />}
      {interaction ? (
        <button
          ref={(el) => {
            buttonRef.current = el;
            interaction.panel.register(catId, el);
          }}
          type="button"
          className="hs-cat__btn"
          style={hitStyle}
          aria-label={`${name}, ${role}, ${doing}`}
          aria-expanded={open}
          aria-controls={open ? PANEL_ID : undefined}
          onClick={() => interaction.panel.toggle(catId)}
        >
          {sprite}
        </button>
      ) : (
        <span className="hs-cat__btn hs-cat__btn--static" style={hitStyle} aria-hidden="true">
          {sprite}
        </span>
      )}
      {tag && (
        <span className="hs-tag" style={{ zIndex: TAG_Z }} aria-hidden="true">
          <b>{name}</b>
          <span className="hs-tag__role">{role}</span>
        </span>
      )}
      {open &&
        interaction &&
        layer &&
        createPortal(
          <div ref={bubbleRef} className="hs-bubble">
            {interaction.renderPanel(catId)}
          </div>,
          layer,
        )}
      {debug && <span className="hs-debug" style={{ zIndex: TAG_Z + 1 }} />}
    </div>
  );
}

// ── 장면 ──

export function HouseScene({
  time,
  placements,
  interaction,
  crop,
  tags,
  debug = false,
  label,
  className,
}: HouseSceneProps) {
  const view = crop ?? { x: 0, y: 0, w: STAGE.width, h: STAGE.height };
  const rootStyle = {
    "--cw": view.w,
    "--ch": view.h,
    "--cx": view.x + view.w / 2,
    "--cy": view.y + view.h / 2,
  } as CSSProperties;

  const spinning = placements.some((p) => p.spot === "wheel" && !p.walking);
  const rolling = placements.some((p) => p.spot === "ball" && p.pose === "play");
  const showTags = tags ?? interaction !== undefined;

  return (
    <section
      className={className ? `hs ${className}` : "hs"}
      data-time={time}
      style={rootStyle}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <div className="hs-stage">
        <img className="hs-bg" src={houseImageUrl("bg-day")} alt="" aria-hidden="true" draggable={false} />
        {/* 시간대 덧씌우기 1 — 배경만 진하게 (배경 바로 위, 물건 · 고양이 아래) */}
        <div className="hs-tint hs-tint--bg" aria-hidden="true" />

        {PROPS.map((prop) => (
          <PropImage
            key={prop.id}
            prop={prop}
            spin={prop.id === "wheel-ring" && spinning}
            roll={prop.id === "ball" && rolling}
          />
        ))}
        <PropImage prop={CHIME} />

        {placements.map((placement) => (
          <SceneCat key={placement.cat} placement={placement} interaction={interaction} tag={showTags} debug={debug} />
        ))}

        {/* 덧씌우기 2 — 모두 옅게 · 불빛 층. 이름표 · 카드는 덧씌우지 않는다 */}
        <div className="hs-tint hs-tint--all" aria-hidden="true" />
        <div className="hs-light" aria-hidden="true" />
      </div>
    </section>
  );
}
