// 자세 그림 고양이 (docs/01-planning/cat-assets.md, cat-art-guide.md §3).
// 자세마다 그림 한 장(또는 프레임 몇 장)이고, 숨쉬기 · 깜빡임 · 꼬리 · 프레임 번갈기는 CSS 가 한다.
// 크기는 부모가 정한다 — 판(512) 전체가 부모 상자를 꽉 채우고, 발 기준점은 (50%, 94%) 다.
import { useEffect, useState, type CSSProperties } from "react";
import {
  catImageUrl,
  FALLBACK_CAT,
  findCat,
  PLATE,
  resolvePose,
  type CatEntry,
  type PoseName,
  type ResolvedPose,
} from "./catalog";
import "./cat.css";

export type { CatId, PoseName } from "./catalog";

/**
 * 자세 위의 CSS 움직임. 기본은 자세에서 정해진다 (`motionForPose`) —
 * 같은 자세라도 자리에 따라 다르게 (신발 돌의 sit = wait).
 */
export type CatMotion =
  | "breathe"
  | "sleep"
  | "groom"
  | "walk"
  | "look"
  | "wait"
  | "still";

const MOTION_BY_POSE: Record<PoseName, CatMotion> = {
  sit: "breathe",
  loaf: "breathe",
  sleep: "sleep",
  walk: "walk",
  groom: "groom",
};

export function motionForPose(pose: PoseName): CatMotion {
  return MOTION_BY_POSE[pose];
}

/** 같은 자세에서 그림이 겹쳐 바뀌는 시간 (cat-art-guide.md §3 — 자리 들고 나기 0.2s) */
const CROSSFADE_MS = 200;

/** 고양이 id 에서 0~1 사이 값 하나를 뽑는다 — 마리마다 박자가 조금씩 달라 한꺼번에 숨쉬지 않게 */
export function catSeed(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash / 997;
}

interface LayerProps {
  cat: CatEntry;
  resolved: ResolvedPose;
  motion: CatMotion;
  facing: "right" | "left";
  leaving?: boolean;
  /** 자세가 바뀌어 새로 나타나는 층 — 이전 자세 위로 겹쳐 흐려진다 (처음 나타날 때는 아님) */
  entering?: boolean;
}

/** 자세 하나의 그림 층 — 프레임 그림을 쌓고 CSS 가 번갈아 보인다 */
function PoseLayer({ cat, resolved, motion, facing, leaving, entering }: LayerProps) {
  const state = leaving ? " cat-layer--leaving" : entering ? " cat-layer--entering" : "";
  return (
    <span
      className={`cat-layer${state}`}
      data-pose={resolved.pose}
      data-motion={motion}
      data-facing={facing}
      data-frames={resolved.frames.length}
    >
      <span className="cat-layer__body">
        <span className="cat-layer__pose">
          {resolved.frames.map((file) => (
            <img key={file} className="cat-frame" src={catImageUrl(cat.id, file)} alt="" draggable={false} />
          ))}
          {resolved.blink && (
            <img className="cat-blink" src={catImageUrl(cat.id, resolved.blink)} alt="" draggable={false} />
          )}
        </span>
      </span>
    </span>
  );
}

function layerKey(resolved: ResolvedPose, motion: CatMotion, facing: string): string {
  return `${resolved.pose}|${motion}|${facing}`;
}

interface CatSpriteProps {
  /** 고양이 id (`catalog.json`). 목록에 없으면 먹물 */
  cat: string;
  pose?: PoseName;
  motion?: CatMotion;
  facing?: "right" | "left";
  /** 움직임 없이 첫 프레임으로 (채팅 · 목록 그림) */
  still?: boolean;
}

/** 부모 상자를 꽉 채우는 고양이 그림 한 장. 자세가 바뀌면 0.2초 겹쳐 흐린다. */
export function CatSprite({ cat: catId, pose = "sit", motion, facing = "right", still = false }: CatSpriteProps) {
  const entry = findCat(catId) ?? (findCat(FALLBACK_CAT) as CatEntry);
  const resolved = resolvePose(entry, pose) ?? (resolvePose(entry, "sit") as ResolvedPose);
  const wanted = still ? "still" : (motion ?? motionForPose(resolved.pose));

  // 이전 자세를 잠시 남겨 겹쳐 흐리게 (렌더 중에 파생 상태를 바꾸는 React 권장 방식)
  const key = layerKey(resolved, wanted, facing);
  const [shown, setShown] = useState({ key, resolved, motion: wanted, facing });
  const [leaving, setLeaving] = useState<typeof shown | null>(null);
  if (shown.key !== key) {
    setLeaving(shown);
    setShown({ key, resolved, motion: wanted, facing });
  }
  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(() => setLeaving(null), CROSSFADE_MS);
    return () => window.clearTimeout(id);
  }, [leaving]);

  const style = { "--seed": catSeed(entry.id) } as CSSProperties;
  return (
    <span className="cat-sprite" data-cat={entry.id} style={style}>
      {leaving && (
        <PoseLayer cat={entry} resolved={leaving.resolved} motion={leaving.motion} facing={leaving.facing} leaving />
      )}
      <PoseLayer
        cat={entry}
        resolved={shown.resolved}
        motion={shown.motion}
        facing={shown.facing}
        entering={leaving !== null}
      />
    </span>
  );
}

/** 얼굴만 잘라 보일 `sit` 그림의 정사각형 (판 좌표) — 머리 + 어깨 조금 */
const FACE_BOX = { x: 146, y: 112, size: 220 } as const;

/** 얼굴 아바타 (채팅 · 목록, 24~32px). 부모 상자를 채운다. */
export function CatFace({ cat: catId }: { cat: string }) {
  const entry = findCat(catId) ?? (findCat(FALLBACK_CAT) as CatEntry);
  const sit = resolvePose(entry, "sit");
  const file = sit?.frames[0];
  const { x, y, size } = FACE_BOX;
  const style: CSSProperties = {
    width: `${(PLATE.size / size) * 100}%`,
    left: `${(-x / size) * 100}%`,
    top: `${(-y / size) * 100}%`,
  };
  return (
    <span className="cat-face" data-cat={entry.id}>
      {file && <img src={catImageUrl(entry.id, file)} alt="" draggable={false} style={style} />}
    </span>
  );
}

interface CatFigureProps {
  /** 고양이 id */
  cat: string;
  pose?: PoseName;
  motion?: CatMotion;
  facing?: "right" | "left";
  /** 한 변 크기(px). 없으면 부모 크기를 꽉 채운다 */
  size?: number;
  /** 화면 읽기 프로그램용 이름. 없으면 장식으로 숨긴다 (버튼 · 이름표가 따로 이름을 줄 때) */
  label?: string;
  /** 얼굴만 잘라 보이기 (채팅 · 목록 아바타, cat-assets.md §A5) */
  crop?: "face";
}

/** 장면 밖에서 쓰는 고양이 — 정보 패널 · 채팅 · 목록 · 규격 확인. 장면은 `components/house/` 가 자리에 놓는다. */
export function CatFigure({ cat, pose = "sit", motion, facing = "right", size, label, crop }: CatFigureProps) {
  const box = size ?? "100%";
  return (
    <span
      className={crop ? "cat-figure cat-figure--face" : "cat-figure"}
      style={{ width: box, height: box }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {crop === "face" ? (
        <CatFace cat={cat} />
      ) : (
        <CatSprite cat={cat} pose={pose} motion={motion} facing={facing} still={motion === "still"} />
      )}
    </span>
  );
}
