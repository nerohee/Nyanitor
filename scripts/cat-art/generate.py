#!/usr/bin/env python
"""프롬프트 표(prompts.json)를 읽어 OpenAI 이미지 API 로 그림 원본을 만든다 (결정 D-34).

비용이 새지 않게: 이미 있는 그림은 건너뛰고, 한 번에 만들 장수 · 예상 비용에 상한이 있고,
--dry-run 으로 호출 없이 할 일과 비용을 먼저 볼 수 있다. 끊겨도 이어서 돌리면 된다.
키는 환경 변수 OPENAI_API_KEY 에서만 읽고, 어디에도 출력 · 저장하지 않는다.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import artlib
from artlib import Item, Table, TableError

# 날짜 붙은 버전으로 고정 — 별칭(gpt-image-2.5-sunburst)은 나중에 다른 스냅샷을 가리킬 수 있어 그림 화풍이 달라질 수 있다 (D-35)
DEFAULT_MODEL = "gpt-image-2.5-sunburst-2026-09-08"
DEFAULT_MAX_IMAGES = 10
QUALITIES = ("low", "medium", "high", "auto")
ENV_KEY = "OPENAI_API_KEY"
REQUEST_TIMEOUT_S = 300.0
RETRY_DELAYS_S = (2.0, 8.0)  # 첫 시도 + 재시도 2번
LEDGER_REL = "art/raw/ledger.jsonl"
LOCK_REL = "art/raw/.generate.lock"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_NOT_READY, EXIT_LOCKED, EXIT_INTERRUPTED = 0, 1, 2, 3, 4, 130

# 장당 가격 (USD). 출처: OpenAI 이미지 생성 가이드의 "per-image output pricing" 표 (2026-10-14 확인).
# gpt-image-2.5-* 는 표에 장당 가격이 없다 (토큰 요금이 gpt-image-2 와 같다고만 적혀 있음)
# → gpt-image-2 값으로 어림한다. 실제와 다를 수 있으니 --price-per-image 로 덮어쓸 수 있다.
_PRICE_TABLE = {
    "gpt-image-2": {
        "low": {"1024x1024": 0.006, "1024x1536": 0.005, "1536x1024": 0.005},
        "medium": {"1024x1024": 0.053, "1024x1536": 0.041, "1536x1024": 0.041},
        "high": {"1024x1024": 0.211, "1024x1536": 0.165, "1536x1024": 0.165},
    },
    "gpt-image-1.5": {
        "low": {"1024x1024": 0.009, "1024x1536": 0.013, "1536x1024": 0.013},
        "medium": {"1024x1024": 0.034, "1024x1536": 0.05, "1536x1024": 0.05},
        "high": {"1024x1024": 0.133, "1024x1536": 0.2, "1536x1024": 0.2},
    },
    "gpt-image-1": {
        "low": {"1024x1024": 0.011, "1024x1536": 0.016, "1536x1024": 0.016},
        "medium": {"1024x1024": 0.042, "1024x1536": 0.063, "1536x1024": 0.063},
        "high": {"1024x1024": 0.167, "1024x1536": 0.25, "1536x1024": 0.25},
    },
    "gpt-image-1-mini": {
        "low": {"1024x1024": 0.005, "1024x1536": 0.006, "1536x1024": 0.006},
        "medium": {"1024x1024": 0.011, "1024x1536": 0.015, "1536x1024": 0.015},
        "high": {"1024x1024": 0.036, "1024x1536": 0.052, "1536x1024": 0.052},
    },
}
_PRICE_ALIASES = {  # 장당 가격이 없어 다른 모델 값으로 어림하는 것
    "gpt-image-2.5-sunburst": "gpt-image-2",
    "gpt-image-2.5-flare": "gpt-image-2",
}
# 참조 그림을 넣으면 입력 토큰이 더 든다 (이미지 입력 $8 / 1M 토큰, 1024 그림 한 장 약 1~2천 토큰) → 장당 어림
REF_INPUT_COST_USD = 0.015
_SNAPSHOT_RE = re.compile(r"-\d{4}-\d{2}-\d{2}$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_KEY_LIKE_RE = re.compile(r"sk-[A-Za-z0-9_*.\-]{4,}")


class PricingError(Exception):
    pass


@dataclass
class Cost:
    usd: float
    estimated: bool  # 공식 장당 가격이 아니라 어림한 값


def estimate_cost(model: str, quality: str, size: str, n_refs: int, override: float | None) -> Cost:
    if override is not None:
        return Cost(override, False)
    base = _SNAPSHOT_RE.sub("", model)
    estimated = base in _PRICE_ALIASES or base != model
    family = _PRICE_ALIASES.get(base, base)
    table = _PRICE_TABLE.get(family)
    if table is None:
        raise PricingError(f"모델 '{model}' 의 장당 가격을 모른다 — --price-per-image <USD> 로 알려 주세요")
    by_size = table["high"] if quality == "auto" else table[quality]  # auto 는 가장 비싼 쪽으로 잡는다
    if quality == "auto":
        estimated = True
    if size in by_size:
        price = by_size[size]
    else:  # 표에 없는 크기: 1024x1024 값을 픽셀 수로 비례 (auto 는 세 크기 중 가장 비싼 값)
        estimated = True
        dims = artlib.parse_dims(size)
        if dims is None:
            price = max(by_size.values())
        else:
            price = by_size["1024x1024"] * (dims[0] * dims[1]) / (1024 * 1024)
    if n_refs:
        estimated = True
    return Cost(round(price + n_refs * REF_INPUT_COST_USD, 4), estimated)


def scrub(text: str, secret: str | None) -> str:
    """오류 문장에서 키(와 키처럼 생긴 조각)를 지운다. 오류 문장은 출력 · 장부에 가기 전에 반드시 거친다."""
    if secret:
        text = text.replace(secret, "[key]")
    return _KEY_LIKE_RE.sub("[key]", text)


def classify_error(exc: BaseException) -> str:
    """'fatal' 이어 돌려도 소용없음(인증 · 권한 · 결제) / 'retry' 잠시 뒤 다시 / 'fail' 이 항목만 실패."""
    status = getattr(exc, "status_code", None)
    code = getattr(exc, "code", None)
    name = type(exc).__name__
    if status in (401, 403) or name in ("AuthenticationError", "PermissionDeniedError"):
        return "fatal"
    if isinstance(code, str) and code in ("insufficient_quota", "billing_hard_limit_reached"):
        return "fatal"
    if status == 429 or name == "RateLimitError":
        return "retry"
    if isinstance(status, int) and status >= 500:
        return "retry"
    if name in ("APIConnectionError", "APITimeoutError") or isinstance(exc, (ConnectionError, TimeoutError)):
        return "retry"
    return "fail"


def describe_error(exc: BaseException, secret: str | None) -> str:
    status = getattr(exc, "status_code", None)
    head = type(exc).__name__ + (f" {status}" if status else "")
    msg = scrub(str(exc), secret).replace("\n", " ")[:200]
    return f"{head}: {msg}" if msg else head


@dataclass
class Entry:
    item: Item
    action: str  # "make" | "skip"
    call: str  # "generate" | "edit"
    cost: Cost


@dataclass
class Summary:
    made: int = 0
    skipped: int = 0
    failed: int = 0
    cost_usd: float = 0.0
    failed_ids: list[str] = field(default_factory=list)
    stopped: str | None = None  # 중단 이유 (인증 오류 · Ctrl+C 등)


def make_plan(
    table: Table, selected: list[Item], force: bool, model: str, quality: str, override: float | None
) -> tuple[list[Entry], list[str]]:
    """할 일 목록. 호출 전에 알 수 있는 문제(참조 없음 · 가격 모름)는 errors 로 모은다."""
    errors: list[str] = []
    producers = table.producers()
    plan: list[Entry] = []
    making: set[str] = set()
    for item in selected:
        exists = artlib.file_ready(item.out)
        action = "skip" if exists and not force else "make"
        call = "edit" if item.refs else "generate"
        try:
            cost = estimate_cost(model, quality, item.size, len(item.refs), override)
        except PricingError as e:
            errors.append(str(e))
            return plan, errors
        plan.append(Entry(item, action, call, cost))
        if action == "skip":
            continue
        for name in item.refs:
            if name in table.references:
                if not artlib.file_ready(table.references[name]):
                    errors.append(
                        f"'{item.id}': 참조 그림 '{name}' 파일이 없다 — {table.rel(table.references[name])}"
                    )
                continue
            producer = producers[name]  # 표 검사에서 존재 · 순서 보장됨
            if producer.id in making or artlib.file_ready(producer.out):
                continue
            errors.append(
                f"'{item.id}': 참조 '{name}' 은 '{producer.id}' 의 결과인데 아직 없다 — "
                f"먼저 --only {producer.id} 로 만드세요"
            )
        making.add(item.id)
    return plan, errors


class Ledger:
    """art/raw/ledger.jsonl — 장부. 키 · 응답 원문은 저장하지 않는다."""

    def __init__(self, path: Path):
        self.path = path

    def append(self, record: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, sort_keys=True)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())


class RunLock:
    """두 실행이 같이 돌아 돈이 두 번 나가지 않게 하는 잠금 파일."""

    def __init__(self, path: Path):
        self.path = path
        self.held = False

    def __enter__(self) -> "RunLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise LockedError(self.path)
        with os.fdopen(fd, "w") as f:
            f.write(str(os.getpid()))
        self.held = True
        return self

    def __exit__(self, *exc: object) -> None:
        if self.held:
            try:
                os.unlink(self.path)
            except OSError:
                pass


class LockedError(Exception):
    def __init__(self, path: Path):
        super().__init__(str(path))
        self.path = path


def _png_has_alpha_hint(data: bytes) -> bool | None:
    """PNG 헤더만 보고 알파가 있을 수 있는 색 종류인지 (그레이+알파 4 · RGBA 6 · 팔레트 3). 모르면 None."""
    if len(data) < 26:
        return None
    return data[25] in (3, 4, 6)


def decode_png(b64: object) -> bytes:
    if not isinstance(b64, str) or not b64:
        raise ValueError("응답에 b64_json 이 없다")
    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("응답 이미지를 base64 로 풀 수 없다")
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("응답 이미지가 PNG 가 아니다")
    return data


def preserve_previous(out: Path, stamp: str) -> Path:
    """--force 로 덮어쓰기 전에 기존 그림을 같은 폴더의 <이름>.prev-<시각>.png 로 옮긴다 (고객이 둘 중 고를 수 있게).
    옮기지 못하면 OSError — 그러면 생성하지 않는다."""
    target = out.with_name(f"{out.stem}.prev-{stamp}{out.suffix}")
    n = 2
    while target.exists():  # 같은 초에 두 번 — 덮어쓰지 않는다
        target = out.with_name(f"{out.stem}.prev-{stamp}-{n}{out.suffix}")
        n += 1
    os.replace(out, target)
    return target


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Settings:
    model: str
    quality: str
    override: float | None
    api_key: str | None


def run_plan(
    table: Table,
    plan: list[Entry],
    client: object,
    settings: Settings,
    ledger: Ledger,
    *,
    sleep: Callable[[float], None],
    now: Callable[[], str],
    say: Callable[[str], None],
    warn: Callable[[str], None],
) -> Summary:
    summary = Summary(skipped=sum(1 for e in plan if e.action == "skip"))
    todo = [e for e in plan if e.action == "make"]
    failed_outputs: set[str] = set()  # 만들지 못한 항목 id — 이걸 참조하는 항목은 호출 없이 실패
    producers = table.producers()

    def record(entry: Entry, status: str, cost: float, error: str | None = None, note: str | None = None) -> None:
        item = entry.item
        rec = {
            "ts": now(), "id": item.id, "group": item.group, "model": settings.model, "size": item.size,
            "quality": settings.quality, "background": item.background, "call": entry.call,
            "refs": len(item.refs), "status": status, "est_cost_usd": round(cost, 4),
            "out": table.rel(item.out),
        }
        if error:
            rec["error"] = error
        if note:
            rec["note"] = note
        try:
            ledger.append(rec)
        except OSError as e:
            warn(f"장부를 못 쓴다 ({type(e).__name__}) — 이 항목 기록이 빠진다: {item.id}")

    preserved: dict[str, Path] = {}  # 이번 실행에서 옮겨 둔 기존 그림 (id → 옮긴 경로)

    def restore(entry: Entry) -> str | None:
        """새 그림을 못 얻었으면 옮겨 둔 기존 그림을 제자리로 돌린다 (out 이 비어 있을 때만)."""
        prev = preserved.pop(entry.item.id, None)
        if prev is None or entry.item.out.exists():
            return None
        try:
            os.replace(prev, entry.item.out)
        except OSError as e:
            warn(f"기존 그림을 제자리로 못 돌렸다 ({type(e).__name__}) — {table.rel(prev)} 에 남아 있다")
            return f"기존 그림이 {prev.name} 에 남아 있다"
        return "기존 그림을 제자리로 돌려 놓았다"

    def fail(entry: Entry, message: str, cost: float = 0.0) -> None:
        note = restore(entry)
        summary.failed += 1
        summary.failed_ids.append(entry.item.id)
        summary.cost_usd += cost
        failed_outputs.add(entry.item.id)
        record(entry, "failed", cost, error=message, note=note)
        warn(f"실패 {entry.item.id}: {message}")

    total = len(todo)
    for n, entry in enumerate(todo, 1):
        item = entry.item
        # 참조 그림 경로 풀기 (앞 항목의 결과는 지금 시점의 파일로)
        ref_paths: list[Path] = []
        missing: str | None = None
        for name in item.refs:
            if name in table.references:
                path = table.references[name]
            else:
                producer = producers[name]
                if producer.id in failed_outputs:
                    missing = f"참조 '{name}' 를 만드는 '{producer.id}' 가 실패했다"
                    break
                path = producer.out
            if not artlib.file_ready(path):
                missing = f"참조 그림 파일이 없다: {table.rel(path)}"
                break
            ref_paths.append(path)
        if missing:
            fail(entry, missing)
            continue

        keep_note = None
        if artlib.file_ready(item.out):  # --force 로 다시 뽑는 경우 — 기존 그림을 먼저 보존
            try:
                stamp = _stamp(now())
                preserved[item.id] = preserve_previous(item.out, stamp)
            except OSError as e:
                fail(entry, f"기존 그림을 보존하지 못해 만들지 않았다 ({type(e).__name__})")
                continue
            keep_note = f"기존 그림 보존: {table.rel(preserved[item.id])}"
            say(f"  기존 그림을 {preserved[item.id].name} 로 보존")

        say(f"[{n}/{total}] {item.id} ({entry.call}, {item.size}, {settings.quality}) ...")
        params = {
            "model": settings.model,
            "prompt": table.prompt_for(item),
            "size": item.size,
            "quality": settings.quality,
            "background": item.background,
            "output_format": "png",
            "n": 1,
        }
        try:
            result = _call_with_retry(client, entry.call, params, ref_paths, settings, sleep, warn, item.id)
        except _Fatal as e:
            fail(entry, str(e))
            summary.stopped = f"{e} — 남은 항목은 시도하지 않았다"
            break
        except _Failed as e:
            fail(entry, str(e))
            continue
        except KeyboardInterrupt:
            note = "요청 중 중단 — 서버에서 과금됐는지 알 수 없다"
            record(entry, "interrupted", 0.0, note=_join(note, restore(entry)))
            summary.stopped = "Ctrl+C 로 중단"
            break

        # 응답을 받았으니 돈은 나갔다고 본다. 저장에 실패해도 비용은 센다.
        try:
            data = decode_png(getattr(result.data[0], "b64_json", None))
            artlib.atomic_write_bytes(item.out, data)
        except (ValueError, IndexError, TypeError, AttributeError) as e:
            fail(entry, f"응답을 쓸 수 없다: {scrub(str(e), settings.api_key)}", cost=entry.cost.usd)
            continue
        except OSError as e:
            fail(entry, f"그림을 저장하지 못했다 ({type(e).__name__})", cost=entry.cost.usd)
            continue
        except KeyboardInterrupt:
            note = "응답은 받았으나 저장 중 중단 — 비용은 나갔다"
            record(entry, "interrupted", entry.cost.usd, note=_join(note, restore(entry)))
            summary.cost_usd += entry.cost.usd
            summary.stopped = "Ctrl+C 로 중단"
            break

        note = None
        if item.background == "transparent" and _png_has_alpha_hint(data) is False:
            note = "투명 배경을 요청했지만 받은 PNG 에 알파 채널이 없다"
            warn(f"주의 {item.id}: {note}")
        preserved.pop(item.id, None)  # 새 그림이 저장됐으니 되돌릴 일 없음 (옛 그림은 .prev 로 남는다)
        summary.made += 1
        summary.cost_usd += entry.cost.usd
        record(entry, "ok", entry.cost.usd, note=_join(note, keep_note))
        failed_outputs.discard(item.id)
    return summary


def _join(*notes: str | None) -> str | None:
    return "; ".join(n for n in notes if n) or None


def _stamp(iso: str) -> str:
    try:
        t = datetime.fromisoformat(iso)
    except ValueError:
        t = datetime.now(timezone.utc)
    return t.strftime("%Y%m%d-%H%M%S")


class _Fatal(Exception):
    pass


class _Failed(Exception):
    pass


def _call_with_retry(client, call, params, ref_paths, settings, sleep, warn, item_id):
    attempts = len(RETRY_DELAYS_S) + 1
    for attempt in range(1, attempts + 1):
        try:
            with contextlib.ExitStack() as stack:
                if call == "edit":
                    files = [stack.enter_context(open(p, "rb")) for p in ref_paths]
                    return client.images.edit(image=files, **params)
                return client.images.generate(**params)
        except KeyboardInterrupt:
            raise
        except Exception as e:  # noqa: BLE001 — 분류해서 다룬다
            kind = classify_error(e)
            text = describe_error(e, settings.api_key)
            if kind == "fatal":
                raise _Fatal(text)
            if kind == "retry" and attempt < attempts:
                delay = RETRY_DELAYS_S[attempt - 1]
                warn(f"재시도 {item_id}: {text} — {delay:g}초 뒤 ({attempt}/{attempts - 1})")
                sleep(delay)
                continue
            raise _Failed(text)
    raise _Failed("알 수 없는 상태")  # 도달하지 않음


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="generate.py",
        description="프롬프트 표(prompts.json)로 OpenAI 이미지 API 에서 그림 원본을 만든다 (art/ 아래에 저장).",
        epilog=(
            "예)\n"
            "  python scripts/cat-art/generate.py --group test --dry-run     # 키 없이 할 일 · 예상 비용\n"
            "  python scripts/cat-art/generate.py --group test               # 실제 생성 (OPENAI_API_KEY 필요)\n"
            "  python scripts/cat-art/generate.py --only cat-nabi-sheet --force\n"
            "\n"
            "키: 환경 변수 OPENAI_API_KEY 에서만 읽는다. 출력 · 장부 · 파일에 남기지 않는다.\n"
            "이미 있는 out 은 건너뛴다 (--force 로 다시 — 기존 그림은 <이름>.prev-<시각>.png 로 보존). 끊겨도 같은 명령을 다시 돌리면 이어진다.\n"
            "장부: art/raw/ledger.jsonl (id · 모델 · 크기 · 품질 · 시각 · 예상 비용 · 성공/실패).\n"
            "종료 코드: 0 정상 · 1 일부 실패 · 2 표/인자/상한 문제 · 3 키·패키지 없음 · 4 다른 실행이 돌고 있음 · 130 Ctrl+C"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--table", type=Path, default=None, help="프롬프트 표 경로 (기본: scripts/cat-art/prompts.json)")
    p.add_argument("--group", action="extend", nargs="+", default=[], metavar="NAME",
                   help="만들 그룹 (여러 개 가능: --group test cats)")
    p.add_argument("--only", action="extend", nargs="+", default=[], metavar="ID",
                   help="만들 항목 id (여러 개 가능, --group 과 합쳐서 고른다)")
    p.add_argument("--all", dest="select_all", action="store_true", help="표 전체 (장수 상한은 그대로 적용)")
    p.add_argument("--dry-run", action="store_true", help="호출 없이 할 일 · 장수 · 예상 비용만 출력 (키 필요 없음)")
    p.add_argument("--max-images", type=int, default=DEFAULT_MAX_IMAGES,
                   help=f"한 번에 만들 장수 상한, 넘으면 하나도 만들지 않고 멈춘다 (기본 {DEFAULT_MAX_IMAGES})")
    p.add_argument("--budget-usd", type=float, default=None,
                   help="예상 비용 상한(USD), 넘으면 하나도 만들지 않고 멈춘다")
    p.add_argument("--quality", choices=QUALITIES, default="medium", help="품질 (기본 medium; auto 는 가장 비싼 값으로 셈)")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"이미지 모델 (기본 {DEFAULT_MODEL})")
    p.add_argument("--price-per-image", type=float, default=None, metavar="USD",
                   help="장당 가격을 직접 지정 (예상 비용 계산용 — 모델 가격을 모르거나 어림값이 다를 때)")
    p.add_argument("--force", action="store_true", help="이미 있는 out 도 다시 만든다 (돈이 다시 든다). 기존 그림은 같은 폴더에 <이름>.prev-<시각>.png 로 남긴다")
    return p


def main(
    argv: list[str] | None = None,
    *,
    root: Path | None = None,
    env: dict | None = None,
    client_factory: Callable[[str], object] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], str] = now_iso,
    stdout=None,
    stderr=None,
) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    env = os.environ if env is None else env
    root = Path(root) if root else artlib.REPO_ROOT

    def say(msg: str = "") -> None:
        print(msg, file=out, flush=True)

    def warn(msg: str) -> None:
        print(msg, file=err, flush=True)

    args = build_parser().parse_args(argv)

    if args.max_images < 1:
        warn("--max-images 는 1 이상이어야 한다")
        return EXIT_USAGE
    if args.budget_usd is not None and args.budget_usd <= 0:
        warn("--budget-usd 는 0보다 커야 한다")
        return EXIT_USAGE
    if args.price_per_image is not None and args.price_per_image < 0:
        warn("--price-per-image 는 0 이상이어야 한다")
        return EXIT_USAGE
    if not _MODEL_RE.match(args.model):
        warn("--model 이름이 올바르지 않다")
        return EXIT_USAGE

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

    plan, errors = make_plan(table, selected, args.force, args.model, args.quality, args.price_per_image)
    to_make = [e for e in plan if e.action == "make"]
    total_cost = round(sum(e.cost.usd for e in to_make), 4)
    any_estimated = any(e.cost.estimated for e in to_make)

    say(f"모델 {args.model} · 품질 {args.quality}")
    for e in plan:
        if e.action == "skip":
            say(f"  건너뜀  {e.item.id}  (이미 있음: {table.rel(e.item.out)})")
        else:
            refs = f" 참조 {len(e.item.refs)}장" if e.item.refs else ""
            say(f"  할 일   {e.item.id}  [{e.item.group}] {e.call} {e.item.size}{refs}  ~${e.cost.usd:.3f}  -> {table.rel(e.item.out)}")
    say(
        f"만들 것 {len(to_make)}장, 건너뜀 {len(plan) - len(to_make)}장, "
        f"예상 비용 ${total_cost:.2f}" + (" (일부 어림값)" if any_estimated else "")
    )

    problems = list(errors)
    if len(to_make) > args.max_images:
        problems.append(
            f"만들 장수 {len(to_make)}장이 --max-images {args.max_images} 를 넘는다 — 의도한 것이면 --max-images 를 올리세요"
        )
    if args.budget_usd is not None and total_cost > args.budget_usd:
        problems.append(f"예상 비용 ${total_cost:.2f} 가 --budget-usd ${args.budget_usd:.2f} 를 넘는다")
    if problems:
        for line in problems:
            warn(f"멈춤: {line}")
        warn("아무것도 만들지 않았다." if not args.dry_run else "이 상태로 실행하면 같은 이유로 멈춘다.")
        return EXIT_USAGE

    if args.dry_run:
        say("--dry-run: API 를 호출하지 않았다.")
        return EXIT_OK
    if not to_make:
        say("할 일이 없다.")
        return EXIT_OK

    api_key = (env.get(ENV_KEY) or "").strip()
    if not api_key:
        warn(
            f"환경 변수 {ENV_KEY} 가 없어서 멈춘다 (API 는 호출하지 않았다).\n"
            f"  PowerShell: $env:{ENV_KEY} = '<키>'   (그 창에서만 유효)\n"
            "  키는 이 저장소 · 채팅 · 파일에 적지 마세요."
        )
        return EXIT_NOT_READY

    try:
        factory = client_factory or default_client_factory
        client = factory(api_key)
    except SetupError as e:
        warn(f"오류: {e}")
        return EXIT_NOT_READY

    settings = Settings(args.model, args.quality, args.price_per_image, api_key)
    ledger = Ledger(root / LEDGER_REL)
    try:
        with RunLock(root / LOCK_REL):
            summary = run_plan(table, plan, client, settings, ledger, sleep=sleep, now=now, say=say, warn=warn)
    except LockedError as e:
        warn(f"다른 실행이 돌고 있는 것 같다 (잠금 파일: {e.path}). 아니라면 그 파일을 지우고 다시 하세요.")
        return EXIT_LOCKED
    except KeyboardInterrupt:
        warn("Ctrl+C 로 중단 — 지금까지 만든 그림 · 장부는 남아 있다.")
        return EXIT_INTERRUPTED

    say("")
    say(
        f"요약: 만듦 {summary.made}장, 건너뜀 {summary.skipped}장, 실패 {summary.failed}장, "
        f"예상 비용 합 ${summary.cost_usd:.2f}"
    )
    if summary.failed_ids:
        say("실패: " + ", ".join(summary.failed_ids) + "  (같은 명령을 다시 돌리면 실패한 것만 다시 한다)")
    if summary.stopped:
        say(f"중단: {summary.stopped}")
    if summary.stopped and "Ctrl+C" in summary.stopped:
        return EXIT_INTERRUPTED
    return EXIT_FAILED if (summary.failed or summary.stopped) else EXIT_OK


class SetupError(Exception):
    pass


def default_client_factory(api_key: str):
    try:
        from openai import OpenAI
    except ImportError:
        raise SetupError(
            "openai 패키지가 없다. 가상 환경에서: pip install -r scripts/cat-art/requirements.txt"
        )
    # 재시도는 이 스크립트가 직접 한다 (SDK 가 몰래 다시 보내 이중 과금되지 않게)
    return OpenAI(api_key=api_key, max_retries=0, timeout=REQUEST_TIMEOUT_S)


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    sys.exit(main())
