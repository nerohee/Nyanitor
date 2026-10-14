"""fit.py 물건 기준 맞춤(align_to · nudge · move_like) · 겹쳐 보기(--overlay) · 공통 잘라내기(crop_group) · 프레임 그룹 이름 시험.
작은 합성 그림으로 — 빈 물건에 고양이 덩어리를 얹고 알려진 만큼 밀어 놓은 "합친 그림" 을 만들어 되찾게 한다.
Pillow 가 없으면 건너뛴다 (가상 환경에서는 돈다)."""

import io
import json
import unittest

import support
from support import Capture

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    Image = None

if Image is not None:
    import align
    import fit
    import test_fit

SIZE = 160  # 판 — 5% = 8px
RED, TAN, DARK, BLUE = (180, 60, 60, 255), (200, 160, 90, 255), (80, 50, 20, 255), (60, 60, 200, 255)
CAT = (250, 250, 240, 255)


def png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def empty_object(size=SIZE):
    """비대칭 물건: 몸통 + 지붕 + 파란 말뚝 + 한쪽 꼬리. 판 가운데 아래."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle((50, 70, 110, 120), fill=TAN, outline=DARK)
    d.polygon([(50, 70), (80, 40), (110, 70)], fill=RED, outline=DARK)
    d.rectangle((58, 95, 68, 120), fill=BLUE)
    d.rectangle((111, 100, 128, 106), fill=DARK)
    return img


def with_cat(img):
    """물건 위에 고양이 덩어리를 얹는다 (물건의 오른쪽 위를 가린다)."""
    out = img.copy()
    d = ImageDraw.Draw(out)
    d.ellipse((84, 66, 124, 104), fill=CAT, outline=DARK)
    return out


def combo(shift=(0, 0), scale=1.0, size=SIZE):
    """빈 물건을 (shift, scale) 만큼 옮긴 뒤 고양이를 얹은 합친 그림. 고양이는 물건과 같이 움직인 모양이 된다."""
    moved = align.apply_placement(empty_object(size), align.Placement(shift[0], shift[1], scale))
    return with_cat(moved)


@unittest.skipIf(Image is None, "Pillow 가 없다 — scripts/cat-art/.venv 에서 돌리세요")
class FindAlignment(unittest.TestCase):
    def test_recovers_a_known_shift(self):
        found = align.find_alignment(empty_object(), combo((-5, 4)))
        self.assertAlmostEqual(found.placement.dx, 5, delta=1)
        self.assertAlmostEqual(found.placement.dy, -4, delta=1)
        self.assertAlmostEqual(found.placement.scale, 1.0, delta=0.01)
        self.assertGreater(found.score, found.identity_score + 0.2)
        self.assertFalse(found.at_limit)

    def test_recovers_shift_and_scale(self):
        found = align.find_alignment(empty_object(), combo((3, -2), 1.04))
        self.assertAlmostEqual(found.placement.scale, 1 / 1.04, delta=0.02)  # 이동과 배율이 서로 보태 주는 능선이라 약간 비껴도 된다
        back = align.apply_placement(combo((3, -2), 1.04), found.placement)
        # 되돌린 그림의 물건(말뚝 · 지붕 꼭대기) 이 빈 물건과 같은 자리에 온다
        for point in ((63, 115), (80, 45)):
            for got, want in zip(back.getpixel(point)[:3], empty_object().getpixel(point)[:3]):
                self.assertAlmostEqual(got, want, delta=3, msg=str(point))  # 다시 뽑으며 생기는 반올림 오차

    def test_already_aligned_stays_put(self):
        found = align.find_alignment(empty_object(), combo())
        self.assertTrue(found.placement.is_identity)
        self.assertGreater(found.score, 0.6)  # 고양이가 가린 만큼 1 에 못 미친다

    def test_unrelated_picture_scores_low(self):
        other = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        ImageDraw.Draw(other).rectangle((5, 5, 45, 40), fill=(20, 160, 20, 255))
        found = align.find_alignment(empty_object(), other)
        self.assertLess(found.score, 0.1)

    def test_shift_limit_is_respected_and_flagged(self):
        found = align.find_alignment(empty_object(), combo((-20, 0)))  # 한도 5% = 8px 보다 크게 밀림
        self.assertLessEqual(abs(found.object_shift[0]), 8.01)
        self.assertTrue(found.at_limit)
        wide = align.find_alignment(empty_object(), combo((-20, 0)), max_shift=0.2)
        self.assertAlmostEqual(wide.placement.dx, 20, delta=1)

    def test_wider_scale_range_recovers_a_bigger_drawing(self):
        big = combo((0, 0), 1.18)  # 그림 전체가 1.18배 커진 합친 그림
        narrow = align.find_alignment(empty_object(), big)
        self.assertTrue(narrow.at_limit)  # 기본 0.95~1.05 로는 한도에 걸린다
        wide = align.find_alignment(empty_object(), big, scale_range=(0.75, 1.25))
        self.assertAlmostEqual(wide.placement.scale, 1 / 1.18, delta=0.03)
        self.assertLess(abs(wide.placement.scale - 1 / 1.18), abs(narrow.placement.scale - 1 / 1.18))
        self.assertGreater(wide.score, 0.8)
        self.assertFalse(wide.at_limit)

    def test_scale_range_must_contain_one(self):
        for bad in ((1.01, 1.2), (0.8, 0.99), (0, 1.2)):
            with self.assertRaises(align.AlignError, msg=str(bad)):
                align.find_alignment(empty_object(), combo(), scale_range=bad)

    def test_size_mismatch_and_empty_template_are_errors(self):
        with self.assertRaises(align.AlignError):
            align.find_alignment(empty_object(), combo(size=120))
        with self.assertRaises(align.AlignError):
            align.find_alignment(Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), combo())

    def test_apply_whole_pixel_shift_is_exact(self):
        img = empty_object()
        moved = align.apply_placement(img, align.Placement(3, -2, 1.0))
        self.assertEqual(moved.getpixel((53, 68)), img.getpixel((50, 70)))
        self.assertEqual(moved.size, img.size)
        self.assertEqual(align.apply_placement(img, align.Placement()).tobytes(), img.tobytes())

    def test_scale_pivots_on_the_plate_center_and_keeps_edges_clean(self):
        img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        ImageDraw.Draw(img).rectangle((60, 60, 100, 100), fill=(200, 0, 0, 255))
        moved = align.apply_placement(img, align.Placement(0, 0, 1.1))
        box = moved.getchannel("A").point(lambda a: 255 if a > 128 else 0).getbbox()
        self.assertLessEqual(abs(box[0] - 58), 1)  # 가운데(80) 에서 왼쪽 끝(60)까지 20 → 22
        # 가장자리 반투명 점이 검게 번지지 않는다 (알파를 곱한 채로 옮김)
        r, g, b, a = moved.getpixel((box[0], 80))
        if a > 0:
            self.assertGreater(r, 150)

    def test_clipped_fraction(self):
        img = empty_object()
        self.assertEqual(align.clipped_fraction(img, img), 0.0)
        pushed = align.apply_placement(img, align.Placement(60, 0, 1.0))  # 오른쪽 가장자리로 밀려 일부가 잘린다
        self.assertGreater(align.clipped_fraction(img, pushed), 0.1)
        # 배율만 바뀐 것은 잘린 게 아니다 (넓이가 scale² 로 변할 뿐)
        for scale in (0.95, 1.05):
            small = align.apply_placement(img, align.Placement(1.5, -1.5, scale))
            self.assertLess(align.clipped_fraction(img, small, scale), 0.01, scale)


@unittest.skipIf(Image is None, "Pillow 가 없다 — scripts/cat-art/.venv 에서 돌리세요")
class PlateCase(test_fit.FitCase):
    """판 크기 그림(anchor none) 시험 공통 — 빈 물건 'empty' 원본을 미리 둔다."""

    def plate_item(self, iid, **kw):
        kw.setdefault("canvas", f"{SIZE}x{SIZE}")
        kw.setdefault("size", f"{SIZE}x{SIZE}")
        return self.fitem(iid, anchor="none", **kw)

    def setUp(self):
        super().setUp()
        self.put("art/raw/empty.png", png(empty_object()))

    def items(self, **combo_kw):
        return [self.plate_item("empty"), self.plate_item("combo", align_to="empty", **combo_kw)]


@unittest.skipIf(Image is None, "Pillow 가 없다 — scripts/cat-art/.venv 에서 돌리세요")
class AlignInFit(PlateCase):
    """표 → fit.py 한 바퀴."""

    def test_combo_lands_on_the_empty_objects_spot(self):
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        code = self.run_fit(self.items(), ["--group", "test"])
        self.assertEqual(code, 0, self.cap.text)
        out = self.final("src/assets/combo.png")
        ref = empty_object()
        for point in ((63, 115), (80, 45), (52, 118)):  # 말뚝 · 지붕 꼭대기 · 몸통 모서리 — 고양이에 안 가린 곳
            self.assertEqual(out.getpixel(point)[:3], ref.getpixel(point)[:3], point)
        self.assertIn("에 맞춤", self.cap.out.getvalue())
        self.assertIn("이동 (+5.0, -4.0)", self.cap.out.getvalue())

    def test_empty_object_itself_is_not_moved(self):
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        self.run_fit(self.items(), ["--group", "test"])
        self.assertEqual(self.final("src/assets/empty.png").tobytes(), empty_object().tobytes())

    def test_low_score_warns_and_leaves_the_picture_unmoved(self):
        other = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        ImageDraw.Draw(other).rectangle((5, 5, 45, 40), fill=(20, 160, 20, 255))
        self.put("art/raw/combo.png", png(other))
        code = self.run_fit(self.items(), ["--group", "test"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertIn("옮기지 않았다", self.cap.out.getvalue())
        self.assertEqual(self.final("src/assets/combo.png").tobytes(), other.tobytes())

    def test_min_score_option_can_be_raised(self):
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        self.run_fit(self.items(), ["--group", "test", "--align-min-score", "0.99"])
        self.assertIn("옮기지 않았다", self.cap.out.getvalue())
        self.assertEqual(self.final("src/assets/combo.png").tobytes(), combo((-5, 4)).tobytes())

    def test_at_limit_needs_a_higher_score(self):
        # 한도(8px) 밖으로 밀린 그림 — 가장자리에 걸린 어중간한 점수는 가짜 일치로 보고 옮기지 않는다
        self.put("art/raw/combo.png", png(combo((-30, 0))))
        self.run_fit(self.items(), ["--group", "test"])
        self.assertIn("옮기지 않았다", self.cap.out.getvalue())
        self.run_fit(self.items(), ["--group", "test", "--align-range", "0.25"])
        self.assertIn("이동 (+30.0", self.cap.out.getvalue())

    def test_nudge_replaces_the_search(self):
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        items = [self.plate_item("empty"), self.plate_item("combo", align_to="empty", nudge=[3, -2, 1.0])]
        self.assertEqual(self.run_fit(items, ["--group", "test"]), 0, self.cap.text)
        got = self.final("src/assets/combo.png")
        want = align.apply_placement(combo((-5, 4)), align.Placement(3, -2, 1.0))
        self.assertEqual(got.tobytes(), want.tobytes())
        self.assertIn("nudge 로 정한", self.cap.out.getvalue())
        self.assertNotIn("점수", self.cap.out.getvalue())

    def test_nudge_works_without_an_empty_object(self):
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        items = [self.plate_item("combo", nudge=[5, -4, 1.0])]
        self.assertEqual(self.run_fit(items, ["--group", "test"]), 0, self.cap.text)
        self.assertEqual(self.final("src/assets/combo.png").getpixel((63, 115))[:3], BLUE[:3])

    def test_move_like_uses_the_same_move(self):
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        second = combo((-5, 4))
        ImageDraw.Draw(second).ellipse((60, 20, 80, 30), fill=(0, 200, 0, 255))  # 둘째 프레임 — 다른 모양
        self.put("art/raw/combo2.png", png(second))
        items = self.items() + [self.plate_item("combo2", move_like="combo")]
        self.assertEqual(self.run_fit(items, ["--group", "test"]), 0, self.cap.text)
        first, follow = self.final("src/assets/combo.png"), self.final("src/assets/combo2.png")
        self.assertEqual(follow.getpixel((63, 115))[:3], BLUE[:3])
        self.assertEqual(follow.getpixel((75, 21))[:3], (0, 200, 0))  # 초록 타원 가운데 (70, 25) 도 (+5, -4) 옮겨졌다
        self.assertEqual(first.getpixel((63, 115)), follow.getpixel((63, 115)))
        self.assertIn("와 같은 이동", self.cap.out.getvalue())

    def test_move_like_follows_a_refusal_too(self):
        other = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        ImageDraw.Draw(other).rectangle((5, 5, 45, 40), fill=(20, 160, 20, 255))
        self.put("art/raw/combo.png", png(other))
        self.put("art/raw/combo2.png", png(other))
        items = self.items() + [self.plate_item("combo2", move_like="combo")]
        self.assertEqual(self.run_fit(items, ["--group", "test"]), 0, self.cap.text)
        self.assertEqual(self.final("src/assets/combo2.png").tobytes(), other.tobytes())
        self.assertIn("같이 옮기지 않았다", self.cap.out.getvalue())

    def test_move_like_target_unreadable_fails_only_that_item(self):
        self.put("art/raw/combo2.png", png(combo((-5, 4))))  # combo.png 없음
        items = self.items() + [self.plate_item("combo2", move_like="combo")]
        code = self.run_fit(items, ["--group", "test"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("같은 이동을 쓸 'combo' 의 이동을 못 구했다", self.cap.out.getvalue())
        self.assertTrue((self.root / "src/assets/empty.png").exists())

    def test_missing_empty_object_fails_the_combo_and_no_align_skips_it(self):
        (self.root / "art/raw/empty.png").unlink()
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        code = self.run_fit(self.items(), ["--only", "combo"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("기준 'empty' 의 원본이 아직 없다", self.cap.out.getvalue())
        self.assertFalse((self.root / "src/assets/combo.png").exists())
        self.assertEqual(self.run_fit(self.items(), ["--only", "combo", "--no-align"]), 0, self.cap.text)
        self.assertEqual(self.final("src/assets/combo.png").tobytes(), combo((-5, 4)).tobytes())

    def test_dry_run_reports_the_move_but_writes_nothing(self):
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        code = self.run_fit(self.items(), ["--only", "combo", "--dry-run"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertIn("이동 (+5.0, -4.0)", self.cap.out.getvalue())
        self.assertFalse((self.root / "src/assets/combo.png").exists())

    def test_move_that_clips_the_plate_warns(self):
        # 물건이 왼쪽으로 밀린 합친 그림 — 오른쪽 가장자리에 붙은 고양이 꼬리가 맞추려고 오른쪽으로 옮기면 판 밖으로 잘린다
        shifted = combo((-6, 0))
        ImageDraw.Draw(shifted).rectangle((150, 30, 159, 60), fill=CAT)
        self.put("art/raw/combo.png", png(shifted))
        code = self.run_fit(self.items(), ["--group", "test"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertIn("이동 (+6.0", self.cap.out.getvalue())
        self.assertIn("판 밖으로", self.cap.out.getvalue())

    def test_per_item_scale_and_range_win_over_the_defaults(self):
        self.put("art/raw/combo.png", png(combo((-14, 0), 1.18)))
        self.run_fit(self.items(), ["--group", "test"])
        self.assertIn("한도에 닿았다", self.cap.out.getvalue())  # 기본 한도로는 가장자리에 걸린다
        items = self.items(align_scale=[0.75, 1.25], align_range=0.2)
        self.assertEqual(self.run_fit(items, ["--group", "test"]), 0, self.cap.text)
        self.assertNotIn("한도에 닿았다", self.cap.out.getvalue())
        self.assertNotIn("옮기지 않았다", self.cap.out.getvalue())
        out = self.final("src/assets/combo.png")
        for point in ((63, 115), (80, 45)):
            for got, want in zip(out.getpixel(point)[:3], empty_object().getpixel(point)[:3]):
                self.assertAlmostEqual(got, want, delta=6, msg=str(point))
        # 인자 --align-range 가 더 좁아도 항목 키가 앞선다
        self.assertEqual(self.run_fit(items, ["--group", "test", "--align-range", "0.01"]), 0, self.cap.text)
        self.assertNotIn("한도에 닿았다", self.cap.out.getvalue())

    def test_align_to_another_combo_uses_its_settled_picture(self):
        # combo(첫 프레임) 는 빈 물건에 맞춰지고, second 는 combo 의 맞춘 뒤 모습에 맞춰진다 (같은 고양이, 앞발 · 공만 다름)
        self.put("art/raw/combo.png", png(combo((-5, 4), 1.1)))
        second = combo((-5, 4), 1.1)
        ImageDraw.Draw(second).ellipse((20, 20, 40, 30), fill=(0, 200, 0, 255))
        second = align.apply_placement(second, align.Placement(3, -2, 1.0))  # 둘째 프레임이 첫째와 조금 어긋남
        self.put("art/raw/second.png", png(second))
        items = self.items(align_scale=[0.75, 1.25], align_range=0.15) + [
            self.plate_item("second", align_to="combo", align_scale=[0.75, 1.25], align_range=0.15)
        ]
        self.assertEqual(self.run_fit(items, ["--group", "test"]), 0, self.cap.text)
        first, follow = self.final("src/assets/combo.png"), self.final("src/assets/second.png")
        # 둘째 프레임의 물건(파란 말뚝) 도 첫째와 같은 자리에 온다
        for point in ((63, 115), (80, 45)):
            for a, b in zip(first.getpixel(point)[:3], follow.getpixel(point)[:3]):
                self.assertAlmostEqual(a, b, delta=8, msg=str(point))
        self.assertIn("'combo' 에 맞춤", self.cap.out.getvalue())

    def test_chain_follows_a_refusal_of_the_reference(self):
        other = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        ImageDraw.Draw(other).rectangle((5, 5, 45, 40), fill=(20, 160, 20, 255))
        self.put("art/raw/combo.png", png(other))
        self.put("art/raw/second.png", png(other))
        items = self.items() + [self.plate_item("second", align_to="combo")]
        self.assertEqual(self.run_fit(items, ["--group", "test"]), 0, self.cap.text)
        self.assertIn("기준 'combo' 가 옮기지 않아", self.cap.out.getvalue())
        self.assertEqual(self.final("src/assets/second.png").tobytes(), other.tobytes())

    def test_chain_reference_unreadable_fails_only_that_item(self):
        self.put("art/raw/second.png", png(combo((-5, 4))))  # combo.png 없음
        items = self.items() + [self.plate_item("second", align_to="combo")]
        code = self.run_fit(items, ["--group", "test"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("맞출 기준 'combo' 의 이동을 못 구했다", self.cap.out.getvalue())

    def test_keys_need_anchor_none(self):
        self.put("art/raw/empty.png", png(empty_object()))
        for key, value in (("align_to", "empty"), ("nudge", [1, 1, 1.0]), ("crop_group", "g")):
            with self.subTest(key=key):
                items = [self.plate_item("empty"), self.fitem("combo", **{key: value})]  # anchor feet
                self.assertEqual(self.run_fit(items, ["--group", "test"]), fit.EXIT_USAGE)
                self.assertIn("anchor 가 none", self.cap.err.getvalue())

    def test_align_target_must_be_the_same_plate(self):
        items = [self.plate_item("empty", canvas="80x80", size="1024x1024"), self.plate_item("combo", align_to="empty")]
        self.assertEqual(self.run_fit(items, ["--group", "test"]), fit.EXIT_USAGE)
        self.assertIn("판 크기가 다르다", self.cap.err.getvalue())

    def test_align_range_option_is_validated(self):
        for bad in ("0", "0.9", "-1"):
            self.assertEqual(self.run_fit(self.items(), ["--group", "test", "--align-range", bad]), fit.EXIT_USAGE, bad)


@unittest.skipIf(Image is None, "Pillow 가 없다 — scripts/cat-art/.venv 에서 돌리세요")
class TableKeys(support.TempRoot):
    def errors_of(self, items):
        from artlib import TableError, load_table

        with self.assertRaises(TableError) as ctx:
            load_table(self.write_table(items), self.root)
        return "\n".join(ctx.exception.errors)

    def ok(self, items):
        from artlib import load_table

        return load_table(self.write_table(items), self.root)

    def test_valid_keys_are_read(self):
        t = self.ok([
            self.item("empty"),
            self.item("a", align_to="empty", nudge=[1, -2, 1.01], crop_group="bowl"),
            self.item("b", move_like="a"),
        ])
        a = t.by_id()["a"]
        self.assertEqual((a.align_to, a.nudge, a.crop_group), ("empty", (1.0, -2.0, 1.01), "bowl"))
        self.assertEqual(t.by_id()["b"].move_like, "a")
        self.assertEqual(t.warnings, [])  # 알 수 없는 키 경고가 없다

    def test_bad_references(self):
        self.assertIn("표에 없는", self.errors_of([self.item("a", align_to="zzz")]))
        self.assertIn("자기 자신", self.errors_of([self.item("a", align_to="a")]))
        self.assertIn("표에 없는", self.errors_of([self.item("a", move_like="zzz")]))
        self.assertIn("자기 자신", self.errors_of([self.item("a", move_like="a")]))
        self.assertIn("align_to 나 nudge 가 없다", self.errors_of([self.item("a"), self.item("b", move_like="a")]))
        self.assertIn("같이 쓸 수 없다", self.errors_of([self.item("e"), self.item("a", align_to="e"), self.item("b", move_like="a", nudge=[0, 0, 1])]))
        # move_like 를 이어 붙이면 가운데 항목에 align_to · nudge 가 없으니 걸린다
        self.assertIn("align_to 나 nudge 가 없다", self.errors_of([
            self.item("e"), self.item("a", align_to="e"), self.item("b", move_like="a"), self.item("c", move_like="b"),
        ]))

    def test_align_scale_and_range(self):
        t = self.ok([self.item("e"), self.item("a", align_to="e", align_scale=[0.8, 1.2], align_range=0.15)])
        a = t.by_id()["a"]
        self.assertEqual((a.align_scale, a.align_range), ((0.8, 1.2), 0.15))
        self.assertEqual(t.warnings, [])
        for bad in ([1.1, 1.2], [0.8, 0.9], [0.8], "0.8,1.2", [0.8, "x"], [0.1, 1.2], [0.8, 9], [True, 1.2], [0.8, float("nan")]):
            with self.subTest(scale=bad):
                self.assertIn("align_scale", self.errors_of([self.item("e"), self.item("a", align_to="e", align_scale=bad)]))
        for bad in (0, -0.1, 0.5, "x", True):
            with self.subTest(range=bad):
                self.assertIn("align_range", self.errors_of([self.item("e"), self.item("a", align_to="e", align_range=bad)]))
        self.assertIn("align_to 가 있는 항목에서만", self.errors_of([self.item("a", align_scale=[0.9, 1.1])]))
        self.assertIn("align_to 가 있는 항목에서만", self.errors_of([self.item("a", align_range=0.1)]))

    def test_align_to_chain_is_allowed_but_not_a_cycle(self):
        self.ok([self.item("e"), self.item("a", align_to="e"), self.item("b", align_to="a")])
        self.assertIn("돌고 돈다", self.errors_of([self.item("a", align_to="b"), self.item("b", align_to="a")]))

    def test_bad_nudge_values(self):
        for bad in ([1, 2], [1, 2, 3, 4], "1,2,1", [1, 2, "x"], [1, 2, 9], [1, 2, 0], [1e9, 0, 1], [1, 2, True], [float("nan"), 0, 1]):
            with self.subTest(nudge=bad):
                self.assertIn("nudge", self.errors_of([self.item("a", nudge=bad)]))

    def test_bad_crop_group_name(self):
        self.assertIn("crop_group", self.errors_of([self.item("a", crop_group="a b")]))
        self.assertIn("crop_group", self.errors_of([self.item("a", crop_group=3)]))


@unittest.skipIf(Image is None, "Pillow 가 없다 — scripts/cat-art/.venv 에서 돌리세요")
class Overlay(PlateCase):
    def setUp(self):
        super().setUp()
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        self.put("art/raw/combo2.png", png(combo((-5, 4))))
        self.overlay_items = self.items() + [self.plate_item("combo2", move_like="combo")]

    def files(self, directory="art/raw/v2/overlay"):
        d = self.root / directory
        return sorted(p.name for p in d.iterdir()) if d.is_dir() else []

    def test_writes_four_pictures_per_object_and_never_touches_assets(self):
        code = self.run_fit(self.overlay_items, ["--group", "test", "--overlay"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertEqual(self.files(), ["empty-grid-after.png", "empty-grid-before.png", "empty-stack-after.png", "empty-stack-before.png"])
        self.assertEqual(list((self.root / "src/assets").iterdir()), [])
        with Image.open(self.root / "art/raw/v2/overlay/empty-stack-after.png") as im:
            self.assertEqual(im.size, (SIZE, SIZE))

    def test_after_is_sharper_than_before(self):
        self.run_fit(self.overlay_items, ["--group", "test", "--overlay"])
        d = self.root / "art/raw/v2/overlay"
        point = (67, 100)  # 빈 물건의 파란 말뚝 오른쪽 끝 (어긋난 그림에서는 몸통색)
        with Image.open(d / "empty-stack-before.png") as b, Image.open(d / "empty-stack-after.png") as a:
            self.assertNotEqual(b.convert("RGB").getpixel(point)[:3], BLUE[:3])  # 어긋난 채로는 말뚝이 그 자리에 없다
            for got, want in zip(a.convert("RGB").getpixel(point), BLUE[:3]):
                self.assertAlmostEqual(got, want, delta=2)  # 세 장 평균이라 반올림 오차 정도는 있다

    def test_grid_has_one_cell_per_combo(self):
        self.run_fit(self.overlay_items, ["--group", "test", "--overlay"])
        with Image.open(self.root / "art/raw/v2/overlay/empty-grid-after.png") as im:
            self.assertEqual(im.width, 2 * SIZE)  # 칸 2개 (칸 폭 = 판 폭 160 — 상한 384 보다 작아 키우지 않는다)

    def test_custom_dir_and_dry_run(self):
        code = self.run_fit(self.overlay_items, ["--group", "test", "--overlay", "--overlay-dir", "art/tmp-ov"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertEqual(len(self.files("art/tmp-ov")), 4)
        code = self.run_fit(self.overlay_items, ["--group", "test", "--overlay", "--overlay-dir", "art/dry", "--dry-run"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertEqual(self.files("art/dry"), [])
        self.assertIn("만들 것", self.cap.out.getvalue())

    def test_dir_must_stay_inside_art(self):
        for bad in ("src/assets", "../out", "art/../src"):
            with self.subTest(dir=bad):
                self.assertEqual(self.run_fit(self.overlay_items, ["--group", "test", "--overlay", "--overlay-dir", bad]), fit.EXIT_USAGE)

    def test_missing_combo_is_skipped_not_failed(self):
        (self.root / "art/raw/combo2.png").unlink()
        code = self.run_fit(self.overlay_items, ["--group", "test", "--overlay"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertIn("건너뜀", self.cap.out.getvalue())
        self.assertEqual(len(self.files()), 4)

    def test_missing_empty_object_fails_that_object(self):
        (self.root / "art/raw/empty.png").unlink()
        code = self.run_fit(self.overlay_items, ["--group", "test", "--overlay"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertEqual(self.files(), [])

    def test_chained_combos_are_grouped_under_the_empty_object(self):
        self.put("art/raw/second.png", png(combo((-5, 4))))
        items = self.items(align_scale=[0.9, 1.1]) + [self.plate_item("second", align_to="combo")]
        code = self.run_fit(items, ["--group", "test", "--overlay"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertEqual(self.files(), ["empty-grid-after.png", "empty-grid-before.png", "empty-stack-after.png", "empty-stack-before.png"])
        with Image.open(self.root / "art/raw/v2/overlay/empty-grid-after.png") as im:
            self.assertEqual(im.width, 2 * SIZE)  # combo · second 두 칸 (둘 다 빈 물건 empty 의 겹쳐 보기에)

    def test_nothing_to_overlay(self):
        self.assertEqual(self.run_fit([self.plate_item("empty")], ["--group", "test", "--overlay"]), 0)
        self.assertIn("겹쳐 볼 항목이 없다", self.cap.out.getvalue())

    def test_rejected_item_is_marked_in_the_grid_and_listed_in_before(self):
        other = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        ImageDraw.Draw(other).rectangle((5, 5, 45, 40), fill=(20, 160, 20, 255))
        self.put("art/raw/combo.png", png(other))
        code = self.run_fit(self.overlay_items, ["--group", "test", "--overlay"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertEqual(len(self.files()), 4)


@unittest.skipIf(Image is None, "Pillow 가 없다 — scripts/cat-art/.venv 에서 돌리세요")
class CropGroup(PlateCase):
    def setUp(self):
        super().setUp()
        self.put("art/raw/combo.png", png(combo((-5, 4))))
        self.put("art/raw/combo2.png", png(combo((-3, 2))))
        self.crop_items = [
            self.plate_item("empty", crop_group="obj"),
            self.plate_item("combo", align_to="empty", crop_group="obj"),
            self.plate_item("combo2", align_to="empty", crop_group="obj"),
        ]

    def info(self):
        return json.loads((self.root / "src/assets/crop-boxes.json").read_text(encoding="utf-8"))

    def test_all_members_are_cut_to_the_same_box_and_the_box_is_recorded(self):
        code = self.run_fit(self.crop_items, ["--group", "test"])
        self.assertEqual(code, 0, self.cap.text)
        sizes = {self.final(f"src/assets/{n}.png").size for n in ("empty", "combo", "combo2")}
        self.assertEqual(len(sizes), 1)
        info = self.info()["groups"]["obj"]
        (w, h) = sizes.pop()
        self.assertEqual(info["size"], [w, h])
        self.assertEqual(info["canvas"], [SIZE, SIZE])
        self.assertEqual(sorted(info["files"]), ["combo.png", "combo2.png", "empty.png"])
        ox, oy = info["origin"]
        # 앱이 쓰는 법: 자른 그림을 (ox, oy) 에 놓으면 빈 물건은 원래 판 좌표와 같다
        full = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        full.paste(self.final("src/assets/empty.png"), (ox, oy))
        self.assertEqual(full.tobytes(), empty_object().tobytes())
        # 상자는 빈 물건과 맞춘 합친 그림들의 내용 합집합이다 (여백 CROP_PAD 만큼 더해서) — 판보다 작다
        self.assertLess(w * h, SIZE * SIZE)

    def test_the_box_loses_no_content(self):
        self.run_fit(self.crop_items, ["--group", "test", "--no-crop"])
        whole = {n: self.final(f"src/assets/{n}.png") for n in ("empty", "combo", "combo2")}
        self.run_fit(self.crop_items, ["--group", "test"])
        ox, oy = self.info()["groups"]["obj"]["origin"]
        for name, image in whole.items():
            cut = self.final(f"src/assets/{name}.png")
            self.assertEqual(image.crop((ox, oy, ox + cut.width, oy + cut.height)).tobytes(), cut.tobytes(), name)
            self.assertEqual(image.getchannel("A").getbbox() is not None, True)
            # 상자 밖은 모두 투명하다
            outside = image.copy()
            outside.paste((0, 0, 0, 0), (ox, oy, ox + cut.width, oy + cut.height))
            self.assertIsNone(outside.getchannel("A").point(lambda v: 255 if v > fit.DEFAULT_ALPHA_THRESHOLD else 0).getbbox(), name)

    def test_partial_selection_is_refused(self):
        code = self.run_fit(self.crop_items, ["--only", "combo"])
        self.assertEqual(code, fit.EXIT_USAGE)
        self.assertIn("같이 골라야", self.cap.err.getvalue())
        self.assertFalse((self.root / "src/assets/combo.png").exists())

    def test_no_crop_keeps_the_whole_plate_and_writes_no_info(self):
        code = self.run_fit(self.crop_items, ["--only", "combo", "--no-crop"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertEqual(self.final("src/assets/combo.png").size, (SIZE, SIZE))
        self.assertFalse((self.root / "src/assets/crop-boxes.json").exists())

    def test_missing_member_fails_the_group(self):
        (self.root / "art/raw/combo2.png").unlink()
        code = self.run_fit(self.crop_items, ["--group", "test"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("상자를 정할 수 없다", self.cap.out.getvalue())
        self.assertFalse((self.root / "src/assets/crop-boxes.json").exists())

    def test_other_groups_in_the_info_file_are_kept(self):
        (self.root / "src/assets/crop-boxes.json").write_text(
            json.dumps({"version": 1, "groups": {"older": {"canvas": [8, 8], "origin": [1, 1], "size": [2, 2], "files": ["x.png"]}}}),
            encoding="utf-8",
        )
        self.run_fit(self.crop_items, ["--group", "test"])
        self.assertEqual(sorted(self.info()["groups"]), ["obj", "older"])

    def test_corrupt_info_file_is_replaced_with_a_warning(self):
        (self.root / "src/assets/crop-boxes.json").write_text("{not json", encoding="utf-8")
        code = self.run_fit(self.crop_items, ["--group", "test"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertIn("새로 쓴다", self.cap.err.getvalue())
        self.assertEqual(list(self.info()["groups"]), ["obj"])

    def test_dry_run_writes_no_info(self):
        code = self.run_fit(self.crop_items, ["--group", "test", "--dry-run"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertIn("묶음 상자", self.cap.out.getvalue())
        self.assertFalse((self.root / "src/assets/crop-boxes.json").exists())

    def test_custom_info_path(self):
        code = self.run_fit(self.crop_items, ["--group", "test", "--crop-info", "src/assets/sub/boxes.json"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertTrue((self.root / "src/assets/sub/boxes.json").exists())

    def test_different_canvas_in_a_group_is_refused(self):
        items = self.crop_items
        items[2] = self.plate_item("combo2", crop_group="obj", canvas="80x80", size="80x80")
        self.put("art/raw/combo2.png", png(combo(size=80)))
        code = self.run_fit(items, ["--group", "test"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("canvas 가 서로 다르다", self.cap.out.getvalue())


@unittest.skipIf(Image is None, "Pillow 가 없다 — scripts/cat-art/.venv 에서 돌리세요")
class FrameGroupNames(test_fit.FitCase):
    """가족 · 프레임 판단 대상: 'cats' · '-cats' 로 끝나는 group · --frame-group."""

    def chain(self, group):
        return [
            self.item("sheet", group="sheets", refs=["style-cat"], then_ref_as="cat-a"),
            self.fitem("first", group=group, refs=["cat-a"], then_ref_as="cat-a-first"),
            self.fitem("second", group=group, refs=["cat-a-first"]),
            self.fitem("third", group=group, refs=["cat-a"]),
        ]

    def setUp(self):
        super().setUp()
        self.put("art/raw/first.png", test_fit.blob_png((200, 200), (0, 75, 200, 125)))     # 200x50 → 혼자면 23px
        self.put("art/raw/second.png", test_fit.blob_png((200, 200), (80, 10, 120, 190)))   # 40x180 → 혼자면 90px
        self.put("art/raw/third.png", test_fit.blob_png((200, 200), (60, 10, 140, 190)))    # 80x180 → 혼자면 90px

    def heights(self):
        out = {}
        for n in ("first", "second", "third"):
            box = self.final(f"src/assets/{n}.png").getchannel("A").getbbox()
            out[n] = box[3] - box[1]
        return out

    def run_chain(self, group, *extra):
        return self.run_fit(self.chain(group), ["--only", "first", "second", "third", "--same-scale", *extra])

    def test_is_frame_group(self):
        self.assertTrue(fit.is_frame_group("cats"))
        self.assertTrue(fit.is_frame_group("v2-cats"))
        self.assertFalse(fit.is_frame_group("scats"))  # '-cats' 라야 한다
        self.assertFalse(fit.is_frame_group("objects"))
        self.assertFalse(fit.is_frame_group("v2-combos"))
        self.assertTrue(fit.is_frame_group("sheet-poses", {"sheet-poses"}))

    def test_v2_cats_is_grouped_like_cats(self):
        table = fit.artlib.load_table(self.write_table(self.chain("v2-cats")), self.root)
        keys = {i.id: fit.family_key(i, table) for i in table.items}
        self.assertEqual((keys["first"], keys["second"], keys["third"]), ("sheet", "sheet", "sheet"))
        self.assertIs(fit.first_frame_of(table.by_id()["second"], table), table.by_id()["first"])
        self.assertEqual(self.run_chain("v2-cats"), 0, self.cap.text)
        h = self.heights()
        self.assertEqual((h["first"], h["second"]), (23, 23))  # 첫 프레임에 맞춤
        self.assertLess(h["third"], 90)  # 가족 배율

    def test_names_that_only_end_in_cats_without_a_dash_are_not_grouped(self):
        self.assertEqual(self.run_chain("scats"), 0, self.cap.text)
        self.assertEqual(tuple(self.heights().values()), (23, 90, 90))

    def test_frame_group_option_adds_a_group(self):
        self.assertEqual(self.run_chain("poses"), 0, self.cap.text)
        self.assertEqual(tuple(self.heights().values()), (23, 90, 90))
        self.assertEqual(self.run_chain("poses", "--frame-group", "poses"), 0, self.cap.text)
        h = self.heights()
        self.assertEqual((h["first"], h["second"]), (23, 23))

    def test_unknown_frame_group_is_a_usage_error(self):
        self.assertEqual(self.run_chain("v2-cats", "--frame-group", "nope"), fit.EXIT_USAGE)
        self.assertIn("표에 없는 그룹", self.cap.err.getvalue())

    def test_combos_and_objects_stay_individual_even_with_same_scale(self):
        self.assertEqual(self.run_chain("v2-combos"), 0, self.cap.text)
        self.assertEqual(tuple(self.heights().values()), (23, 90, 90))


if __name__ == "__main__":
    unittest.main()
