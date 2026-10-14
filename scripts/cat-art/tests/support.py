"""시험 공용 — scripts/cat-art 를 import 경로에 넣고, 가짜 표 · 가짜 클라이언트 · 작은 PNG 를 만든다."""

from __future__ import annotations

import base64
import io
import json
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace

SCRIPT_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

FAKE_KEY = "sk-test-SECRETKEY1234567890"


def make_png(width: int = 2, height: int = 2, color_type: int = 6) -> bytes:
    """표준 라이브러리만으로 만든 단색 PNG (color_type 6 = RGBA, 2 = RGB)."""
    channels = 4 if color_type == 6 else 3
    row = b"\x00" + bytes([200, 120, 40, 255][:channels]) * width
    raw = row * height

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


class TempRoot(unittest.TestCase):
    """각 시험마다 빈 저장소 흉내 폴더(root)를 만든다."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve()
        (self.root / "art").mkdir()
        (self.root / "src" / "assets").mkdir(parents=True)
        (self.root / "refs").mkdir()
        (self.root / "refs" / "style-cat.png").write_bytes(make_png())
        (self.root / "refs" / "style-scene.png").write_bytes(make_png())

    def write_table(self, items: list[dict], **top) -> Path:
        data = {
            "version": 1,
            "style": "STYLE",
            "references": {"style-cat": "refs/style-cat.png", "style-scene": "refs/style-scene.png"},
            "items": items,
        }
        data.update(top)
        path = self.root / "prompts.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    @staticmethod
    def item(iid: str, **kw) -> dict:
        base = {
            "id": iid, "group": "test", "prompt": f"prompt {iid}", "size": "1024x1024",
            "background": "transparent", "out": f"art/raw/{iid}.png",
        }
        base.update(kw)
        return base


class FakeImages:
    def __init__(self, owner: "FakeClient"):
        self.owner = owner

    def _respond(self, kind: str, kwargs: dict):
        record = {"kind": kind, **{k: v for k, v in kwargs.items() if k != "image"}}
        if "image" in kwargs:
            files = kwargs["image"]
            record["image_names"] = [Path(f.name).as_posix() for f in files]
            record["image_heads"] = [f.read(8) for f in files]
        self.owner.calls.append(record)
        behavior = self.owner.behaviors.pop(0) if self.owner.behaviors else None
        if isinstance(behavior, BaseException):
            raise behavior
        if callable(behavior):
            return behavior()
        png = behavior if isinstance(behavior, str) else b64(self.owner.png)
        return SimpleNamespace(data=[SimpleNamespace(b64_json=png)])

    def generate(self, **kwargs):
        return self._respond("generate", kwargs)

    def edit(self, **kwargs):
        return self._respond("edit", kwargs)


class FakeClient:
    """네트워크 없는 가짜. behaviors 에 예외 / base64 문자열 / 함수를 차례로 넣으면 호출마다 하나씩 쓴다."""

    def __init__(self, behaviors: list | None = None, png: bytes | None = None):
        self.calls: list[dict] = []
        self.behaviors = list(behaviors or [])
        self.png = png or make_png(4, 4)
        self.images = FakeImages(self)


class FakeApiError(Exception):
    def __init__(self, message: str, status_code: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class Capture:
    def __init__(self):
        self.out = io.StringIO()
        self.err = io.StringIO()

    @property
    def text(self) -> str:
        return self.out.getvalue() + self.err.getvalue()
