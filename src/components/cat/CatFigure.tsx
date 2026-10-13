import { CAT_ANCHOR, CAT_VIEWBOX, catPart } from "./catParts";
import { CAT_LOOKS, type CatId, type PatternId } from "./looks";
import "./cat.css";

export type { CatId } from "./looks";

/** 그림 자세 — stand 는 base/, sit · sleep 은 poses/ 프레임 (cat-assets.md §4) */
export type CatPose = "stand" | "sit" | "sleep";
/** 자세 위의 움직임 — 부위 변형 애니메이션 */
export type CatMotion = "idle" | "walk" | "run" | "eat" | "still";

interface CatFigureProps {
  /** 털색 묶음 (`tokens.css` 의 `[data-cat]`) + 생김새 (`looks.ts`) */
  cat: CatId;
  pose?: CatPose;
  motion?: CatMotion;
  facing?: "right" | "left";
  /** 한 변 크기(px). 없으면 부모 크기를 꽉 채운다 */
  size?: number;
  /** 화면 읽기 프로그램용 이름. 없으면 장식으로 숨긴다 (버튼 · 이름표가 따로 이름을 줄 때) */
  label?: string;
  /** 무늬를 바꿔 볼 때만 (기본은 looks.ts) */
  pattern?: PatternId;
  /** 규격 확인용 — viewBox 테두리 · 바닥선 · 기준점 표시 */
  guides?: boolean;
  /** 바닥 그림자 */
  shadow?: boolean;
  /** 얼굴만 잘라 보이기 (채팅 · 목록 아바타, cat-assets.md §1) */
  crop?: "face";
}

/** 우리 저장소 안의 부위 SVG 문자열만 넣는다 (사용자 입력이 들어오는 자리가 아니다). */
function Layer({ html, className }: { html: string; className: string }) {
  return <g className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 부위 + 그 부위의 무늬 층을 한 묶음으로 (다리가 움직이면 양말도 같이) */
function partWithPattern(file: string, pattern: PatternId, patternKey: string): string {
  const base = catPart(file);
  const overlay = pattern === "none" ? "" : catPart(`patterns/${pattern}-${patternKey}`);
  return base + overlay;
}

/** 서기 자세의 머리 (귀 포함) 둘레 */
const FACE_VIEWBOX = "74 24 76 76";

const HEAD_TRANSFORM: Record<CatPose, string | undefined> = {
  stand: undefined,
  sit: "translate(-12 -18)",
  sleep: "translate(-2 44) rotate(-6 112 96)",
};

/**
 * 고양이 한 마리. 부위 SVG 를 층 순서대로 쌓는다 (cat-assets.md §2).
 * 서기: 꼬리 → 먼 다리 → 몸통(+무늬) → 가까운 다리 → 머리 묶음(귀 → 머리(+무늬) → 눈 → 얼굴 → 소품)
 */
export function CatFigure({
  cat,
  pose = "stand",
  motion = "idle",
  facing = "right",
  size,
  label,
  pattern,
  guides = false,
  shadow = true,
  crop,
}: CatFigureProps) {
  const look = CAT_LOOKS[cat];
  const pat = pattern ?? look.pattern;
  const box = size ?? "100%";

  const head = (
    <g transform={HEAD_TRANSFORM[pose]}>
      <g className="cat__head">
        <Layer html={catPart("base/ear-left")} className="cat__ear cat__ear--left" />
        <Layer html={catPart("base/ear-right")} className="cat__ear cat__ear--right" />
        <Layer html={partWithPattern("base/head", pat, "head")} className="cat__skull" />
        <Layer html={catPart(pose === "sleep" ? "poses/sleep/eyes" : "base/eyes")} className="cat__eyes" />
        <Layer html={catPart("base/face")} className="cat__face" />
        {look.props.map((prop) => (
          <Layer key={prop} html={catPart(`props/${prop}`)} className={`cat__prop cat__prop--${prop}`} />
        ))}
      </g>
    </g>
  );

  let figure;
  if (pose === "sit") {
    figure = (
      <>
        <Layer html={catPart("poses/sit/tail")} className="cat__tail" />
        <g className="cat__torso">
          <Layer html={partWithPattern("poses/sit/body", pat, "sit-body")} className="cat__body" />
        </g>
        <Layer html={catPart("poses/sit/haunch")} className="cat__haunch" />
        <Layer html={catPart("poses/sit/leg-front-far")} className="cat__leg cat__leg--front-far" />
        <Layer html={catPart("poses/sit/leg-front-near")} className="cat__leg cat__leg--front-near" />
        {head}
      </>
    );
  } else if (pose === "sleep") {
    figure = (
      <>
        <g className="cat__torso">
          <Layer html={partWithPattern("poses/sleep/body", pat, "sleep-body")} className="cat__body" />
        </g>
        <Layer html={catPart("poses/sleep/tail")} className="cat__tail" />
        {head}
        <Layer html={catPart("poses/sleep/paws")} className="cat__paws" />
      </>
    );
  } else {
    figure = (
      <>
        <Layer html={catPart(look.tail === "kink" ? "base/tail-kink" : "base/tail")} className="cat__tail" />
        <Layer
          html={partWithPattern("base/leg-back-far", pat, "leg-back-far")}
          className="cat__leg cat__leg--back-far"
        />
        <Layer
          html={partWithPattern("base/leg-front-far", pat, "leg-front-far")}
          className="cat__leg cat__leg--front-far"
        />
        <g className="cat__torso">
          <Layer html={partWithPattern("base/body", pat, "body")} className="cat__body" />
        </g>
        <Layer
          html={partWithPattern("base/leg-back-near", pat, "leg-back-near")}
          className="cat__leg cat__leg--back-near"
        />
        <Layer
          html={partWithPattern("base/leg-front-near", pat, "leg-front-near")}
          className="cat__leg cat__leg--front-near"
        />
        {head}
      </>
    );
  }

  return (
    <svg
      className={crop ? "cat cat--face" : "cat"}
      data-cat={cat}
      data-pose={pose}
      data-motion={motion}
      viewBox={crop === "face" ? FACE_VIEWBOX : CAT_VIEWBOX}
      width={box}
      height={box}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {guides && (
        <g className="cat__guides">
          <rect x="0.5" y="0.5" width="159" height="159" />
          <line x1="0" y1={CAT_ANCHOR.y} x2="160" y2={CAT_ANCHOR.y} />
        </g>
      )}
      {shadow && !crop && <ellipse className="cat__shadow" cx={CAT_ANCHOR.x} cy={CAT_ANCHOR.y} rx="44" ry="4.5" />}
      <g transform={facing === "left" ? "matrix(-1 0 0 1 160 0)" : undefined}>
        <g className="cat__figure">{figure}</g>
      </g>
      {guides && <circle className="cat__anchor" cx={CAT_ANCHOR.x} cy={CAT_ANCHOR.y} r="2.5" />}
    </svg>
  );
}
