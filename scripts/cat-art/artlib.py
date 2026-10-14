"""그림 스크립트 공통 — 프롬프트 표 읽기 · 검사, 경로 가두기, 임시 파일 → 이름 바꾸기 저장.

generate.py (그림 만들기) 와 fit.py (앱 크기로 맞추기) 가 같이 쓴다.
표 형식은 docs/02-development/briefs/P2-04-cat-art.md 의 "약속" 절을 따른다.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TABLE = Path(__file__).resolve().parent / "prompts.json"

# 원본 그림(out)은 art/ 안에만, 맞춘 결과(final)는 src/assets/ 안에만 쓴다.
OUT_BASE = "art"
FINAL_BASE = "src/assets"
FINAL_SUFFIXES = (".png", ".webp")

SUPPORTED_VERSION = 1
BACKGROUNDS = ("transparent", "opaque", "auto")
ANCHORS = ("feet", "center", "none")
MAX_REFS = 16  # edit 호출 한 번에 넣을 수 있는 참조 그림 수 (공식 문서)
MAX_PROMPT_CHARS = 32000  # gpt-image 프롬프트 상한 (공식 문서)

TOP_KEYS = {"version", "style", "references", "items"}
ITEM_KEYS = {
    "id", "group", "prompt", "refs", "size", "background", "out",
    "then_ref_as", "anchor", "canvas", "final", "size_like",
    "align_to", "nudge", "move_like", "crop_group", "align_scale", "align_range",
}

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_DIM_RE = re.compile(r"^(\d{1,5})x(\d{1,5})$")
_BAD_PATH_CHARS = re.compile(r'[<>:"|?*\\\x00-\x1f]')


NUDGE_SCALE_RANGE = (0.5, 2.0)  # nudge 배율로 허용하는 범위 (실수로 큰 값을 넣는 것을 막는다)
NUDGE_MAX_SHIFT = 4096  # nudge 이동(판 px)으로 허용하는 한도
ALIGN_SCALE_BOUNDS = (0.5, 2.0)  # align_scale 로 허용하는 범위
ALIGN_RANGE_MAX = 0.25  # align_range 로 허용하는 한도 (판 대비)


class TableError(Exception):
    """표를 못 쓰는 이유 목록. 하나씩 고치기 쉽게 한 번에 모아서 알린다."""

    def __init__(self, errors: list[str]):
        super().__init__("\n".join(errors))
        self.errors = errors


@dataclass
class Item:
    id: str
    group: str
    prompt: str
    size: str
    out: Path  # 절대 경로 (art/ 안)
    background: str = "auto"
    refs: list[str] = field(default_factory=list)
    then_ref_as: str | None = None
    anchor: str | None = None
    canvas: tuple[int, int] | None = None
    final: Path | None = None  # 절대 경로 (src/assets/ 안)
    size_like: str | None = None  # 맞춘 내용 높이를 같게 할 다른 항목의 id (fit.py)
    align_to: str | None = None  # 합친 그림을 겹쳐 맞출 빈 물건 항목의 id (fit.py, anchor none 전용)
    nudge: tuple[float, float, float] | None = None  # 손으로 정한 이동 [dx, dy, 배율] (판 px, 판 가운데 기준) — 자동 찾기를 대신한다
    move_like: str | None = None  # 다른 항목(align_to 나 nudge 가 있는)과 같은 이동을 쓴다 (예: 굴러간 공 그림)
    align_scale: tuple[float, float] | None = None  # 이 항목의 맞춤 배율 범위 [최소, 최대] (인자 기본 0.95~1.05 보다 앞선다)
    align_range: float | None = None  # 이 항목의 맞춤 이동 한도 (판 대비 비율, --align-range 보다 앞선다)
    crop_group: str | None = None  # 같은 이름 항목들을 내용 합집합 상자 하나로 잘라낸다 (fit.py, anchor none 전용)
    index: int = 0  # 표 안 순서


@dataclass
class Table:
    root: Path
    style: str
    references: dict[str, Path]  # 이름 → 절대 경로 (존재 여부는 쓰는 쪽에서 확인)
    items: list[Item]
    warnings: list[str] = field(default_factory=list)

    def by_id(self) -> dict[str, Item]:
        return {i.id: i for i in self.items}

    def producers(self) -> dict[str, Item]:
        """then_ref_as 이름 → 그걸 만드는 항목."""
        return {i.then_ref_as: i for i in self.items if i.then_ref_as}

    def rel(self, path: Path) -> str:
        try:
            return path.relative_to(self.root.resolve()).as_posix()
        except ValueError:
            return str(path)

    def prompt_for(self, item: Item) -> str:
        return f"{self.style}\n\n{item.prompt}" if self.style else item.prompt


def parse_dims(value: str) -> tuple[int, int] | None:
    m = _DIM_RE.match(value) if isinstance(value, str) else None
    if not m:
        return None
    w, h = int(m.group(1)), int(m.group(2))
    return (w, h) if w > 0 and h > 0 else None


def parse_nudge(value: object) -> tuple[float, float, float] | None:
    """[dx, dy, 배율] 이면 (dx, dy, 배율), 아니면 None. 숫자 셋 · 유한한 값 · 범위 안만 받는다."""
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf") for v in value):
        return None
    dx, dy, scale = (float(v) for v in value)
    if abs(dx) > NUDGE_MAX_SHIFT or abs(dy) > NUDGE_MAX_SHIFT:
        return None
    if not NUDGE_SCALE_RANGE[0] <= scale <= NUDGE_SCALE_RANGE[1]:
        return None
    return (dx, dy, scale)


def parse_align_scale(value: object) -> tuple[float, float] | None:
    """[최소, 최대] 이면 (최소, 최대), 아니면 None. 최소 ≤ 1 ≤ 최대, 허용 범위 안."""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf") for v in value):
        return None
    lo, hi = float(value[0]), float(value[1])
    if not (ALIGN_SCALE_BOUNDS[0] <= lo <= 1 <= hi <= ALIGN_SCALE_BOUNDS[1]):
        return None
    return (lo, hi)


def resolve_inside(root: Path, rel: object, base: str, label: str, errors: list[str]) -> Path | None:
    """표의 상대 경로가 root/base 안인지 확인하고 절대 경로를 돌려준다. 막히면 errors 에 이유를 더한다."""
    if not isinstance(rel, str) or not rel.strip():
        errors.append(f"{label}: 경로가 비어 있거나 문자열이 아니다")
        return None
    if _BAD_PATH_CHARS.search(rel):
        errors.append(f"{label}: 경로에 쓸 수 없는 문자 (\\ : * ? \" < > | 등) 가 있다 — '{rel}'")
        return None
    if rel.startswith("/"):
        errors.append(f"{label}: 절대 경로는 안 된다 — '{rel}'")
        return None
    parts = rel.split("/")
    for p in parts:
        if p in ("", ".", ".."):
            errors.append(f"{label}: 경로에 '..' · '.' · 빈 칸이 있으면 안 된다 — '{rel}'")
            return None
        if p != p.rstrip(" ."):
            errors.append(f"{label}: 폴더 · 파일 이름 끝에 공백이나 점이 있으면 안 된다 — '{rel}'")
            return None
    base_abs = (root / base).resolve()
    target = (root / rel).resolve()  # 심볼릭 링크 · 대소문자도 풀린 뒤 비교
    try:
        target.relative_to(base_abs)
    except ValueError:
        errors.append(f"{label}: '{base}/' 안이 아니다 — '{rel}'")
        return None
    if target == base_abs:
        errors.append(f"{label}: 파일 경로가 아니다 — '{rel}'")
        return None
    return target


def load_table(path: Path, root: Path) -> Table:
    """JSON 을 읽고 검사한다. 문제가 있으면 TableError (모든 문제를 모아서)."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as e:
        raise TableError([f"표 파일을 못 읽는다: {path} ({e.strerror or type(e).__name__})"])
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise TableError([f"표 JSON 문법 오류: {path} — {e.lineno}줄 {e.colno}칸, {e.msg}"])
    return validate_table(data, root)


def validate_table(data: object, root: Path) -> Table:
    errors: list[str] = []
    warnings: list[str] = []
    root = Path(root)

    if not isinstance(data, dict):
        raise TableError(["표 맨 위는 { } 객체여야 한다"])
    for key in sorted(set(data) - TOP_KEYS):
        warnings.append(f"알 수 없는 최상위 키 '{key}' — 무시한다")

    version = data.get("version")
    if version != SUPPORTED_VERSION or isinstance(version, bool):
        errors.append(f"version 은 {SUPPORTED_VERSION} 이어야 한다 (지금 {version!r})")

    style = data.get("style", "")
    if not isinstance(style, str):
        errors.append("style 은 문자열이어야 한다")
        style = ""

    references: dict[str, Path] = {}
    raw_refs = data.get("references", {})
    if not isinstance(raw_refs, dict):
        errors.append("references 는 { 이름: 경로 } 객체여야 한다")
        raw_refs = {}
    for name, rel in raw_refs.items():
        if not _NAME_RE.match(str(name)):
            errors.append(f"references 이름 '{name}': 영문 · 숫자 · . _ - 만 쓸 수 있다")
            continue
        target = resolve_inside(root, rel, ".", f"references['{name}']", errors)
        if target is not None:
            references[name] = target

    raw_items = data.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        errors.append("items 는 비어 있지 않은 배열이어야 한다")
        raw_items = []

    items: list[Item] = []
    seen_ids: dict[str, int] = {}
    seen_out: dict[Path, str] = {}
    seen_final: dict[Path, str] = {}
    seen_then: dict[str, str] = {}

    for idx, raw in enumerate(raw_items):
        label = f"items[{idx}]"
        if not isinstance(raw, dict):
            errors.append(f"{label}: 객체여야 한다")
            continue
        iid = raw.get("id")
        if isinstance(iid, str) and iid:
            label = f"items[{idx}] '{iid}'"
        for key in sorted(set(raw) - ITEM_KEYS):
            warnings.append(f"{label}: 알 수 없는 키 '{key}' — 무시한다")

        n_before = len(errors)

        for req in ("id", "group", "prompt", "size", "out"):
            v = raw.get(req)
            if not isinstance(v, str) or not v.strip():
                errors.append(f"{label}: 필수 키 '{req}' 가 없거나 비어 있다")
        if len(errors) > n_before:
            # 필수 키가 없으면 뒤 검사가 의미 없다
            continue

        if not _NAME_RE.match(iid):
            errors.append(f"{label}: id 는 영문 · 숫자 · . _ - 만 쓸 수 있다")
        if iid in seen_ids:
            errors.append(f"{label}: id 가 items[{seen_ids[iid]}] 와 겹친다")
        else:
            seen_ids[iid] = idx
        if not _NAME_RE.match(raw["group"]):
            errors.append(f"{label}: group '{raw['group']}' 은 영문 · 숫자 · . _ - 만 쓸 수 있다")

        if parse_dims(raw["size"]) is None and raw["size"] != "auto":
            errors.append(f"{label}: size 는 '1024x1024' 꼴이거나 'auto' 여야 한다 (지금 '{raw['size']}')")
        else:
            dims = parse_dims(raw["size"])
            if dims and (dims[0] % 16 or dims[1] % 16 or max(dims) > 3840):
                errors.append(f"{label}: size 는 16의 배수, 한 변 3840 이하여야 한다 ('{raw['size']}')")

        background = raw.get("background", "auto")
        if background not in BACKGROUNDS:
            errors.append(f"{label}: background 는 {'/'.join(BACKGROUNDS)} 중 하나여야 한다 (지금 {background!r})")

        refs = raw.get("refs", [])
        if not isinstance(refs, list) or not all(isinstance(r, str) and r for r in refs):
            errors.append(f"{label}: refs 는 이름 문자열의 배열이어야 한다")
            refs = []
        elif len(set(refs)) != len(refs):
            errors.append(f"{label}: refs 에 같은 이름이 두 번 있다")
        elif len(refs) > MAX_REFS:
            errors.append(f"{label}: refs 는 {MAX_REFS}장까지다 (지금 {len(refs)})")

        if len(style) + 2 + len(raw["prompt"]) > MAX_PROMPT_CHARS:
            errors.append(f"{label}: style + prompt 가 {MAX_PROMPT_CHARS}자를 넘는다")

        then = raw.get("then_ref_as")
        if then is not None:
            if not isinstance(then, str) or not _NAME_RE.match(then):
                errors.append(f"{label}: then_ref_as 는 영문 · 숫자 · . _ - 이름이어야 한다")
                then = None
            elif then in references or then in raw_refs:
                errors.append(f"{label}: then_ref_as '{then}' 가 references 의 이름과 겹친다")
            elif then in seen_then:
                errors.append(f"{label}: then_ref_as '{then}' 가 '{seen_then[then]}' 와 겹친다")
            else:
                seen_then[then] = iid

        anchor = raw.get("anchor")
        if anchor is not None and anchor not in ANCHORS:
            errors.append(f"{label}: anchor 는 {'/'.join(ANCHORS)} 중 하나여야 한다 (지금 {anchor!r})")
            anchor = None

        size_like = raw.get("size_like")
        if size_like is not None and (not isinstance(size_like, str) or not size_like):
            errors.append(f"{label}: size_like 는 다른 항목의 id 문자열이어야 한다")
            size_like = None

        align_to = raw.get("align_to")
        if align_to is not None and (not isinstance(align_to, str) or not align_to):
            errors.append(f"{label}: align_to 는 빈 물건 항목의 id 문자열이어야 한다")
            align_to = None
        move_like = raw.get("move_like")
        if move_like is not None and (not isinstance(move_like, str) or not move_like):
            errors.append(f"{label}: move_like 는 다른 항목의 id 문자열이어야 한다")
            move_like = None
        crop_group = raw.get("crop_group")
        if crop_group is not None and (not isinstance(crop_group, str) or not _NAME_RE.match(crop_group)):
            errors.append(f"{label}: crop_group 은 영문 · 숫자 · . _ - 이름이어야 한다")
            crop_group = None
        align_scale = None
        if raw.get("align_scale") is not None:
            align_scale = parse_align_scale(raw["align_scale"])
            if align_scale is None:
                errors.append(
                    f"{label}: align_scale 은 [최소, 최대] 숫자 둘이어야 한다 (최소 ≤ 1 ≤ 최대, "
                    f"{ALIGN_SCALE_BOUNDS[0]}~{ALIGN_SCALE_BOUNDS[1]} 안) — 지금 {raw['align_scale']!r}"
                )
        align_range = raw.get("align_range")
        if align_range is not None and (
            isinstance(align_range, bool) or not isinstance(align_range, (int, float))
            or not 0 < align_range <= ALIGN_RANGE_MAX
        ):
            errors.append(f"{label}: align_range 는 0 보다 크고 {ALIGN_RANGE_MAX} 이하인 숫자여야 한다 (지금 {align_range!r})")
            align_range = None
        nudge = None
        if raw.get("nudge") is not None:
            nudge = parse_nudge(raw["nudge"])
            if nudge is None:
                errors.append(
                    f"{label}: nudge 는 [dx, dy, 배율] 숫자 셋이어야 한다 (이동은 ±{NUDGE_MAX_SHIFT} 이내, "
                    f"배율은 {NUDGE_SCALE_RANGE[0]}~{NUDGE_SCALE_RANGE[1]}) — 지금 {raw['nudge']!r}"
                )

        canvas = None
        if raw.get("canvas") is not None:
            canvas = parse_dims(raw["canvas"])
            if canvas is None or max(canvas) > 8192:
                errors.append(f"{label}: canvas 는 '512x512' 꼴 (한 변 8192 이하) 이어야 한다 (지금 {raw['canvas']!r})")
                canvas = None

        out = resolve_inside(root, raw["out"], OUT_BASE, f"{label} out", errors)
        if out is not None:
            if out.suffix.lower() != ".png":
                errors.append(f"{label}: out 은 .png 여야 한다 (투명 배경은 PNG 로만 받는다)")
            elif out in seen_out:
                errors.append(f"{label}: out 이 '{seen_out[out]}' 와 같은 파일이다 — 서로 덮어쓴다")
            else:
                seen_out[out] = iid

        final = None
        if raw.get("final") is not None:
            final = resolve_inside(root, raw["final"], FINAL_BASE, f"{label} final", errors)
            if final is not None:
                if final.suffix.lower() not in FINAL_SUFFIXES:
                    errors.append(f"{label}: final 은 .png 또는 .webp 여야 한다")
                elif final in seen_final:
                    errors.append(f"{label}: final 이 '{seen_final[final]}' 와 같은 파일이다")
                else:
                    seen_final[final] = iid

        if len(errors) == n_before and out is not None:
            items.append(
                Item(
                    id=iid, group=raw["group"], prompt=raw["prompt"], size=raw["size"], out=out,
                    background=background, refs=list(refs), then_ref_as=then, anchor=anchor,
                    canvas=canvas, final=final, size_like=size_like, align_to=align_to, nudge=nudge,
                    move_like=move_like, crop_group=crop_group, align_scale=align_scale,
                    align_range=float(align_range) if align_range is not None else None, index=idx,
                )
            )

    # refs 가 가리키는 이름: references 의 키, 또는 **앞** 항목의 then_ref_as
    produced_at: dict[str, int] = {}
    for idx, raw in enumerate(raw_items):
        if isinstance(raw, dict) and isinstance(raw.get("then_ref_as"), str):
            produced_at.setdefault(raw["then_ref_as"], idx)
    for it in items:
        for name in it.refs:
            if name in raw_refs:
                continue
            if name not in produced_at:
                errors.append(
                    f"items[{it.index}] '{it.id}': refs '{name}' 가 references 에도, 어떤 항목의 then_ref_as 에도 없다"
                )
            elif produced_at[name] >= it.index:
                errors.append(
                    f"items[{it.index}] '{it.id}': refs '{name}' 를 만드는 항목이 이 항목보다 앞에 있어야 한다"
                )

    # size_like: 표에 있는 id, final 이 있는 다른 항목, 돌고 돌지 않기
    by_id = {it.id: it for it in items}
    for it in items:
        if not it.size_like:
            continue
        where = f"items[{it.index}] '{it.id}'"
        if it.size_like == it.id:
            errors.append(f"{where}: size_like 가 자기 자신을 가리킨다")
        elif it.size_like not in by_id:
            errors.append(f"{where}: size_like '{it.size_like}' 가 표에 없는 id 다")
        elif by_id[it.size_like].final is None:
            errors.append(f"{where}: size_like '{it.size_like}' 항목에 final 이 없다 (맞춘 결과가 있는 항목이어야 한다)")
    for it in items:
        seen = {it.id}
        cur = it
        while cur.size_like and cur.size_like in by_id and cur.size_like != cur.id:
            cur = by_id[cur.size_like]
            if cur.id in seen:
                errors.append(f"items[{it.index}] '{it.id}': size_like 가 돌고 돈다 ({it.id} -> ... -> {cur.id})")
                break
            seen.add(cur.id)

    # align_to · move_like: 표에 있는 다른 id, 돌고 돌지 않기 (move_like 의 대상은 align_to 나 nudge 가 있어야 한다)
    for it in items:
        where = f"items[{it.index}] '{it.id}'"
        if (it.align_scale is not None or it.align_range is not None) and it.align_to is None:
            errors.append(f"{where}: align_scale · align_range 는 align_to 가 있는 항목에서만 쓴다")
        if it.align_to is not None:
            if it.align_to == it.id:
                errors.append(f"{where}: align_to 가 자기 자신을 가리킨다")
            elif it.align_to not in by_id:
                errors.append(f"{where}: align_to '{it.align_to}' 가 표에 없는 id 다")
        if it.move_like is not None:
            target = by_id.get(it.move_like)
            if it.move_like == it.id:
                errors.append(f"{where}: move_like 가 자기 자신을 가리킨다")
            elif target is None:
                errors.append(f"{where}: move_like '{it.move_like}' 가 표에 없는 id 다")
            elif target.align_to is None and target.nudge is None:
                errors.append(f"{where}: move_like '{it.move_like}' 항목에 align_to 나 nudge 가 없다 (옮긴 값이 있는 항목이어야 한다)")
            if it.align_to is not None or it.nudge is not None:
                errors.append(f"{where}: move_like 는 align_to · nudge 와 같이 쓸 수 없다")

    # align_to 는 다른 합친 그림(그 항목의 맞춘 뒤 모습) 을 가리킬 수 있다 — 돌고 돌지 않기
    for it in items:
        seen = {it.id}
        cur = it
        while cur.align_to and cur.align_to in by_id and cur.align_to != cur.id:
            cur = by_id[cur.align_to]
            if cur.id in seen:
                errors.append(f"items[{it.index}] '{it.id}': align_to 가 돌고 돈다 ({it.id} -> ... -> {cur.id})")
                break
            seen.add(cur.id)

    if errors:
        raise TableError(errors)
    return Table(root=root, style=style, references=references, items=items, warnings=warnings)


def select_items(
    table: Table, groups: list[str] | None, only: list[str] | None, select_all: bool
) -> list[Item]:
    """--group · --only · --all 로 고른 항목 (표 순서). 합집합. 모르는 그룹 · id 는 TableError."""
    groups = groups or []
    only = only or []
    errors: list[str] = []
    known_groups = sorted({i.group for i in table.items})
    ids = {i.id for i in table.items}
    for g in groups:
        if g not in known_groups:
            errors.append(f"--group '{g}' 는 표에 없다 (있는 그룹: {', '.join(known_groups)})")
    for o in only:
        if o not in ids:
            errors.append(f"--only '{o}' 는 표에 없는 id 다")
    if not (groups or only or select_all):
        counts = ", ".join(f"{g}({sum(1 for i in table.items if i.group == g)}장)" for g in known_groups)
        errors.append(f"무엇을 할지 골라야 한다: --group <이름> · --only <id> · --all (그룹: {counts})")
    if errors:
        raise TableError(errors)
    if select_all:
        return list(table.items)
    return [i for i in table.items if i.group in groups or i.id in only]


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """같은 폴더의 임시 파일에 다 쓴 뒤 이름을 바꾼다 — 끊겨도 반쪽 파일이 path 로 남지 않는다."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def file_ready(path: Path) -> bool:
    """이미 만들어져 쓸 수 있는 파일인가 (있고, 비어 있지 않음)."""
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False
