#!/usr/bin/env python
"""만든 그림 원본(art/ 아래)을 앱에 넣을 크기 · 기준점으로 맞춰 src/assets/ 에 저장한다.

표에서 `final` 이 있는 항목만 다룬다. 순서: 투명 여백 잘라내기 → canvas 안에 비율 유지해 넣기 →
anchor 에 맞춰 놓기 (feet: 아래 가운데, 아래 여백 일정 · center: 가운데 · none: 크기만) → 저장.
`final` 확장자가 형식을 정한다 (.png · .webp — WebP 는 알파 유지, --webp-quality).
"""

from __future__ import annotations

import argparse
import io
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import artlib
from artlib import Item, Table, TableError

try:
    from PIL import Image, UnidentifiedImageError
except ImportError:  # 요구 사항: pip install -r scripts/cat-art/requirements.txt
    Image = None
    UnidentifiedImageError = Exception

DEFAULT_MARGIN = 0.04  # 좌우 · 위 여백 (캔버스 대비)
DEFAULT_BOTTOM_MARGIN = 0.06  # 아래 여백 — feet 기준에서 모든 그림이 같다
DEFAULT_ALPHA_THRESHOLD = 8  # 이 값 이하의 거의 투명한 점은 여백으로 본다
SPREAD_WARN_RATIO = 1.5  # 같은 고양이 자세들의 배율 차이가 이 비율을 넘으면 알린다
FRAME_GROUP = "cats"  # 가족(--same-scale) · 프레임(--match-frames) 판단은 이 group 의 항목끼리만 — 물건 · 배경은 개별로
DEFAULT_WEBP_QUALITY = 90  # 실제 그림에서 80~95 를 재 본 결과: 90 부터는 오차가 거의 안 줄고 용량만 는다
FRAME_HEIGHT_WARN = 0.15  # 프레임 짝의 원본 내용 높이가 첫 프레임과 이 비율 넘게 다르면 알린다

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


def family_key(item: Item, table: Table) -> str | None:
    """같은 고양이의 자세들 = 같은 설정 그림에서 나온 항목들. refs 를 거슬러 올라가
    `final` 이 없는 생산자(설정 그림) 의 id 로 묶는다. 다음 프레임이 첫 프레임을 참조해도
    (프레임 → 첫 프레임 → 설정 그림) 같은 묶음이다. 참조는 항상 앞 항목이라 끝이 있다."""
    if item.group != FRAME_GROUP:
        return None
    producers = table.producers()
    for name in item.refs:
        producer = producers.get(name)
        if producer is None:
            continue
        if producer.final is None:
            return producer.id
        return family_key(producer, table) or producer.id
    return None


def first_frame_of(item: Item, table: Table) -> Item | None:
    """다음 프레임 항목이면 그 첫 프레임. 다음 프레임 = `then_ref_as` 가 없고, refs[0] 이 `final` 이 있는
    항목(첫 프레임)의 결과인 `final` 항목 (예: walk-2 → walk-1, sit-blink → sit)."""
    if item.group != FRAME_GROUP or item.final is None or item.then_ref_as or not item.refs:
        return None
    if item.anchor in (None, "none"):
        return None
    producer = table.producers().get(item.refs[0])
    if (
        producer is not None and producer.group == FRAME_GROUP and producer.final is not None
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
            key = family_key(item, table)
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
            if args.match_frames and first_frame_of(m, table) is not None:
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

    for key in sorted({family_key(i, table) for i in targets if i.anchor != "none"} - {None}):
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
            key = family_key(item, table) if args.same_scale else None
            ensure_family(key)
            m = get_measured(item)
            if m is None:
                raise FitError(failures[item.id])
            result: tuple[float, list[str]]
            first = first_frame_of(item, table) if args.match_frames else None
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

    results: list[tuple[str, str]] = []
    n_ok = 0
    for item in targets:
        label = f"{item.id}  {table.rel(item.out)} -> {table.rel(item.final)}  ({item.anchor}, {item.canvas[0]}x{item.canvas[1]})"
        m = get_measured(item)
        if m is None:
            results.append((label, "실패: " + failures[item.id]))
            continue
        try:
            if item.anchor == "none":
                aspect_diff = abs(m.crop.width / m.crop.height - item.canvas[0] / item.canvas[1])
                extra = ""
                if aspect_diff > 0.01:
                    extra = "  [주의: 비율이 달라 넘치는 쪽을 잘랐다]"
                image = fit_cover(m.crop, item.canvas)
                detail = f"크기만 {m.crop.width}x{m.crop.height} -> {item.canvas[0]}x{item.canvas[1]}{extra}"
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
            n_ok += 1
        except (FitError, OSError) as e:
            results.append((label, f"실패: {e if isinstance(e, FitError) else type(e).__name__}"))

    for label, status in results:
        say(f"  {label}\n      {status}")
    for key in sorted(notes):
        for msg in notes[key]:
            warn(f"주의: {msg}")
    failed = sum(1 for _, s in results if s.startswith("실패"))
    verb = "미리보기" if args.dry_run else "저장"
    say(f"요약: {verb} {n_ok}장, 실패 {failed}장" + ("  (--dry-run: 파일을 쓰지 않았다)" if args.dry_run else ""))
    return EXIT_FAILED if failed else EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="fit.py",
        description="그림 원본을 앱용 크기 · 기준점으로 맞춰 src/assets/ 에 저장한다 (표에서 final 이 있는 항목만).",
        epilog=(
            "예)\n"
            "  python scripts/cat-art/fit.py --group cats --dry-run --same-scale\n"
            "  python scripts/cat-art/fit.py --group cats --same-scale\n"
            "\n"
            "anchor: feet = 아래 가운데 (아래 여백 일정), center = 가운데, none = 자르지 않고 canvas 크기로만.\n"
            "--same-scale: 같은 고양이(같은 설정 그림에서 나온, 프레임 사슬 포함) 자세들을 같은 배율로 — 가장 큰 자세가 canvas 에 맞는 배율.\n"
            "  가족 · 프레임 판단은 group 이 'cats' 인 항목끼리만 한다 — 물건 · 배경은 --same-scale 을 줘도 개별로 맞춘다.\n"
            "--match-frames(기본): 다음 프레임은 첫 프레임의 맞춘 내용 높이에 맞춘다. 첫 프레임이 선택되지 않았어도 같은 값으로 계산한다.\n"
            "size_like: 항목 키. 다른 항목 id 를 적으면 이 항목의 맞춘 내용 높이를 그 항목과 같게 한다 (다른 고양이의 같은 자세 크기에 맞출 때).\n"
            "우선순위: size_like > --match-frames > --same-scale. size_like 항목은 가족 배율 계산에서 빠진다. 대상이 선택되지 않아도 같은 값으로 계산한다.\n"
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
