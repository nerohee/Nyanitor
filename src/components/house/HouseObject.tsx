// 집 사물 그림 (src/assets/house). 고양이와 같은 방식 — 파일을 문자열로 가져와 한 <svg> 안에 넣어야
// 시간대 색 변수(--house-*)가 닿는다. 크기는 판 단위 × var(--u) — 고양이(160 단위)와 같은 축척.
import type { CSSProperties } from "react";
import { svgInner } from "../cat/catParts";
import "./house.css";

const files = import.meta.glob<string>("../../assets/house/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

export type HouseObjectName =
  | "window"
  | "cat-tower"
  | "cat-wheel"
  | "bowl"
  | "litter-box"
  | "cushion"
  | "box-back"
  | "box-front"
  | "picture-frame"
  | "plant"
  | "lamp"
  | "shelf";

interface ObjectArt {
  inner: string;
  viewBox: string;
  width: number;
  height: number;
}

const objects = new Map<string, ObjectArt>();
for (const [path, raw] of Object.entries(files)) {
  const name = path.replace(/^.*\//, "").replace(/\.svg$/, "");
  const viewBox = /viewBox="([^"]+)"/.exec(raw)?.[1] ?? "0 0 100 100";
  const [, , width, height] = viewBox.split(/\s+/).map(Number);
  objects.set(name, { inner: svgInner(raw), viewBox, width, height });
}

export function houseObjectSize(name: HouseObjectName): { width: number; height: number } {
  const art = objects.get(name);
  return { width: art?.width ?? 0, height: art?.height ?? 0 };
}

/** 판 단위 크기를 CSS 길이로 (부모가 --u 를 정한다) */
export function units(n: number): string {
  return `calc(${n} * var(--u))`;
}

interface HouseObjectProps {
  name: HouseObjectName;
  className?: string;
  /** 캣휠 바퀴를 돌린다 (일하는 중) */
  spin?: boolean;
  style?: CSSProperties;
}

export function HouseObject({ name, className, spin, style }: HouseObjectProps) {
  const art = objects.get(name);
  if (!art) return null;
  return (
    <svg
      className={`house-obj house-obj--${name}${className ? ` ${className}` : ""}`}
      data-spin={spin ? "true" : undefined}
      viewBox={art.viewBox}
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
      style={style}
      dangerouslySetInnerHTML={{ __html: art.inner }}
    />
  );
}
