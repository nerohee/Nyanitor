#!/usr/bin/env python
"""만든 그림 원본(art/ 아래)을 앱에 넣을 크기 · 기준점으로 맞춰 src/assets/ 에 저장한다.

표에서 `final` 이 있는 항목만 다룬다. 순서: 투명 여백 잘라내기 → canvas 안에 비율 유지해 넣기 →
anchor 에 맞춰 놓기 (feet: 아래 가운데, 아래 여백 일정 · center: 가운데 · none: 크기만) → 저장.
`final` 확장자가 형식을 정한다 (.png · .webp — WebP 는 알파 유지, --webp-quality).

anchor none 항목(빈 물건 · 합친 그림 · 배경)은 위 순서 대신 판 크기로만 맞추되, 합친 그림은 표의 `align_to` · `nudge` ·
`move_like` 로 같은 물건의 빈 그림에 겹쳐 맞추고 (align.py), `crop_group` 이면 같은 묶음의 내용 합집합 상자로 자른다.
`--overlay` 는 맞춤 전 · 후를 겹쳐 보는 그림만 만든다 (src/assets 는 건드리지 않는다).
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import artlib
from artlib import Item, Table, TableError

try:
    from PIL import Image, UnidentifiedImageError

    import align
except ImportError:  # 요구 사항: pip install -r scripts/cat-art/requirements.txt
    Image = None
    align = None
    UnidentifiedImageError = Exception

DEFAULT_MARGIN = 0.04  # 좌우 · 위 여백 (캔버스 대비)
DEFAULT_BOTTOM_MARGIN = 0.06  # 아래 여백 — feet 기준에서 모든 그림이 같다
DEFAULT_ALPHA_THRESHOLD = 8  # 이 값 이하의 거의 투명한 점은 여백으로 본다
SPREAD_WARN_RATIO = 1.5  # 같은 고양이 자세들의 배율 차이가 이 비율을 넘으면 알린다
FRAME_GROUP = "cats"  # 가족(--same-scale) · 프레임(--match-frames) 판단은 이 group 과 '-cats' 로 끝나는 group(v2-cats)의 항목끼리만 — 물건 · 배경은 개별로
DEFAULT_WEBP_QUALITY = 90  # 실제 그림에서 80~95 를 재 본 결과: 90 부터는 오차가 거의 안 줄고 용량만 는다
FRAME_HEIGHT_WARN = 0.15  # 프레임 짝의 원본 내용 높이가 첫 프레임과 이 비율 넘게 다르면 알린다
DEFAULT_ALIGN_MIN_SCORE = 0.45  # 물건 맞춤 점수(빈 물건 불투명 점 중 같은 색으로 겹친 비율)가 이보다 낮으면 옮기지 않고 알린다
AT_LIMIT_MIN_SCORE = 0.60  # 이동 · 배율 한도에 닿은 결과는 더 엄격하게 — 한도 밖의 진짜 위치를 못 찾고 가장자리에 걸린 가짜 일치일 수 있다
CLIP_WARN = 0.002  # 맞추려고 옮기다 판 밖으로 잘려 나간 불투명 몫이 이보다 크면 알린다
CROP_PAD = 4  # 같은 묶음 내용 합집합 상자에 사방으로 더하는 여백 (판 px)
DEFAULT_OVERLAY_DIR = "art/raw/v2/overlay"
DEFAULT_CROP_INFO = "src/assets/crop-boxes.json"

EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_NOT_READY = 0, 1, 2, 3


class FitError(Exception):
    pass


@dataclass
class Options:
    margin: float = DEFAULT_MARGIN
    bottom_margin: float = DEFAULT_BOTTOM_MARGIN
    alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD


def content_bbox(img, threshold: int) -> tuple[int, int, int, int] | None:
    """알파가 threshold 보다 큰 부분의 상자. 전부 투명하면 None."""
    alpha = img.getchannel("A").point(lambda a: 255 if a > threshold else 0)
    return alpha.getbbox()


def fit_scale(crop_size: tuple[int, int], canvas: tuple[int, int], anchor: str, opt: Options) -> float:
    cw, ch = crop_size
    W, H = canvas
    side = round(W * opt.margin)
    top = round(H * opt.margin)
    bottom = round(H * (opt.bottom_margin if anchor == "feet" else opt.margin))
    avail_w, avail_h = W - 2 * side, H - top - bottom
    if avail_w < 1 or avail_h < 1:
        raise FitError("여백이 canvas 보다 크다")
    return min(avail_w / cw, avail_h / ch)


def place(crop, canvas: tuple[int, int], anchor: str, scale: float, opt: Options):
    """잘라낸 그림을 scale 배로 줄이거나 늘려 canvas 위 anchor 자리에 놓은 새 RGBA 그림."""
    W, H = canvas
    w = max(1, round(crop.width * scale))
    h = max(1, round(crop.height * scale))
    if w > W or h > H:
        raise FitError(f"배율 {scale:.3f} 로 하면 {w}x{h} 가 되어 canvas {W}x{H} 를 넘는다")
    resized = crop.resize((w, h), Image.LANCZOS)
    x = (W - w) // 2
    if anchor == "feet":
        y = H - round(H * opt.bottom_margin) - h
    else:
        y = (H - h) // 2
    if y < 0:
        raise FitError(f"배율 {scale:.3f} 로 하면 위로 넘친다 (y={y})")
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(resized, (x, y))
    return out


def fit_cover(img, canvas: tuple[int, int]):
    """anchor none: 자르지 않고 canvas 크기로만 맞춘다. 비율이 다르면 가운데를 기준으로 넘치는 쪽을 자른다."""
    W, H = canvas
    s = max(W / img.width, H / img.height)
    w, h = max(W, round(img.width * s)), max(H, round(img.height * s))
    resized = img.resize((w, h), Image.LANCZOS)
    left, top = (w - W) // 2, (h - H) // 2
    return resized.crop((left, top, left + W, top + H))


def encode_image(image, suffix: str, webp_quality: int) -> bytes:
    """확장자로 형식을 정한다. WebP 는 알파를 그대로 유지(손실 압축, 알파는 무손실)."""
    buf = io.BytesIO()
    if suffix.lower() == ".webp":
        image.save(buf, "WEBP", quality=webp_quality, method=4, alpha_quality=100)  # method=6 은 장당 5초, 용량 차이 1~2%
    else:
        image.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def load_source(path: Path):
    try:
        img = Image.open(path)
        img.load()
    except (OSError, UnidentifiedImageError) as e:
        raise FitError(f"원본 그림을 못 읽는다: {type(e).__name__}")
    return img.convert("RGBA")


@dataclass
class Measured:
    item: Item
    crop: object | None  # 잘라낸 RGBA 그림 (anchor none 이면 원본 전체)
    scale: float  # 이 항목 혼자 canvas 에 맞출 때의 배율
    notes: list[str]


def measure(item: Item, opt: Options) -> Measured:
    if not artlib.file_ready(item.out):
        raise FitError("원본이 아직 없다 — 먼저 generate.py")
    img = load_source(item.out)
    notes: list[str] = []
    if item.anchor == "none":
        return Measured(item, img, 1.0, notes)
    box = content_bbox(img, opt.alpha_threshold)
    if box is None:
        raise FitError("그림이 전부 투명하다")
    if box == (0, 0, img.width, img.height) and img.getchannel("A").getextrema()[0] == 255:
        notes.append("투명한 부분이 없다 — 배경이 안 빠졌을 수 있다")
    crop = img.crop(box)
    return Measured(item, crop, fit_scale(crop.size, item.canvas, item.anchor, opt), notes)


def is_frame_group(group: str, extra: frozenset[str] | set[str] = frozenset()) -> bool:
    """가족 · 프레임 판단 대상 group 인가: 'cats'(1판), '-cats' 로 끝나는 group(2판 v2-cats), 또는 --frame-group 으로 준 이름."""
    return group == FRAME_GROUP or group.endswith("-" + FRAME_GROUP) or group in extra


def family_key(item: Item, table: Table, extra: frozenset[str] | set[str] = frozenset()) -> str | None:
    """같은 고양이의 자세들 = 같은 설정 그림에서 나온 항목들. refs 를 거슬러 올라가
    `final` 이 없는 생산자(설정 그림) 의 id 로 묶는다. 다음 프레임이 첫 프레임을 참조해도
    (프레임 → 첫 프레임 → 설정 그림) 같은 묶음이다. 참조는 항상 앞 항목이라 끝이 있다."""
    if not is_frame_group(item.group, extra):
        return None
    producers = table.producers()
    for name in item.refs:
        producer = producers.get(name)
        if producer is None:
            continue
        if producer.final is None:
            return producer.id
        return family_key(producer, table, extra) or producer.id
    return None


def first_frame_of(item: Item, table: Table, extra: frozenset[str] | set[str] = frozenset()) -> Item | None:
    """다음 프레임 항목이면 그 첫 프레임. 다음 프레임 = `then_ref_as` 가 없고, refs[0] 이 `final` 이 있는
    항목(첫 프레임)의 결과인 `final` 항목 (예: walk-2 → walk-1, sit-blink → sit)."""
    if not is_frame_group(item.group, extra) or item.final is None or item.then_ref_as or not item.refs:
        return None
    if item.anchor in (None, "none"):
        return None
    producer = table.producers().get(item.refs[0])
    if (
        producer is not None and is_frame_group(producer.group, extra) and producer.final is not None
        and producer.anchor not in (None, "none")
    ):
        return producer
    return None


def check_fit_fields(item: Item, table: Table | None = None) -> str | None:
    if item.final is None:
        return None
    if item.anchor is None:
        return "anchor 가 없다 (feet / center / none)"
    if item.canvas is None:
        return "canvas 가 없다 (예 '512x512')"
    if item.size_like and item.anchor == "none":
        return "anchor 가 none 이면 size_like 를 쓸 수 없다 (크기만 맞추는 항목)"
    if item.size_like and table is not None:
        ref = table.by_id()[item.size_like]
        if ref.anchor in (None, "none") or ref.canvas is None:
            return f"size_like '{ref.id}' 는 anchor(feet/center) · canvas 가 있는 항목이어야 한다"
    return check_plate_fields(item, table)


def plate_canvas(item: Item) -> tuple[int, int] | None:
    """판 크기: 맞춘 크기(canvas), 없으면 생성 크기(size)."""
    return item.canvas or artlib.parse_dims(item.size)


def check_plate_fields(item: Item, table: Table | None) -> str | None:
    """align_to · nudge · move_like · crop_group 은 판 크기로만 맞추는 항목(anchor none)에서만 쓴다."""
    keys = [k for k in ("align_to", "nudge", "move_like", "crop_group", "align_scale", "align_range") if getattr(item, k) is not None]
    if not keys:
        return None
    if item.anchor != "none":
        return f"{' · '.join(keys)} 는 anchor 가 none 인 항목(합친 그림 · 판 크기 그림)에서만 쓴다"
    if table is None:
        return None
    by_id = table.by_id()
    for key in ("align_to", "move_like"):
        target = by_id.get(getattr(item, key) or "")
        if target is None:
            continue
        if target.anchor not in (None, "none"):
            return f"{key} '{target.id}' 는 판 크기 그림(anchor none)이어야 한다 (지금 {target.anchor})"
        if key == "move_like" and target.anchor != "none":
            return f"move_like '{target.id}' 항목은 anchor 가 none 이어야 한다"
        if plate_canvas(target) != item.canvas:
            return f"{key} '{target.id}' 와 판 크기가 다르다 ({plate_canvas(target)} / {item.canvas}) — 같은 판이어야 겹칠 수 있다"
    return None


def main(
    argv: list[str] | None = None,
    *,
    root: Path | None = None,
    stdout=None,
    stderr=None,
) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    root = Path(root) if root else artlib.REPO_ROOT

    def say(msg: str = "") -> None:
        print(msg, file=out, flush=True)

    def warn(msg: str) -> None:
        print(msg, file=err, flush=True)

    args = build_parser().parse_args(argv)
    for name in ("margin", "bottom_margin"):
        v = getattr(args, name)
        if not 0 <= v < 0.5:
            warn(f"--{name.replace('_', '-')} 는 0 이상 0.5 미만이어야 한다")
            return EXIT_USAGE
    if not 0 <= args.webp_quality <= 100:
        warn("--webp-quality 는 0~100 이어야 한다")
        return EXIT_USAGE
    if not 0 <= args.alpha_threshold <= 254:
        warn("--alpha-threshold 는 0~254 여야 한다")
        return EXIT_USAGE
    if not 0 <= args.align_min_score <= 1:
        warn("--align-min-score 는 0~1 이어야 한다")
        return EXIT_USAGE
    if not 0 < args.align_range <= 0.25:
        warn("--align-range 는 0 보다 크고 0.25 이하여야 한다 (판 크기 대비 비율)")
        return EXIT_USAGE
    opt = Options(args.margin, args.bottom_margin, args.alpha_threshold)

    table_path = args.table or (root / "scripts" / "cat-art" / "prompts.json")
    try:
        table = artlib.load_table(table_path, root)
        selected = artlib.select_items(table, args.group, args.only, args.select_all)
    except TableError as e:
        for line in e.errors:
            warn(f"오류: {line}")
        return EXIT_USAGE
    for w in table.warnings:
        warn(f"경고: {w}")

    known_groups = {i.group for i in table.items}
    unknown = [g for g in args.frame_group if g not in known_groups]
    if unknown:
        warn(f"오류: --frame-group '{', '.join(unknown)}' 는 표에 없는 그룹이다 (있는 그룹: {', '.join(sorted(known_groups))})")
        return EXIT_USAGE
    frame_groups = frozenset(args.frame_group)

    explicit = set(args.only)
    bad = [i.id for i in selected if i.id in explicit and i.final is None]
    if bad:
        warn("오류: final 이 없는 항목이다 (맞출 대상이 아님): " + ", ".join(bad))
        return EXIT_USAGE
    targets = [i for i in selected if i.final is not None]
    field_errors = [f"{i.id}: {m}" for i in targets if (m := check_fit_fields(i, table))]
    if field_errors:
        for line in field_errors:
            warn(f"오류: {line}")
        return EXIT_USAGE
    if not targets:
        say("맞출 항목이 없다 (선택한 항목 중 final 이 있는 것이 없다).")
        return EXIT_OK

    # 같은 crop_group 은 같은 상자로 잘라야 하니 묶음 전체를 같이 맞춰야 한다 (일부만 다시 맞추면 앱이 쓰는 상자와 어긋난다)
    use_crop = not args.no_crop and not args.overlay
    crop_members: dict[str, list[Item]] = {}
    for i in table.items:
        if i.crop_group and i.final is not None:
            crop_members.setdefault(i.crop_group, []).append(i)
    if use_crop:
        picked = {i.id for i in targets}
        partial = []
        for group_name in sorted({i.crop_group for i in targets if i.crop_group}):
            missing = [m.id for m in crop_members[group_name] if m.id not in picked]
            if missing:
                partial.append(f"crop_group '{group_name}': {', '.join(missing)} 도 같이 골라야 한다 (같은 상자로 잘라야 하므로)")
        if partial:
            for line in partial:
                warn(f"오류: {line}")
            warn("      (잘라내지 않고 판 그대로 맞추려면 --no-crop)")
            return EXIT_USAGE

    if Image is None:
        warn("오류: Pillow 가 없다. 가상 환경에서: pip install -r scripts/cat-art/requirements.txt")
        return EXIT_NOT_READY

    # 같은 고양이 자세들의 배율: 선택과 상관없이 가족 전체에서 구해야 일부만 다시 맞춰도 결과가 같다.
    family_scale: dict[str, float] = {}
    resolving: set[str] = set()
    notes: dict[str, list[str]] = {}
    measured: dict[str, Measured] = {}
    failures: dict[str, str] = {}

    def get_measured(item: Item) -> Measured | None:
        if item.id in failures:
            return None
        if item.id not in measured:
            try:
                measured[item.id] = measure(item, opt)
            except FitError as e:
                failures[item.id] = str(e)
                return None
        return measured[item.id]

    by_id = table.by_id()
    families: dict[str, list[Item]] = {}
    if args.same_scale:
        for item in table.items:
            if item.final is None or item.anchor in (None, "none"):
                continue
            key = family_key(item, table, frame_groups)
            if key:
                families.setdefault(key, []).append(item)
    family_done: set[str] = set()

    def ensure_family(key: str | None) -> None:
        """가족 배율 (가장 큰 자세가 canvas 에 맞는 값). 선택과 상관없이 가족 전체로, 필요할 때 한 번만 구한다."""
        if key is None or not args.same_scale or key in family_done:
            return
        family_done.add(key)
        members = families[key]
        canvases = {m.canvas for m in members}
        if len(canvases) > 1:
            for m in members:
                failures[m.id] = f"같은 고양이('{key}') 자세들의 canvas 가 서로 다르다 — --same-scale 을 쓸 수 없다"
            return
        scales = []
        for m in members:
            if m.size_like:
                continue  # 크기 기준 항목은 다른 항목에 맞추니 가족 배율에 끼지 않는다
            if args.match_frames and first_frame_of(m, table, frame_groups) is not None:
                continue  # 다음 프레임은 첫 프레임에 맞추니 가족 배율에 끼지 않는다
            got = get_measured(m)
            if got is not None:
                scales.append(got.scale)
        if not scales:
            return
        family_scale[key] = min(scales)
        if max(scales) / min(scales) > SPREAD_WARN_RATIO:
            notes.setdefault(key, []).append(
                f"'{key}' 자세들의 원본 크기 차이가 크다 (배율 {min(scales):.2f}~{max(scales):.2f}) — 가장 큰 그림에 맞춰 나머지를 줄인다"
            )

    for key in sorted({family_key(i, table, frame_groups) for i in targets if i.anchor != "none"} - {None}):
        ensure_family(key)

    scale_cache: dict[str, tuple[float, list[str]]] = {}

    def match_height(item: Item, m: Measured, ref: Item, why: str) -> tuple[float, list[str]]:
        """item 의 맞춘 내용 높이가 ref 의 맞춘 내용 높이와 같아지는 배율 (가로가 canvas 를 넘으면 한도까지만)."""
        rm = get_measured(ref)
        if rm is None:
            raise FitError(f"{why} '{ref.id}' 를 맞출 수 없어 크기를 정할 수 없다 ({failures[ref.id]})")
        if ref.canvas != item.canvas:
            raise FitError(f"{why} '{ref.id}' 와 canvas 가 달라 높이를 맞출 수 없다")
        ref_scale, _ = scale_of(ref)
        scale = rm.crop.height * ref_scale / m.crop.height  # ref 의 맞춘 내용 높이 / 이 그림의 원본 내용 높이
        out_notes: list[str] = []
        if scale > m.scale * 1.0001:
            out_notes.append(f"주의: {why} 높이에 맞추면 canvas 를 넘어 {m.scale:.3f} 로 줄였다 (높이가 {why}보다 작아진다)")
            scale = m.scale
        out_notes.append(f"{why} '{ref.id}' 와 높이 맞춤")
        return scale, out_notes

    def scale_of(item: Item) -> tuple[float, list[str]]:
        """이 항목의 최종 배율과 안내 문구. 우선순위: size_like > 다음 프레임(match-frames) > 가족 배율(same-scale) > 혼자."""
        if item.id in scale_cache:
            return scale_cache[item.id]
        if item.id in resolving:
            raise FitError(f"size_like 가 돌고 돈다: {item.id}")
        resolving.add(item.id)
        try:
            key = family_key(item, table, frame_groups) if args.same_scale else None
            ensure_family(key)
            m = get_measured(item)
            if m is None:
                raise FitError(failures[item.id])
            result: tuple[float, list[str]]
            first = first_frame_of(item, table, frame_groups) if args.match_frames else None
            if item.size_like:
                result = match_height(item, m, by_id[item.size_like], "크기 기준")
            elif first is not None:
                scale, out_notes = match_height(item, m, first, "첫 프레임")
                diff = abs(m.crop.height / get_measured(first).crop.height - 1)
                if diff > FRAME_HEIGHT_WARN:
                    out_notes.insert(
                        0, f"주의: 첫 프레임 '{first.id}' 와 원본 내용 높이가 {diff * 100:.0f}% 다르다 — 자세가 실제로 다른지 직접 볼 것"
                    )
                result = (scale, out_notes)
            else:
                result = (family_scale.get(key, m.scale) if key else m.scale, [])
        finally:
            resolving.discard(item.id)
        scale_cache[item.id] = result
        return result

    # ---- 판 크기 그림(anchor none): 물건 기준 맞춤 · 겹쳐 보기 · 공통 잘라내기 ----
    plate_cache: dict[str, object] = {}  # 빈 물건 항목 id → 판 크기로 맞춘 RGBA (물건당 한 번만 읽는다)
    move_cache: dict[str, Moved | FitError] = {}
    crop_cache: dict[str, tuple | FitError] = {}

    def empty_plate(ref: Item, canvas: tuple[int, int]):
        """맞출 기준 그림 (판 크기). 빈 물건이 보통이고, 기준 항목이 스스로 옮겨지는 합친 그림이면 옮긴 뒤 모습이 기준이다."""
        key = f"{ref.id}:{canvas[0]}x{canvas[1]}"
        if key not in plate_cache:
            if not artlib.file_ready(ref.out):
                raise FitError(f"기준 '{ref.id}' 의 원본이 아직 없다 ({table.rel(ref.out)}) — 먼저 generate.py (또는 --no-align)")
            plate = fit_cover(load_source(ref.out), canvas)
            moved = placement_of(ref)
            if moved is not None and moved.applied and not moved.placement.is_identity:
                plate = align.apply_placement(plate, moved.placement)
            plate_cache[key] = plate
        return plate_cache[key]

    def measure_plate(item: Item):
        """판 크기 그림의 원본 (자르지 않은 전체). 캐시하지 않는다 — 큰 그림이 쌓이지 않게."""
        return measure(item, opt).crop

    def describe(pl) -> str:
        return f"이동 ({pl.dx:+.1f}, {pl.dy:+.1f}) 배율 {pl.scale:.3f}"

    def placement_of(item: Item) -> Moved | None:
        """합친 그림을 옮길 값. 대상이 아니거나 --no-align 이면 None. 못 구하면 FitError (결과를 기억해 둔다)."""
        if args.no_align or not (item.align_to or item.nudge or item.move_like):
            return None
        if item.id not in move_cache:
            try:
                move_cache[item.id] = resolve_placement(item)
            except FitError as e:
                move_cache[item.id] = e
        got = move_cache[item.id]
        if isinstance(got, FitError):
            raise got
        return got

    def resolve_placement(item: Item) -> Moved:
        if item.nudge is not None:
            pl = align.Placement(*item.nudge)
            return Moved(pl, True, f"nudge 로 정한 {describe(pl)}")
        if item.move_like is not None:
            target = by_id[item.move_like]
            try:
                base = placement_of(target)
            except FitError as e:
                raise FitError(f"같은 이동을 쓸 '{target.id}' 의 이동을 못 구했다 ({e})")
            if base is None:
                raise FitError(f"같은 이동을 쓸 '{target.id}' 의 이동을 알 수 없다")
            if not base.applied:
                return Moved(align.Placement(), False, f"'{target.id}' 가 옮기지 않아 같이 옮기지 않았다", list(base.notes))
            return Moved(base.placement, True, f"'{target.id}' 와 같은 {describe(base.placement)}", list(base.notes))
        ref = by_id[item.align_to]
        try:
            ref_moved = placement_of(ref)  # 기준이 다른 합친 그림이면 그 그림이 먼저 맞춰져 있어야 한다
        except FitError as e:
            raise FitError(f"맞출 기준 '{ref.id}' 의 이동을 못 구했다 ({e})")
        if ref_moved is not None and not ref_moved.applied:
            return Moved(align.Placement(), False, f"기준 '{ref.id}' 가 옮기지 않아 같이 맞추지 않았다", list(ref_moved.notes))
        empty = empty_plate(ref, item.canvas)
        moving = fit_cover(measure_plate(item), item.canvas)
        reach = item.align_range if item.align_range is not None else args.align_range
        scales = item.align_scale or (align.SCALE_MIN, align.SCALE_MAX)
        try:
            found = align.find_alignment(empty, moving, max_shift=reach, scale_range=scales)
        except align.AlignError as e:
            raise FitError(f"물건 맞춤을 못 했다: {e}")
        text = (
            f"'{ref.id}' 에 맞춤 {describe(found.placement)}, 점수 {found.score:.2f} (이동 없이 {found.identity_score:.2f}), "
            f"물건 가운데 이동 ({found.object_shift[0]:+.1f}, {found.object_shift[1]:+.1f})"
        )
        needed = max(args.align_min_score, AT_LIMIT_MIN_SCORE) if found.at_limit else args.align_min_score
        if found.score < needed:
            why = "한도에 닿았는데 " if found.at_limit else ""
            low = (
                f"주의: {why}점수 {found.score:.2f} 가 기준 {needed:.2f} 보다 낮아 옮기지 않았다 — 물건이 이동 한도(±{reach * 100:.0f}%)보다 "
                "크게 밀렸거나 고양이가 물건을 많이 가렸을 수 있다. --overlay 로 보고, 한도를 넓히거나(--align-range 0.15) nudge 로 손보거나 그 그림을 다시 뽑는다"
            )
            return Moved(align.Placement(), False, text, [low])
        extra = []
        if found.at_limit:
            extra.append("주의: 이동 · 배율 한도에 닿았다 — 실제 어긋남이 더 클 수 있다 (--overlay 로 확인)")
        return Moved(found.placement, True, text, extra)

    def render_plate(item: Item, source) -> tuple[object, str]:
        """판 크기로 맞추고 (비율이 다르면 넘치는 쪽을 자름), 물건 맞춤 이동을 적용한 그림과 안내 문구."""
        aspect_diff = abs(source.width / source.height - item.canvas[0] / item.canvas[1])
        detail = f"크기만 {source.width}x{source.height} -> {item.canvas[0]}x{item.canvas[1]}"
        if aspect_diff > 0.01:
            detail += "  [주의: 비율이 달라 넘치는 쪽을 잘랐다]"
        image = fit_cover(source, item.canvas)
        moved = placement_of(item)
        if moved is not None:
            detail += f" [{moved.text}]"
            for note in moved.notes:
                detail += f" [{note}]"
            if moved.applied and not moved.placement.is_identity:
                shifted = align.apply_placement(image, moved.placement)
                lost = align.clipped_fraction(image, shifted, moved.placement.scale)
                if lost > CLIP_WARN:
                    detail += f" [주의: 옮기다 판 밖으로 불투명한 점의 {lost * 100:.1f}% 가 잘렸다]"
                image = shifted
        return image, detail

    def compute_crop(group_name: str):
        members = crop_members[group_name]
        if len({m.canvas for m in members}) > 1:
            raise FitError(f"crop_group '{group_name}' 항목들의 canvas 가 서로 다르다")
        union = None
        for member in members:
            try:
                image, _ = render_plate(member, measure_plate(member))
            except FitError as e:
                raise FitError(f"crop_group '{group_name}' 의 '{member.id}' 를 맞출 수 없어 상자를 정할 수 없다 ({e}) — 판 그대로 맞추려면 --no-crop")
            box = content_bbox(image, opt.alpha_threshold)
            if box is None:
                continue
            union = box if union is None else (min(union[0], box[0]), min(union[1], box[1]), max(union[2], box[2]), max(union[3], box[3]))
        if union is None:
            raise FitError(f"crop_group '{group_name}' 의 그림이 모두 투명하다")
        W, H = members[0].canvas
        box = (max(0, union[0] - CROP_PAD), max(0, union[1] - CROP_PAD), min(W, union[2] + CROP_PAD), min(H, union[3] + CROP_PAD))
        return box, (W, H)

    def crop_of(group_name: str):
        """crop_group 의 상자 (왼쪽 위 x, y, 오른쪽 아래 x, y) 와 판 크기. 묶음 전체의 (맞춘) 그림 내용 합집합 + 여백."""
        if group_name not in crop_cache:
            try:
                crop_cache[group_name] = compute_crop(group_name)
            except FitError as e:
                crop_cache[group_name] = e
        got = crop_cache[group_name]
        if isinstance(got, FitError):
            raise got
        return got

    if args.overlay:
        return run_overlay(args, table, targets, by_id, root, empty_plate, placement_of, measure_plate, say, warn)

    results: list[tuple[str, str]] = []
    saved_ids: set[str] = set()
    used_crops: set[str] = set()
    n_ok = 0
    for item in targets:
        label = f"{item.id}  {table.rel(item.out)} -> {table.rel(item.final)}  ({item.anchor}, {item.canvas[0]}x{item.canvas[1]})"
        m = get_measured(item)
        if m is None:
            results.append((label, "실패: " + failures[item.id]))
            continue
        try:
            if item.anchor == "none":
                image, detail = render_plate(item, m.crop)
                if item.crop_group and use_crop:
                    box, (W, H) = crop_of(item.crop_group)
                    image = image.crop(box)
                    used_crops.add(item.crop_group)
                    share = (box[2] - box[0]) * (box[3] - box[1]) * 100 / (W * H)
                    detail += f" [묶음 상자 왼쪽 위 ({box[0]}, {box[1]}) {box[2] - box[0]}x{box[3] - box[1]} 로 잘랐다 — 판의 {share:.0f}%]"
                measured.pop(item.id, None)  # 큰 판 그림이 쌓이지 않게 (크기 계산에 쓰이지 않는다)
            else:
                scale, scale_notes = scale_of(item)
                image = place(m.crop, item.canvas, item.anchor, scale, opt)
                detail = f"잘라낸 {m.crop.width}x{m.crop.height} x{scale:.3f} (내용 높이 {round(m.crop.height * scale)}px)"
                if scale > 1.0:
                    detail += " [주의: 원본보다 키웠다]"
                for note in scale_notes:
                    detail += f" [{note}]"
            for note in m.notes:
                detail += f" [주의: {note}]"
            if args.dry_run:
                results.append((label, "미리보기 " + detail))
                n_ok += 1
                continue
            artlib.atomic_write_bytes(item.final, encode_image(image, item.final.suffix, args.webp_quality))
            results.append((label, "저장 " + detail))
            saved_ids.add(item.id)
            n_ok += 1
        except (FitError, OSError) as e:
            results.append((label, f"실패: {e if isinstance(e, FitError) else type(e).__name__}"))

    for label, status in results:
        say(f"  {label}\n      {status}")
    for key in sorted(notes):
        for msg in notes[key]:
            warn(f"주의: {msg}")
    failed = sum(1 for _, s in results if s.startswith("실패"))
    if used_crops and not args.dry_run:
        try:
            write_crop_info(root, args.crop_info, used_crops, crop_members, saved_ids, crop_cache, say, warn)
        except OSError as e:
            warn(f"오류: 상자 정보 파일을 못 썼다: {type(e).__name__}")
            failed += 1
    verb = "미리보기" if args.dry_run else "저장"
    say(f"요약: {verb} {n_ok}장, 실패 {failed}장" + ("  (--dry-run: 파일을 쓰지 않았다)" if args.dry_run else ""))
    return EXIT_FAILED if failed else EXIT_OK


@dataclass
class Moved:
    """합친 그림에 쓸 이동. applied 가 False 면 옮기지 않는다 (점수가 낮은 경우 등)."""

    placement: object
    applied: bool
    text: str
    notes: list[str] = field(default_factory=list)


def write_crop_info(root: Path, crop_info, used, members, saved_ids, crop_cache, say, warn) -> None:
    """묶음 상자(판 좌표의 왼쪽 위 · 크기)를 JSON 으로. 묶음 항목이 모두 저장됐을 때만 그 묶음을 갱신하고, 다른 묶음 기록은 둔다."""
    path = Path(crop_info) if crop_info else Path(DEFAULT_CROP_INFO)
    if not path.is_absolute():
        path = root / path
    data: dict = {}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("groups", {}), dict):
                raise ValueError("형식이 다르다")
        except (OSError, ValueError) as e:
            warn(f"경고: 기존 상자 정보 파일을 못 읽어 새로 쓴다 ({type(e).__name__})")
            data = {}
    groups = data.get("groups", {})
    assets = (root / artlib.FINAL_BASE).resolve()
    wrote = []
    for name in sorted(used):
        mem = members[name]
        if any(m.id not in saved_ids for m in mem):
            warn(f"주의: crop_group '{name}' 항목이 모두 저장되지 않아 상자 정보를 갱신하지 않았다 — 다시 맞출 것")
            continue
        box, (W, H) = crop_cache[name]
        files = []
        for m in mem:
            try:
                files.append(m.final.relative_to(assets).as_posix())
            except ValueError:
                files.append(m.final.name)
        groups[name] = {
            "canvas": [W, H],
            "origin": [box[0], box[1]],
            "size": [box[2] - box[0], box[3] - box[1]],
            "files": sorted(files),
        }
        wrote.append(name)
    if not wrote:
        return
    payload = {"version": 1, "groups": dict(sorted(groups.items()))}
    artlib.atomic_write_bytes(path, (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    say(f"상자 정보: {path} 에 {', '.join(wrote)} 를 적었다 (origin = 잘린 그림의 왼쪽 위가 판의 어디인지)")


def overlay_name(ref: Item) -> str:
    """빈 물건 항목 id → 파일 이름 조각 (obj-v2-bowl-empty → bowl)."""
    name = ref.id
    for prefix in ("obj-v2-", "obj-"):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    if name.endswith("-empty"):
        name = name[: -len("-empty")]
    return name or ref.id


def overlay_ref(item: Item, by_id: dict[str, Item]) -> Item | None:
    """겹쳐 볼 때 윤곽선을 그릴 빈 물건 — move_like · align_to 를 따라가 align_to 가 없는 끝 항목. 없으면 None."""
    cur = item
    for _ in range(len(by_id) + 1):
        if cur.move_like:
            cur = by_id[cur.move_like]
        elif cur.align_to:
            nxt = by_id[cur.align_to]
            if not (nxt.align_to or nxt.move_like):
                return nxt
            cur = nxt
        else:
            return None
    return None


def run_overlay(args, table, targets, by_id, root, empty_plate, placement_of, measure_plate, say, warn) -> int:
    """물건마다 맞춤 전 · 후 겹쳐 보기 4장 (평균 겹침 · 윤곽선 격자 × 전 · 후). src/assets 는 건드리지 않는다."""
    directory = Path(args.overlay_dir or DEFAULT_OVERLAY_DIR)
    if not directory.is_absolute():
        errors: list[str] = []
        resolved = artlib.resolve_inside(root, directory.as_posix() + "/x", artlib.OUT_BASE, "--overlay-dir", errors)
        if resolved is None:
            for line in errors:
                warn(f"오류: {line}")
            return EXIT_USAGE
        directory = resolved.parent
    groups: dict[str, list[Item]] = {}
    for item in targets:
        if item.anchor != "none":
            continue
        root_ref = overlay_ref(item, by_id)
        if root_ref is not None:
            groups.setdefault(root_ref.id, []).append(item)
    if not groups:
        say("겹쳐 볼 항목이 없다 (선택한 항목 중 align_to 나 move_like 가 있는 것이 없다).")
        return EXIT_OK

    n_files, failed = 0, 0
    for ref_id, items in groups.items():
        ref = by_id[ref_id]
        name = overlay_name(ref)
        canvas = items[0].canvas
        try:
            empty = empty_plate(ref, canvas)
        except FitError as e:
            say(f"  {name}: 실패: {e}")
            failed += 1
            continue
        before, after = [], []
        for item in items:
            short = item.id[3:] if item.id.startswith("v2-") else item.id
            try:
                plate = fit_cover(measure_plate(item), canvas)
            except FitError as e:
                say(f"  {name}: {item.id}: 건너뜀 ({e})")  # 아직 안 만든 그림은 실패가 아니다
                continue
            note = ""
            moved_image = plate
            try:
                moved = placement_of(item)
                if moved is not None and moved.applied and not moved.placement.is_identity:
                    moved_image = align.apply_placement(plate, moved.placement)
                    pl = moved.placement
                    note = f" {pl.dx:+.0f},{pl.dy:+.0f} x{pl.scale:.3f}"
                elif moved is not None and not moved.applied:
                    note = " (not moved)"
            except FitError as e:
                say(f"  {name}: {item.id}: 이동을 못 구해 옮기지 않았다 ({e})")
                note = " (failed)"
            before.append((short, plate))
            after.append((short + note, moved_image))
        if not before:
            continue
        files = {
            f"{name}-stack-before.png": align.stack_overlay(empty, [p for _, p in before]),
            f"{name}-stack-after.png": align.stack_overlay(empty, [p for _, p in after]),
            f"{name}-grid-before.png": align.grid_overlay(empty, before),
            f"{name}-grid-after.png": align.grid_overlay(empty, after),
        }
        for fname, image in files.items():
            target = directory / fname
            if args.dry_run:
                say(f"  {name}: 만들 것 {target} ({image.width}x{image.height})")
            else:
                try:
                    artlib.atomic_write_bytes(target, encode_image(image, ".png", 0))
                except OSError as e:
                    say(f"  {name}: 실패: {fname} 을 못 썼다 ({type(e).__name__})")
                    failed += 1
                    continue
                say(f"  {name}: {target}")
            n_files += 1
    verb = "만들 것" if args.dry_run else "저장"
    say(f"요약: 겹쳐 보기 {verb} {n_files}장, 실패 {failed}" + ("  (--dry-run: 파일을 쓰지 않았다)" if args.dry_run else ""))
    return EXIT_FAILED if failed else EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="fit.py",
        description="그림 원본을 앱용 크기 · 기준점으로 맞춰 src/assets/ 에 저장한다 (표에서 final 이 있는 항목만).",
        epilog=(
            "예)\n"
            "  python scripts/cat-art/fit.py --group cats --dry-run --same-scale\n"
            "  python scripts/cat-art/fit.py --group cats --same-scale\n"
            "  python scripts/cat-art/fit.py --group v2-empty v2-objects v2-combos --overlay      (맞춤 전 · 후 겹쳐 보기만)\n"
            "\n"
            "anchor: feet = 아래 가운데 (아래 여백 일정), center = 가운데, none = 자르지 않고 canvas 크기로만.\n"
            "--same-scale: 같은 고양이(같은 설정 그림에서 나온, 프레임 사슬 포함) 자세들을 같은 배율로 — 가장 큰 자세가 canvas 에 맞는 배율.\n"
            "  가족 · 프레임 판단은 group 이 'cats' 이거나 '-cats' 로 끝나는(v2-cats) 항목끼리만 한다 (--frame-group 으로 더할 수 있다) —\n"
            "  물건 · 배경은 --same-scale 을 줘도 개별로 맞춘다.\n"
            "--match-frames(기본): 다음 프레임은 첫 프레임의 맞춘 내용 높이에 맞춘다. 첫 프레임이 선택되지 않았어도 같은 값으로 계산한다.\n"
            "size_like: 항목 키. 다른 항목 id 를 적으면 이 항목의 맞춘 내용 높이를 그 항목과 같게 한다 (다른 고양이의 같은 자세 크기에 맞출 때).\n"
            "우선순위: size_like > --match-frames > --same-scale. size_like 항목은 가족 배율 계산에서 빠진다. 대상이 선택되지 않아도 같은 값으로 계산한다.\n"
            "align_to: 항목 키(anchor none 전용). 빈 물건 항목 id — 합친 그림을 그 빈 그림의 불투명 영역에 가장 잘 겹치는 이동(±5%)과\n"
            "  배율(0.95~1.05)로 옮긴 뒤 판 크기로 저장. 점수(빈 물건 불투명 점 중 같은 색으로 겹친 비율)가 --align-min-score 보다 낮으면 옮기지 않고 알린다.\n"
            "nudge: 항목 키 [dx, dy, 배율] (판 px, 판 가운데 기준 q = c + 배율*(p - c) + (dx, dy)). 자동 찾기를 대신해 이 값을 그대로 쓴다.\n"
            "move_like: 항목 키. align_to · nudge 가 있는 다른 항목의 이동을 그대로 쓴다 (굴러간 공 같은, 물건이 움직인 그림).\n"
            "crop_group: 항목 키(anchor none 전용). 같은 이름 항목들의 (맞춘) 내용 합집합 상자로 자른다 — 묶음 전체를 같이 골라야 하고,\n"
            "  상자(판 좌표의 왼쪽 위)는 --crop-info JSON 에 적는다. --no-crop 이면 판 그대로.\n"
            "--overlay: 물건마다 빈 그림 + 합친 그림들의 겹침 · 윤곽선 격자 (맞춤 전 · 후) 를 --overlay-dir 에 만든다. src/assets 는 건드리지 않는다.\n"
            "맞춘 결과는 이미 있으면 덮어쓴다 (돈이 들지 않는다).\n"
            "종료 코드: 0 정상 · 1 일부 실패 · 2 표/인자 문제 · 3 Pillow 없음"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--table", type=Path, default=None, help="프롬프트 표 경로 (기본: scripts/cat-art/prompts.json)")
    p.add_argument("--group", action="extend", nargs="+", default=[], metavar="NAME", help="맞출 그룹 (여러 개 가능)")
    p.add_argument("--only", action="extend", nargs="+", default=[], metavar="ID", help="맞출 항목 id (여러 개 가능)")
    p.add_argument("--all", dest="select_all", action="store_true", help="표 전체 (final 이 있는 것만)")
    p.add_argument("--dry-run", action="store_true", help="파일을 쓰지 않고 할 일만 출력")
    p.add_argument("--same-scale", action="store_true", help="같은 고양이의 자세들을 같은 배율로 맞춤")
    p.add_argument("--match-frames", action=argparse.BooleanOptionalAction, default=True,
                   help="다음 프레임(walk-2 · play-2 · run-2 · sit-blink 등, refs[0] 이 첫 프레임)은 첫 프레임의 맞춘 결과와 "
                        "내용 높이가 같게 맞춘다 (기본 켬, --no-match-frames 로 끔). 높이 차이 15%% 초과면 경고")
    p.add_argument("--frame-group", action="extend", nargs="+", default=[], metavar="NAME",
                   help="가족 · 프레임 판단에 더할 그룹 이름 (기본: 'cats' 와 '-cats' 로 끝나는 그룹)")
    p.add_argument("--no-align", action="store_true", help="align_to · nudge · move_like 를 무시하고 판 그대로 맞춘다 (빈 물건 원본이 아직 없을 때)")
    p.add_argument("--align-min-score", type=float, default=DEFAULT_ALIGN_MIN_SCORE,
                   help=f"물건 맞춤 점수가 이보다 낮으면 옮기지 않고 알린다 (0~1, 기본 {DEFAULT_ALIGN_MIN_SCORE})")
    p.add_argument("--align-range", type=float, default=align.MAX_SHIFT if align else 0.05,
                   help="물건 가운데 이동 한도 (판 크기 대비 비율, 기본 0.05 = 5%%). 크게 밀린 그림은 넓히거나 nudge 로")
    p.add_argument("--overlay", action="store_true", help="맞춤 전 · 후를 겹쳐 보는 그림만 만든다 (src/assets 에는 쓰지 않는다)")
    p.add_argument("--overlay-dir", default=None, metavar="DIR", help=f"--overlay 결과 폴더 (기본 {DEFAULT_OVERLAY_DIR}, 상대 경로는 art/ 안)")
    p.add_argument("--no-crop", action="store_true", help="crop_group 을 무시하고 판 그대로 맞춘다")
    p.add_argument("--crop-info", default=None, metavar="PATH", help=f"crop_group 상자를 적는 JSON (기본 {DEFAULT_CROP_INFO})")
    p.add_argument("--webp-quality", type=int, default=DEFAULT_WEBP_QUALITY,
                   help=f"final 이 .webp 인 항목의 품질 0~100 (기본 {DEFAULT_WEBP_QUALITY}, 알파는 무손실). final 확장자가 형식을 정한다")
    p.add_argument("--margin", type=float, default=DEFAULT_MARGIN,
                   help=f"좌우 · 위(feet 가 아니면 아래도) 여백, canvas 대비 비율 (기본 {DEFAULT_MARGIN})")
    p.add_argument("--bottom-margin", type=float, default=DEFAULT_BOTTOM_MARGIN,
                   help=f"feet 의 아래 여백, canvas 대비 비율 (기본 {DEFAULT_BOTTOM_MARGIN})")
    p.add_argument("--alpha-threshold", type=int, default=DEFAULT_ALPHA_THRESHOLD,
                   help=f"이 값 이하 알파는 투명 여백으로 본다 (기본 {DEFAULT_ALPHA_THRESHOLD})")
    return p


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    sys.exit(main())
