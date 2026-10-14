"""물건 기준 맞춤 · 겹쳐 보기 — fit.py 가 쓰는 그림 계산 (Pillow 만, numpy 없음).

합친 그림(물건 + 고양이)을 같은 물건의 빈 그림에 겹쳐 맞춘다. 빈 그림의 알파를 틀로 삼아, 합친 그림에서
"물건 쪽 픽셀"(빈 그림의 불투명한 점)이 같은 색으로 가장 많이 겹치는 이동 · 배율을 찾는다.
고양이가 물건을 가리는 곳은 어느 이동에서도 안 겹치니 점수에 거의 같은 몫으로 빠져, 가려진 만큼 점수 상한이 낮아질 뿐이다.

좌표 약속 (판 = canvas, 픽셀 가장자리 기준의 연속 좌표):
    합친 그림의 점 p 는  q = c + scale * (p - c) + (dx, dy)  로 옮겨진다.  c = 판 가운데.
Placement(dx, dy, scale) 가 이것이다 — 표의 `nudge: [dx, dy, scale]` 도 같은 뜻.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from PIL import Image, ImageChops, ImageDraw, ImageFilter

MAX_SHIFT = 0.05  # 물건 가운데가 움직일 수 있는 한도 (판 가로 · 세로 대비)
SCALE_MIN, SCALE_MAX = 0.95, 1.05
SCALE_STEP = 0.0125  # 가장 거친 단계의 배율 간격
MIN_SCALE_STEP = 0.002  # 이보다 더 잘게는 나누지 않는다
MASK_THRESHOLD = 128  # 알파가 이 이상이면 물건 쪽 (불투명한 점)
COLOR_TOL = 48  # 같은 점으로 보는 색 차이 (R · G · B 중 가장 큰 차이)
MIN_LEVEL_SIDE = 64  # 거친 단계 그림의 짧은 변 하한
COARSE_FACTOR_MAX = 8  # 가장 거친 단계는 판을 최대 1/8 로
FINE_STEPS = ((1024, 4), (512, 2))  # (짧은 변이 이만큼 이상이면, 마지막 단계를 1/배수 로) — 판 위 1~2px 는 장면에서 0.5px 아래라 이 정도면 충분하고 빠르다
IDENTITY_MARGIN = 0.01  # 찾은 값이 이동 없이보다 이만큼도 낫지 않으면 옮기지 않는다 (다시 뽑아 흐려지는 것을 피한다)
SHIFT_PENALTY = 0.0005  # 점수가 같을 때 덜 움직인 쪽을 고르는 아주 작은 벌점 (한도까지 갔을 때 최대)
MAX_ITERATIONS = 40  # 한 단계에서 걸음 수 상한 (끝없이 도는 것을 막는다)
POLISH_SHIFT = 2  # 마지막에 훑는 이동 범위 (판 px, 사방)
POLISH_SCALE_STEPS = 10  # 마지막에 훑는 배율 범위 (MIN_SCALE_STEP 의 몇 배, 양쪽)
BEAM_WIDTH = 8  # 가장 거친 단계에서 다듬기 시작할 후보 수
BEAM_KEEP = 3  # 중간 단계에서 다음 단계로 데려갈 후보 수

OUTLINE_COLOR = (230, 0, 130)
BACKGROUND = (238, 234, 226)


class AlignError(Exception):
    pass


@dataclass(frozen=True)
class Placement:
    dx: float = 0.0
    dy: float = 0.0
    scale: float = 1.0

    @property
    def is_identity(self) -> bool:
        return self.dx == 0 and self.dy == 0 and self.scale == 1.0


@dataclass(frozen=True)
class AlignResult:
    placement: Placement  # 판 가운데 기준 (nudge 에 그대로 쓸 수 있다)
    object_shift: tuple[float, float]  # 물건 가운데가 실제로 움직인 양 (px)
    score: float  # 빈 물건 불투명 점 중 같은 색으로 겹친 비율 (0~1)
    identity_score: float  # 이동 없이 그대로일 때의 같은 점수
    coverage: float  # 빈 물건 불투명 점 중 합친 그림도 불투명한 비율 (고양이에 가려진 곳도 불투명이라 높게 나온다)
    at_limit: bool  # 이동 한도 · 배율 한도에 닿았다 — 실제 어긋남이 더 클 수 있다


def _coefficients(placement_center: tuple[float, float], d: tuple[float, float], s: float, factor: int):
    """출력 점 → 입력 점 아핀 계수 (연속 좌표). q = c + s(p - c) + d 의 거꾸로."""
    cx, cy = placement_center[0] / factor, placement_center[1] / factor
    dx, dy = d[0] / factor, d[1] / factor
    return (1 / s, 0, cx - (cx + dx) / s, 0, 1 / s, cy - (cy + dy) / s)


def _warp(img, size: tuple[int, int], center, d, s: float, factor: int, resample):
    return img.transform(size, Image.AFFINE, _coefficients(center, d, s, factor), resample=resample)


def apply_placement(img, placement: Placement):
    """합친 그림(RGBA) 을 placement 만큼 옮긴 같은 크기의 새 RGBA. 판 밖으로 나간 부분은 잘린다.
    이동이 정수이고 배율이 1 이면 픽셀을 그대로 옮긴다 (다시 뽑지 않는다)."""
    img = img.convert("RGBA")
    if placement.is_identity:
        return img.copy()
    W, H = img.size
    whole = placement.scale == 1.0 and placement.dx == round(placement.dx) and placement.dy == round(placement.dy)
    if whole:
        out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        out.paste(img, (int(placement.dx), int(placement.dy)))
        return out
    # 가장자리가 검게 번지지 않도록 알파를 곱한 채로 옮긴다
    premultiplied = img.convert("RGBa")
    moved = _warp(premultiplied, (W, H), (W / 2, H / 2), (placement.dx, placement.dy), placement.scale, 1, Image.BICUBIC)
    return moved.convert("RGBA")


def clipped_fraction(before, after, scale: float = 1.0) -> float:
    """옮기다 판 밖으로 나가 사라진 불투명 몫 (0~1). 배율 scale 만큼 넓이가 변하는 것(scale²) 은 사라진 것으로 세지 않는다."""
    expected = _alpha_sum(before) * scale * scale
    if expected <= 0:
        return 0.0
    return max(0.0, 1 - _alpha_sum(after) / expected)


def _alpha_sum(img) -> float:
    hist = img.getchannel("A").histogram()
    return float(sum(i * n for i, n in enumerate(hist)))


def _levels(W: int, H: int) -> list[int]:
    """거친 것 → 고운 것 순서의 축소 배수. 짧은 변이 MIN_LEVEL_SIDE 아래로 줄지 않게."""
    side = min(W, H)
    fine = next((f for min_side, f in FINE_STEPS if side >= min_side), 1)
    levels = [f for f in (8, 4, 2) if f <= COARSE_FACTOR_MAX and side // f >= MIN_LEVEL_SIDE and f > fine]
    return levels + [fine]


class _Scorer:
    """한 축소 단계의 겹침 점수. 빈 그림은 한 번만 줄이고, 후보 이동마다 합친 그림을 옮겨 센다."""

    def __init__(self, empty, moving, factor: int, tol: int):
        self.factor = factor
        e = empty.reduce(factor) if factor > 1 else empty
        self.moving = moving.reduce(factor) if factor > 1 else moving
        alpha_lut = [255 if v >= MASK_THRESHOLD else 0 for v in range(256)]
        mask = e.getchannel("A").point(alpha_lut)
        # 점수는 빈 물건의 불투명한 점에서만 세니, 그 상자 안만 옮겨 그리면 된다 (작은 물건일수록 크게 빨라진다)
        self.box = mask.getbbox() or (0, 0, 1, 1)
        self.size = (self.box[2] - self.box[0], self.box[3] - self.box[1])
        self.e_rgb = e.crop(self.box).convert("RGB")
        self.e_mask = mask.crop(self.box)
        self.count = max(1, self.e_mask.histogram()[255])
        self._alpha_lut = alpha_lut
        self._tol_lut = [255 if v <= tol else 0 for v in range(256)]
        self._cache: dict[tuple, tuple[float, float]] = {}

    def measure(self, center, d, s: float) -> tuple[float, float]:
        """(같은 색으로 겹친 비율, 합친 그림도 불투명한 비율)."""
        key = (round(d[0], 3), round(d[1], 3), round(s, 5))
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        a, b, c, d2, e, f = _coefficients(center, d, s, self.factor)
        # 출력 그림은 상자 안만 — 출력 (x, y) 는 단계 그림의 (x + 상자 왼쪽, y + 상자 위)
        coeffs = (a, b, c + a * self.box[0] + b * self.box[1], d2, e, f + d2 * self.box[0] + e * self.box[1])
        warped = self.moving.transform(self.size, Image.AFFINE, coeffs, resample=Image.BILINEAR)
        opaque = warped.getchannel("A").point(self._alpha_lut)
        r, g, bl = ImageChops.difference(warped.convert("RGB"), self.e_rgb).split()
        worst = ImageChops.lighter(ImageChops.lighter(r, g), bl).point(self._tol_lut)
        same = ImageChops.multiply(ImageChops.multiply(worst, opaque), self.e_mask)
        covered = ImageChops.multiply(opaque, self.e_mask)
        result = (same.histogram()[255] / self.count, covered.histogram()[255] / self.count)
        self._cache[key] = result
        return result


def find_alignment(
    empty, moving, *, max_shift: float = MAX_SHIFT, scale_range: tuple[float, float] = (SCALE_MIN, SCALE_MAX),
    color_tol: int = COLOR_TOL,
) -> AlignResult:
    """moving(합친 그림) 을 empty(빈 물건) 에 가장 잘 겹치는 이동 · 배율. 둘 다 같은 크기의 RGBA.
    물건 가운데의 이동은 판의 max_shift 이내, 배율은 scale_range(기본 0.95~1.05) 로 가둔다."""
    empty, moving = empty.convert("RGBA"), moving.convert("RGBA")
    if empty.size != moving.size:
        raise AlignError(f"빈 물건 {empty.width}x{empty.height} 과 합친 그림 {moving.width}x{moving.height} 의 크기가 다르다")
    W, H = empty.size
    mask = empty.getchannel("A").point([255 if v >= MASK_THRESHOLD else 0 for v in range(256)])
    box = mask.getbbox()
    if box is None:
        raise AlignError("빈 물건 그림이 전부 투명하다 — 틀로 쓸 수 없다")
    obj_center = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)  # 물건 가운데를 축으로 배율을 줄이고 늘린다
    limit = (max_shift * W, max_shift * H)
    smin, smax = scale_range
    if not 0 < smin <= 1 <= smax:
        raise AlignError(f"배율 범위 {smin}~{smax} 는 1 을 품어야 한다")
    half_span = max(smax - smin, 1e-9) / 2

    def penalty(d, s) -> float:
        return SHIFT_PENALTY * (abs(d[0]) / limit[0] + abs(d[1]) / limit[1] + abs(s - 1) / half_span)

    def clamp(d, s):
        return (min(limit[0], max(-limit[0], d[0])), min(limit[1], max(-limit[1], d[1]))), min(smax, max(smin, s))

    levels = _levels(W, H)
    scorers: dict[int, _Scorer] = {}

    def scorer(factor: int) -> _Scorer:
        if factor not in scorers:
            scorers[factor] = _Scorer(empty, moving, factor, color_tol)
        return scorers[factor]

    def objective(factor: int, d, s) -> float:
        return scorer(factor).measure(obj_center, d, s)[0] - penalty(d, s)

    def pattern_search(state, factor: int, step: float, s_step: float, min_step: float):
        """걸음마다 이웃 26곳을 보고 가장 좋은 곳으로 간다. 더 좋은 곳이 없으면 걸음 간격을 반으로 (min_step 까지)."""
        best = state
        while True:
            for _ in range(MAX_ITERATIONS):
                d0, s0 = best
                best_next, best_next_value = None, objective(factor, d0, s0)
                for a in (-1, 0, 1):
                    for b in (-1, 0, 1):
                        for c in (-1, 0, 1):
                            if a == b == c == 0:
                                continue
                            d, s = clamp((d0[0] + a * step, d0[1] + b * step), s0 + c * s_step)
                            v = objective(factor, d, s)
                            if v > best_next_value + 1e-12:
                                best_next, best_next_value = (d, s), v
                if best_next is None:
                    break
                best = best_next
            if step <= min_step:
                return best
            step, s_step = max(step / 2, min_step), max(s_step / 2, MIN_SCALE_STEP)

    # 1) 가장 거친 단계에서 모든 후보를 보고, 서로 떨어진 좋은 후보 몇 개를 남긴다
    #    (점수 지형이 울퉁불퉁해서 하나만 골라 다듬으면 엉뚱한 봉우리에 갇힐 수 있다)
    f0 = levels[0]
    rx, ry = int(limit[0] // f0), int(limit[1] // f0)
    # 배율 격자: 1 을 지나는 같은 간격 (범위가 넓으면 간격도 넓혀 후보 수를 눌러 둔다)
    scale_step = max(SCALE_STEP, (smax - smin) / 10)
    scales = [1 + k * scale_step for k in range(-int((1 - smin) / scale_step + 1e-9), int((smax - 1) / scale_step + 1e-9) + 1)]
    for edge in (smin, smax):
        if all(abs(edge - v) > 1e-9 for v in scales) and abs(edge - 1) > 1e-9:
            scales.append(edge)
    candidates: list[tuple[float, tuple, float]] = []
    for s in scales:
        for iy in range(-ry, ry + 1):
            for ix in range(-rx, rx + 1):
                d = (float(ix * f0), float(iy * f0))
                candidates.append((objective(f0, d, s), d, s))
    candidates.sort(key=lambda c: -c[0])
    beam: list[tuple[tuple[float, float], float]] = []
    for _, d, s in candidates:
        if all(abs(d[0] - bd[0]) > 2 * f0 or abs(d[1] - bd[1]) > 2 * f0 or abs(s - bs) > 2 * scale_step for (bd, bs) in beam):
            beam.append((d, s))
        if len(beam) >= BEAM_WIDTH:
            break

    # 2) 고운 단계로 내려가며 다듬는다. 단계마다 남은 후보 중 좋은 쪽만 데리고 간다.
    step, s_step = float(f0), scale_step
    refine = levels[1:] or levels
    for n, factor in enumerate(refine):
        last = n == len(refine) - 1
        min_step = 1.0 if last else float(factor)  # 거친 단계는 그 단계의 한 픽셀까지만
        beam = [pattern_search(state, factor, step, s_step, min_step) for state in beam]
        beam = sorted(set(beam), key=lambda st: -objective(factor, *st))[: (1 if last else BEAM_KEEP)]
        step, s_step = max(min_step, 1.0), max(s_step / 2, MIN_SCALE_STEP)
    best = beam[0]

    # 한 걸음씩 가는 다듬기는 이동과 배율이 서로 보태 주는 능선(이동 +1 · 배율 +2% 가 거의 같은 맞춤) 에서 멈출 수 있다 —
    # 마지막 단계에서 가까운 곳 전부를 한 번 훑어 본다
    last = levels[-1]
    d0, s0 = best
    polished = best
    polished_value = objective(last, d0, s0)
    for iy in range(-POLISH_SHIFT, POLISH_SHIFT + 1):
        for ix in range(-POLISH_SHIFT, POLISH_SHIFT + 1):
            for k in range(-POLISH_SCALE_STEPS, POLISH_SCALE_STEPS + 1):
                d, s = clamp((d0[0] + ix, d0[1] + iy), s0 + k * MIN_SCALE_STEP)
                v = objective(last, d, s)
                if v > polished_value + 1e-12:
                    polished, polished_value = (d, s), v
    best = polished

    # 3) 가장 고운 단계의 값으로 점수를 매긴다
    final = scorer(levels[-1])
    (d_obj, s) = best
    score, coverage = final.measure(obj_center, d_obj, s)
    identity_score, _ = final.measure(obj_center, (0.0, 0.0), 1.0)
    # 물건 가운데 기준 이동 → 판 가운데 기준 (nudge 와 같은 기준)
    cc = (W / 2, H / 2)
    d_center = (d_obj[0] + (1 - s) * (obj_center[0] - cc[0]), d_obj[1] + (1 - s) * (obj_center[1] - cc[1]))
    at_limit = (
        abs(d_obj[0]) >= limit[0] - 1 or abs(d_obj[1]) >= limit[1] - 1
        or s >= smax - MIN_SCALE_STEP or s <= smin + MIN_SCALE_STEP
    )
    if score < identity_score + IDENTITY_MARGIN:
        # 이동 없이도 같은 정도로 맞는다 — 잔 떨림으로 그림을 다시 뽑지 않는다
        return AlignResult(Placement(), (0.0, 0.0), identity_score, identity_score, final.measure(obj_center, (0.0, 0.0), 1.0)[1], False)
    placement = Placement(round(d_center[0], 2), round(d_center[1], 2), round(s, 4))
    return AlignResult(placement, (round(d_obj[0], 2), round(d_obj[1], 2)), score, identity_score, coverage, at_limit)


# ---- 겹쳐 보기 ----------------------------------------------------------------------------------


def _over_background(img, background=BACKGROUND):
    base = Image.new("RGB", img.size, background)
    base.paste(img.convert("RGB"), mask=img.getchannel("A"))
    return base


def outline_of(mask, width: int = 1):
    """불투명 마스크(L, 0/255) 의 가장자리 띠 (안쪽으로 width 픽셀)."""
    inner = mask.filter(ImageFilter.MinFilter(2 * width + 1))
    return ImageChops.subtract(mask, inner)


def _object_mask(empty):
    return empty.getchannel("A").point([255 if v >= MASK_THRESHOLD else 0 for v in range(256)])


def stack_overlay(empty, plates: Sequence, outline_width: int = 2):
    """빈 물건과 합친 그림들을 같은 무게로 겹쳐 평균 낸 그림 + 빈 물건 윤곽선. 물건이 겹쳤으면 선명하고, 어긋나면 번진다."""
    if not plates:
        raise AlignError("겹칠 그림이 없다")
    acc = _over_background(empty)
    for k, plate in enumerate(plates, start=2):
        acc = Image.blend(acc, _over_background(plate), 1 / k)
    acc.paste(OUTLINE_COLOR, mask=outline_of(_object_mask(empty), outline_width))
    return acc


def grid_overlay(empty, entries: Sequence[tuple[str, object]], tile: tuple[int, int] = (384, 384), cols: int = 4):
    """합친 그림마다 한 칸 — 빈 물건 윤곽선을 그 위에 그리고 칸 위에 이름을 적는다."""
    if not entries:
        raise AlignError("그릴 그림이 없다")
    W, H = empty.size
    scale = min(1.0, tile[0] / W, tile[1] / H)  # 키우지는 않는다
    tw, th = max(1, round(W * scale)), max(1, round(H * scale))
    label_h = 14
    cols = max(1, min(cols, len(entries)))
    rows = math.ceil(len(entries) / cols)
    sheet = Image.new("RGB", (cols * tw, rows * (th + label_h)), (255, 255, 255))
    small_mask = _object_mask(empty).resize((tw, th), Image.LANCZOS).point([255 if v >= MASK_THRESHOLD else 0 for v in range(256)])
    edge = outline_of(small_mask, 1)
    draw = ImageDraw.Draw(sheet)
    for i, (label, plate) in enumerate(entries):
        x, y = (i % cols) * tw, (i // cols) * (th + label_h)
        thumb = _over_background(plate.resize((tw, th), Image.LANCZOS))
        thumb.paste(OUTLINE_COLOR, mask=edge)
        sheet.paste(thumb, (x, y + label_h))
        draw.text((x + 3, y + 1), label, fill=(30, 30, 30))
    return sheet
