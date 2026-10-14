"""fit.py 시험 — 작은 합성 PNG 로. Pillow 가 없으면 건너뛴다 (가상 환경에서는 돈다)."""

import io
import unittest
from unittest import mock

import support
from support import Capture

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

if Image is not None:
    import fit


def blob_png(size, box, color=(200, 100, 50, 255)) -> bytes:
    """투명 배경에 box 만 색을 칠한 PNG."""
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    img.paste(Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), color), (box[0], box[1]))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def opaque_png(size, color=(10, 200, 10, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, color).save(buf, "PNG")
    return buf.getvalue()


@unittest.skipIf(Image is None, "Pillow 가 없다 — scripts/cat-art/.venv 에서 돌리세요")
class FitCase(support.TempRoot):
    def put(self, rel, data):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def run_fit(self, items, argv, **top):
        table = self.write_table(items, **top)
        cap = Capture()
        code = fit.main(["--table", str(table), *argv], root=self.root, stdout=cap.out, stderr=cap.err)
        self.cap = cap
        return code

    def final(self, rel):
        with Image.open(self.root / rel) as im:
            return im.convert("RGBA")

    @staticmethod
    def fitem(iid, anchor="feet", canvas="100x100", **kw):
        kw.setdefault("final", f"src/assets/{iid}.png")
        return support.TempRoot.item(iid, anchor=anchor, canvas=canvas, **kw)


class TestGroupFit(FitCase):
    """가족 · 프레임 규칙의 대상 group 을 시험 항목의 기본 group('test') 으로 바꿔 둔다."""

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(fit, "FRAME_GROUP", "test")
        patcher.start()
        self.addCleanup(patcher.stop)


class Geometry(FitCase):
    def test_crops_transparent_margin_and_feet_sit_at_bottom_center(self):
        # 200x200 원본, 내용은 (50,20)-(110,180) = 60x160
        self.put("art/raw/cat.png", blob_png((200, 200), (50, 20, 110, 180)))
        code = self.run_fit([self.fitem("cat")], ["--group", "test"])
        self.assertEqual(code, 0, self.cap.text)
        img = self.final("src/assets/cat.png")
        self.assertEqual(img.size, (100, 100))
        box = img.getchannel("A").getbbox()
        # 높이 기준: avail_h = 100 - 4 - 6 = 90 → 내용 높이 90, 폭 ~34
        self.assertEqual(box[3], 100 - 6)  # 아래 여백 6 (feet)
        self.assertEqual(box[3] - box[1], 90)
        self.assertLessEqual(abs((box[0] + box[2]) / 2 - 50), 1)  # 가운데

    def test_feet_bottom_margin_is_the_same_for_different_poses(self):
        self.put("art/raw/tall.png", blob_png((200, 200), (80, 10, 120, 190)))
        self.put("art/raw/wide.png", blob_png((200, 200), (10, 120, 190, 190)))
        self.run_fit([self.fitem("tall"), self.fitem("wide", out="art/raw/wide.png")], ["--group", "test"])
        bottoms = {self.final(f"src/assets/{n}.png").getchannel("A").getbbox()[3] for n in ("tall", "wide")}
        self.assertEqual(bottoms, {94})

    def test_center_anchor_centers_vertically(self):
        self.put("art/raw/ball.png", blob_png((200, 200), (10, 10, 50, 50)))
        self.run_fit([self.fitem("ball", anchor="center")], ["--group", "test"])
        box = self.final("src/assets/ball.png").getchannel("A").getbbox()
        self.assertLessEqual(abs((box[0] + box[2]) - 100), 1)
        self.assertLessEqual(abs((box[1] + box[3]) - 100), 1)
        self.assertEqual(box[3] - box[1], 92)  # 4% 여백 사방

    def test_none_anchor_only_resizes(self):
        self.put("art/raw/bg.png", opaque_png((300, 200)))
        code = self.run_fit([self.fitem("bg", anchor="none", canvas="150x100")], ["--group", "test"])
        self.assertEqual(code, 0, self.cap.text)
        img = self.final("src/assets/bg.png")
        self.assertEqual(img.size, (150, 100))
        self.assertEqual(img.getchannel("A").getextrema(), (255, 255))  # 여백 · 투명이 생기지 않는다

    def test_none_anchor_with_different_aspect_warns(self):
        self.put("art/raw/bg.png", opaque_png((300, 300)))
        self.run_fit([self.fitem("bg", anchor="none", canvas="150x100")], ["--group", "test"])
        self.assertIn("비율이 달라", self.cap.out.getvalue())
        self.assertEqual(self.final("src/assets/bg.png").size, (150, 100))

    def test_fully_transparent_source_fails_that_item_only(self):
        self.put("art/raw/empty.png", blob_png((50, 50), (0, 0, 0, 0)))
        self.put("art/raw/ok.png", blob_png((50, 50), (10, 10, 40, 40)))
        code = self.run_fit([self.fitem("empty"), self.fitem("ok")], ["--group", "test"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertFalse((self.root / "src/assets/empty.png").exists())
        self.assertTrue((self.root / "src/assets/ok.png").exists())

    def test_faint_specks_are_ignored_by_threshold(self):
        img = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
        img.paste(Image.new("RGBA", (40, 40), (200, 100, 50, 255)), (80, 80))
        img.putpixel((2, 2), (255, 255, 255, 5))  # 거의 안 보이는 먼지
        buf = io.BytesIO()
        img.save(buf, "PNG")
        self.put("art/raw/dust.png", buf.getvalue())
        self.run_fit([self.fitem("dust", anchor="center")], ["--group", "test"])
        box = self.final("src/assets/dust.png").getchannel("A").getbbox()
        self.assertEqual(box[3] - box[1], 92)

    def test_opaque_source_for_feet_is_flagged(self):
        self.put("art/raw/solid.png", opaque_png((100, 100)))
        self.run_fit([self.fitem("solid")], ["--group", "test"])
        self.assertIn("투명한 부분이 없다", self.cap.out.getvalue())

    def test_missing_or_corrupt_source(self):
        self.put("art/raw/bad.png", b"not a png")
        code = self.run_fit([self.fitem("gone"), self.fitem("bad")], ["--group", "test"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("원본이 아직 없다", self.cap.out.getvalue())
        self.assertIn("못 읽는다", self.cap.out.getvalue())

    def test_overwrites_existing_final_and_leaves_no_temp(self):
        self.put("art/raw/cat.png", blob_png((200, 200), (50, 20, 110, 180)))
        self.put("src/assets/cat.png", b"old")
        self.run_fit([self.fitem("cat")], ["--group", "test"])
        self.assertEqual(self.final("src/assets/cat.png").size, (100, 100))
        self.assertEqual([p.name for p in (self.root / "src/assets").iterdir()], ["cat.png"])

    def test_output_is_rgba_png(self):
        self.put("art/raw/cat.png", blob_png((200, 200), (50, 20, 110, 180)))
        self.run_fit([self.fitem("cat")], ["--group", "test"])
        with Image.open(self.root / "src/assets/cat.png") as im:
            self.assertEqual((im.format, im.mode), ("PNG", "RGBA"))


class DryRunAndSelection(FitCase):
    def test_dry_run_writes_nothing(self):
        self.put("art/raw/cat.png", blob_png((200, 200), (50, 20, 110, 180)))
        code = self.run_fit([self.fitem("cat")], ["--group", "test", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertFalse((self.root / "src/assets/cat.png").exists())
        self.assertIn("미리보기", self.cap.out.getvalue())

    def test_items_without_final_are_ignored(self):
        self.put("art/raw/sheet.png", blob_png((200, 200), (50, 20, 110, 180)))
        code = self.run_fit([self.item("sheet")], ["--group", "test"])
        self.assertEqual(code, 0)
        self.assertIn("맞출 항목이 없다", self.cap.out.getvalue())

    def test_only_on_item_without_final_is_an_error(self):
        self.assertEqual(self.run_fit([self.item("sheet")], ["--only", "sheet"]), fit.EXIT_USAGE)

    def test_final_requires_anchor_and_canvas(self):
        for drop in ("anchor", "canvas"):
            with self.subTest(drop=drop):
                it = self.fitem("cat")
                del it[drop]
                self.assertEqual(self.run_fit([it], ["--group", "test"]), fit.EXIT_USAGE)

    def test_final_outside_assets_is_rejected(self):
        it = self.fitem("cat", final="src/evil.png")
        self.assertEqual(self.run_fit([it], ["--group", "test"]), fit.EXIT_USAGE)
        it = self.fitem("cat", final="src/assets/../../evil.png")
        self.assertEqual(self.run_fit([it], ["--group", "test"]), fit.EXIT_USAGE)
        self.assertFalse((self.root / "evil.png").exists())


class SameScale(TestGroupFit):
    def items(self, canvas="100x100"):
        return [
            self.item("sheet", refs=["style-cat"], then_ref_as="cat-a"),
            self.fitem("sit", canvas=canvas, refs=["cat-a"]),
            self.fitem("loaf", canvas=canvas, refs=["cat-a"]),
            self.fitem("other", canvas=canvas),
        ]

    def setUp(self):
        super().setUp()
        self.put("art/raw/sit.png", blob_png((200, 200), (60, 10, 140, 190)))   # 80x180 (키 큼)
        self.put("art/raw/loaf.png", blob_png((200, 200), (30, 100, 170, 190)))  # 140x90 (납작)
        self.put("art/raw/other.png", blob_png((200, 200), (60, 10, 140, 190)))

    def heights(self):
        return {n: self.final(f"src/assets/{n}.png").getchannel("A").getbbox() for n in ("sit", "loaf", "other")}

    def test_without_option_each_pose_fills_the_canvas(self):
        self.run_fit(self.items(), ["--group", "test"])
        b = self.heights()
        self.assertEqual(b["sit"][3] - b["sit"][1], 90)
        self.assertGreater(b["loaf"][3] - b["loaf"][1], 50)  # 납작한 자세가 크게 늘어난다

    def test_same_scale_keeps_proportions_between_poses(self):
        code = self.run_fit(self.items(), ["--group", "test", "--same-scale"])
        self.assertEqual(code, 0, self.cap.text)
        b = self.heights()
        sit_h = b["sit"][3] - b["sit"][1]
        loaf_h = b["loaf"][3] - b["loaf"][1]
        # 원본 비율 180:90 → 같은 배율이면 90 : 45
        self.assertEqual(sit_h, 90)
        self.assertLessEqual(abs(loaf_h - 45), 1)
        # 배율이 같으면 폭도 원본 비율 (80 : 140)
        self.assertLessEqual(abs((b["loaf"][2] - b["loaf"][0]) - 70), 1)
        # 아래 여백은 그대로 같다
        self.assertEqual(b["sit"][3], b["loaf"][3])
        # 같은 고양이가 아닌 항목은 혼자 맞춘다
        self.assertEqual(b["other"][3] - b["other"][1], 90)

    def test_scale_is_the_same_even_when_only_one_pose_is_refit(self):
        self.run_fit(self.items(), ["--group", "test", "--same-scale"])
        full = (self.root / "src/assets/loaf.png").read_bytes()
        (self.root / "src/assets/loaf.png").unlink()
        self.run_fit(self.items(), ["--only", "loaf", "--same-scale"])
        self.assertEqual((self.root / "src/assets/loaf.png").read_bytes(), full)

    def test_different_canvas_within_family_is_refused(self):
        items = self.items()
        items[2] = self.fitem("loaf", canvas="200x200", refs=["cat-a"])
        code = self.run_fit(items, ["--group", "test", "--same-scale"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("canvas 가 서로 다르다", self.cap.out.getvalue())

    def test_big_spread_warns(self):
        self.put("art/raw/loaf.png", blob_png((200, 200), (95, 150, 105, 190)))  # 아주 작게 그려진 자세
        self.run_fit(self.items(), ["--group", "test", "--same-scale"])
        self.assertIn("크기 차이가 크다", self.cap.err.getvalue())


class FrameChain(TestGroupFit):
    """다음 프레임이 첫 프레임을 refs[0] 으로 쓰는 사슬: 프레임 -> 첫 프레임 -> 설정 그림."""

    def items(self):
        return [
            self.item("sheet", refs=["style-cat"], then_ref_as="cat-a"),
            self.fitem("sit", refs=["cat-a"], then_ref_as="cat-a-sit"),
            self.fitem("sit-blink", refs=["cat-a-sit"]),  # 설정 그림을 직접 참조하지 않는다
            self.fitem("sit-blink2", refs=["cat-a-sit", "cat-a"]),
            self.item("sheet-b", refs=["style-cat"], then_ref_as="cat-b"),
            self.fitem("loaf-b", refs=["cat-b"]),
        ]

    def test_family_key_follows_the_chain_to_the_sheet(self):
        table = fit.artlib.load_table(self.write_table(self.items()), self.root)
        keys = {i.id: fit.family_key(i, table) for i in table.items}
        self.assertEqual(keys["sit"], "sheet")
        self.assertEqual(keys["sit-blink"], "sheet")
        self.assertEqual(keys["sit-blink2"], "sheet")
        self.assertEqual(keys["loaf-b"], "sheet-b")
        self.assertIsNone(keys["sheet"])

    def put_frames(self, blink_box=(60, 100, 140, 190)):
        self.put("art/raw/sit.png", blob_png((200, 200), (60, 10, 140, 190)))        # 80x180
        self.put("art/raw/sit-blink.png", blob_png((200, 200), blink_box))
        self.put("art/raw/sit-blink2.png", blob_png((200, 200), (60, 10, 140, 190)))

    def content_h(self, name):
        box = self.final(f"src/assets/{name}.png").getchannel("A").getbbox()
        return box[3] - box[1], box

    def test_family_scale_without_match_frames(self):
        self.put_frames()  # blink 은 80x90 — 가족 최소 배율 0.5 → 45px
        code = self.run_fit(self.items(), ["--only", "sit-blink", "--same-scale", "--no-match-frames"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertLessEqual(abs(self.content_h("sit-blink")[0] - 45), 1)

    def test_next_frame_matches_first_frame_content_height(self):
        # 모델이 둘째 프레임을 더 크게 그린 경우: 원본 상자 80x180 vs 100x200 (11% 차이)
        self.put_frames(blink_box=(50, 0, 150, 200))
        code = self.run_fit(self.items(), ["--only", "sit-blink", "--same-scale"])
        self.assertEqual(code, 0, self.cap.text)
        # sit 은 선택하지 않았으니 쓰지 않지만, 첫 프레임 값은 같게 계산한다
        self.assertFalse((self.root / "src/assets/sit.png").exists())
        blink_h, blink_box = self.content_h("sit-blink")
        self.assertEqual(blink_h, 90)  # 첫 프레임 몸이 canvas 에 맞는 높이
        self.assertIn("높이 맞춤", self.cap.out.getvalue())
        self.assertEqual(blink_box[3], 94)  # feet 기준점은 그대로

    def test_matching_equals_first_frame_when_both_fitted_together(self):
        self.put_frames(blink_box=(50, 0, 150, 200))
        self.run_fit(self.items(), ["--group", "test", "--same-scale"])
        first_h, _ = self.content_h("sit")
        blink_h, _ = self.content_h("sit-blink")
        self.assertLessEqual(abs(first_h - blink_h), 1)

    def test_next_frame_does_not_shrink_the_family(self):
        # 둘째 프레임이 아주 크게 그려져도 첫 프레임(과 같은 가족의 다른 자세) 배율은 그대로
        self.put_frames(blink_box=(0, 0, 200, 200))
        self.run_fit(self.items(), ["--only", "sit", "--same-scale"])
        self.assertEqual(self.content_h("sit")[0], 90)

    def test_big_height_difference_warns(self):
        self.put_frames(blink_box=(60, 100, 140, 190))  # 90 vs 180 → 50% 차이
        self.run_fit(self.items(), ["--only", "sit-blink", "--same-scale"])
        self.assertIn("직접 볼 것", self.cap.out.getvalue())

    def test_small_height_difference_does_not_warn(self):
        self.put_frames(blink_box=(60, 15, 140, 195))  # 같은 높이
        self.run_fit(self.items(), ["--only", "sit-blink", "--same-scale"])
        self.assertNotIn("직접 볼 것", self.cap.out.getvalue())

    def test_first_frame_source_missing_is_a_clear_error(self):
        self.put("art/raw/sit-blink.png", blob_png((200, 200), (60, 10, 140, 190)))
        code = self.run_fit(self.items(), ["--only", "sit-blink", "--same-scale"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("첫 프레임 'sit'", self.cap.out.getvalue())

    def test_wide_frame_is_capped_at_canvas(self):
        # 첫 프레임에 높이를 맞추면 가로가 canvas 를 넘는 둘째 프레임은 한도까지만
        self.put("art/raw/sit.png", blob_png((200, 200), (90, 10, 110, 190)))   # 20x180 → 배율 0.5
        self.put("art/raw/sit-blink.png", blob_png((200, 200), (0, 90, 200, 190)))  # 200x100
        code = self.run_fit(self.items(), ["--only", "sit-blink"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertIn("canvas 를 넘어", self.cap.out.getvalue())
        box = self.final("src/assets/sit-blink.png").getchannel("A").getbbox()
        self.assertLessEqual(box[2] - box[0], 100)


class SizeLike(TestGroupFit):
    """다른 고양이의 같은 자세와 맞춘 내용 높이를 같게."""

    def items(self, order=("a", "b")):
        table = {
            # a: 가로로 긴 그림 → 가로에 맞춰 높이 46
            "a": self.fitem("a", group="g"),
            # b: 세로로 긴 그림 → 혼자 맞추면 높이 90 이지만 a 와 같게 46
            "b": self.fitem("b", size_like="a"),
        }
        return [table[k] for k in order]

    def setUp(self):
        super().setUp()
        self.put("art/raw/a.png", blob_png((200, 200), (0, 50, 200, 150)))   # 200x100
        self.put("art/raw/b.png", blob_png((200, 200), (60, 10, 140, 190)))  # 80x180

    def h(self, name):
        box = self.final(f"src/assets/{name}.png").getchannel("A").getbbox()
        return box[3] - box[1], box

    def test_height_equals_the_target_even_if_target_is_not_selected(self):
        self.assertEqual(self.run_fit(self.items(), ["--only", "b"]), 0, self.cap.text)
        self.assertFalse((self.root / "src/assets/a.png").exists())
        hb, box = self.h("b")
        self.assertLessEqual(abs(hb - 46), 1)
        self.assertEqual(box[3], 94)  # feet 기준점 그대로
        self.assertIn("크기 기준", self.cap.out.getvalue())

    def test_same_result_regardless_of_selection_and_table_order(self):
        self.run_fit(self.items(), ["--only", "a", "b"])
        both = (self.root / "src/assets/b.png").read_bytes()
        (self.root / "src/assets/b.png").unlink()
        self.run_fit(self.items(order=("b", "a")), ["--only", "b"])
        self.assertEqual((self.root / "src/assets/b.png").read_bytes(), both)
        self.assertEqual(self.h("a")[0], 46)

    def test_without_size_like_it_fills_the_canvas(self):
        items = self.items()
        del items[1]["size_like"]
        self.run_fit(items, ["--only", "b"])
        self.assertEqual(self.h("b")[0], 90)

    def test_wide_target_height_is_capped_by_canvas_width(self):
        # a 는 아주 키가 큼(높이 90), b 는 가로로 길어 그 높이로는 canvas 를 넘는다
        self.put("art/raw/a.png", blob_png((200, 200), (90, 10, 110, 190)))
        self.put("art/raw/b.png", blob_png((200, 200), (0, 90, 200, 190)))
        code = self.run_fit(self.items(), ["--only", "b"])
        self.assertEqual(code, 0, self.cap.text)
        self.assertIn("canvas 를 넘어", self.cap.out.getvalue())
        box = self.final("src/assets/b.png").getchannel("A").getbbox()
        self.assertLessEqual(box[2] - box[0], 92)

    def test_size_like_wins_over_match_frames(self):
        self.put("art/raw/first.png", blob_png((200, 200), (60, 10, 140, 190)))
        items = [
            self.item("sheet", refs=["style-cat"], then_ref_as="cat-m"),
            self.fitem("a", group="g"),
            self.fitem("first", refs=["cat-m"], then_ref_as="cat-m-first"),
            self.fitem("b", refs=["cat-m-first"], size_like="a"),
        ]
        self.run_fit(items, ["--only", "b", "--same-scale"])
        self.assertLessEqual(abs(self.h("b")[0] - 46), 1)  # 첫 프레임(90) 이 아니라 a(46) 를 따른다

    def test_size_like_item_does_not_shrink_the_family(self):
        # b 는 아주 크게 그려졌지만 size_like 라서 가족 배율(c 의 90px)에 끼지 않는다
        self.put("art/raw/c.png", blob_png((200, 200), (60, 10, 140, 190)))
        items = [
            self.item("sheet", refs=["style-cat"], then_ref_as="cat-m"),
            self.fitem("a", group="g"),
            self.fitem("b", refs=["cat-m"], size_like="a"),
            self.fitem("c", refs=["cat-m"]),
        ]
        self.put("art/raw/b.png", blob_png((200, 200), (0, 0, 200, 200)))
        self.run_fit(items, ["--only", "c", "--same-scale"])
        self.assertEqual(self.h("c")[0], 90)

    def test_target_with_other_canvas_is_refused(self):
        items = [self.fitem("a", canvas="200x200"), self.fitem("b", size_like="a")]
        code = self.run_fit(items, ["--only", "b"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("canvas 가 달라", self.cap.out.getvalue())

    def test_missing_target_source_is_a_clear_error(self):
        (self.root / "art/raw/a.png").unlink()
        code = self.run_fit(self.items(), ["--only", "b"])
        self.assertEqual(code, fit.EXIT_FAILED)
        self.assertIn("크기 기준 'a'", self.cap.out.getvalue())

    def test_anchor_none_cannot_use_size_like(self):
        items = [self.fitem("a"), self.fitem("b", anchor="none", size_like="a")]
        self.assertEqual(self.run_fit(items, ["--only", "b"]), fit.EXIT_USAGE)
        items = [self.fitem("a", anchor="none"), self.fitem("b", size_like="a")]
        self.assertEqual(self.run_fit(items, ["--only", "b"]), fit.EXIT_USAGE)

    def test_chained_size_like(self):
        self.put("art/raw/c.png", blob_png((200, 200), (10, 10, 190, 190)))
        items = self.items() + [self.fitem("c", size_like="b")]
        self.run_fit(items, ["--only", "c"])
        self.assertLessEqual(abs(self.h("c")[0] - 46), 1)


class GroupRule(FitCase):
    """가족(--same-scale) · 프레임(--match-frames) 은 group 'cats' 항목끼리만. 물건 · 배경은 개별로."""

    def chain(self, group):
        return [
            self.item("sheet", group="sheets", refs=["style-cat"], then_ref_as="cat-a"),
            self.fitem("first", group=group, refs=["cat-a"], then_ref_as="cat-a-first"),
            self.fitem("second", group=group, refs=["cat-a-first"]),
            self.fitem("third", group=group, refs=["cat-a"]),
        ]

    def put_all(self):
        self.put("art/raw/first.png", blob_png((200, 200), (0, 75, 200, 125)))     # 200x50 (납작) → 혼자면 23px
        self.put("art/raw/second.png", blob_png((200, 200), (80, 10, 120, 190)))   # 40x180 (키 큼) → 혼자면 90px
        self.put("art/raw/third.png", blob_png((200, 200), (60, 10, 140, 190)))    # 80x180 → 혼자면 90px

    def heights(self):
        out = {}
        for n in ("first", "second", "third"):
            box = self.final(f"src/assets/{n}.png").getchannel("A").getbbox()
            out[n] = box[3] - box[1]
        return out

    def test_cats_group_is_grouped_by_default(self):
        self.put_all()
        table = fit.artlib.load_table(self.write_table(self.chain("cats")), self.root)
        keys = {i.id: fit.family_key(i, table) for i in table.items}
        self.assertEqual((keys["first"], keys["second"], keys["third"]), ("sheet", "sheet", "sheet"))
        self.assertIs(fit.first_frame_of(table.by_id()["second"], table), table.by_id()["first"])
        self.assertEqual(self.run_fit(self.chain("cats"), ["--only", "first", "second", "third", "--same-scale"]), 0)
        h = self.heights()
        self.assertEqual(h["first"], 23)
        self.assertEqual(h["second"], 23)  # 첫 프레임과 높이 맞춤 (혼자 맞추면 90)
        self.assertLess(h["third"], 90)  # 같은 가족 배율(첫 프레임에 끌려 작아짐)

    def test_objects_group_is_never_grouped_or_frame_matched(self):
        self.put_all()
        table = fit.artlib.load_table(self.write_table(self.chain("objects")), self.root)
        for i in table.items:
            self.assertIsNone(fit.family_key(i, table), i.id)
            self.assertIsNone(fit.first_frame_of(i, table), i.id)
        code = self.run_fit(self.chain("objects"), ["--only", "first", "second", "third", "--same-scale"])
        self.assertEqual(code, 0, self.cap.text)
        h = self.heights()
        # 각자 canvas 에 맞춘다 (가족 배율 · 프레임 맞춤 없음)
        self.assertEqual((h["first"], h["second"], h["third"]), (23, 90, 90))
        self.assertNotIn("높이 맞춤", self.cap.out.getvalue())

    def test_same_run_all_groups_with_same_scale(self):
        # 한 번의 --all --same-scale 로 고양이는 묶고 물건 · 배경은 개별로
        self.put_all()
        self.put("art/raw/obj.png", blob_png((200, 200), (10, 10, 190, 60)))
        self.put("art/raw/bg.png", opaque_png((300, 200)))
        items = self.chain("cats") + [
            self.fitem("obj", group="objects", refs=["cat-a-first"]),  # 고양이 프레임을 참조하는 물건도 묶이지 않는다
            self.fitem("bg", group="backgrounds", anchor="none", canvas="150x100"),
        ]
        code = self.run_fit(items, ["--all", "--same-scale"])
        self.assertEqual(code, 0, self.cap.text)
        obj = self.final("src/assets/obj.png").getchannel("A").getbbox()
        self.assertEqual(obj[2] - obj[0], 92)  # 폭에 맞춰 개별로
        self.assertEqual(self.final("src/assets/bg.png").size, (150, 100))

    def test_cat_does_not_follow_a_non_cat_producer(self):
        self.put_all()
        items = [
            self.item("sheet", group="sheets", refs=["style-cat"], then_ref_as="cat-a"),
            self.fitem("thing", group="objects", refs=["cat-a"], then_ref_as="thing-out"),
            self.fitem("second", group="cats", refs=["thing-out"]),
        ]
        table = fit.artlib.load_table(self.write_table(items), self.root)
        self.assertIsNone(fit.first_frame_of(table.by_id()["second"], table))


class Webp(FitCase):
    def setUp(self):
        super().setUp()
        self.put("art/raw/cat.png", blob_png((200, 200), (50, 20, 110, 180)))

    def webp_item(self, **kw):
        kw.setdefault("final", "src/assets/cat.webp")
        return self.fitem("cat", **kw)

    def test_webp_final_is_written_as_webp_with_alpha(self):
        code = self.run_fit([self.webp_item()], ["--group", "test"])
        self.assertEqual(code, 0, self.cap.text)
        path = self.root / "src/assets/cat.webp"
        self.assertEqual(path.read_bytes()[:4], b"RIFF")
        with Image.open(path) as im:
            self.assertEqual((im.format, im.size), ("WEBP", (100, 100)))
            rgba = im.convert("RGBA")
        self.assertEqual(rgba.getpixel((0, 0))[3], 0)  # 투명 여백 유지
        box = rgba.getchannel("A").getbbox()
        self.assertEqual(box[3], 94)  # feet 기준점 · 크기는 PNG 와 같다
        self.assertEqual(box[3] - box[1], 90)

    def test_same_geometry_as_png(self):
        self.put("art/raw/cat2.png", blob_png((200, 200), (50, 20, 110, 180)))
        self.run_fit([self.webp_item(), self.fitem("cat2")], ["--only", "cat", "cat2"])
        a = self.final("src/assets/cat.webp").getchannel("A").getbbox()
        b = self.final("src/assets/cat2.png").getchannel("A").getbbox()
        self.assertEqual(a, b)
        self.assertEqual((self.root / "src/assets/cat2.png").read_bytes()[:4], b"\x89PNG")

    def test_quality_option_changes_size_and_is_validated(self):
        noisy = Image.effect_noise((200, 200), 60).convert("RGBA")
        buf = io.BytesIO()
        noisy.save(buf, "PNG")
        self.put("art/raw/cat.png", buf.getvalue())
        self.run_fit([self.webp_item()], ["--group", "test", "--webp-quality", "30"])
        low = (self.root / "src/assets/cat.webp").stat().st_size
        self.run_fit([self.webp_item()], ["--group", "test", "--webp-quality", "95"])
        high = (self.root / "src/assets/cat.webp").stat().st_size
        self.assertLess(low, high)
        for bad in ("-1", "101"):
            self.assertEqual(self.run_fit([self.webp_item()], ["--group", "test", "--webp-quality", bad]), fit.EXIT_USAGE)

    def test_overwrite_leaves_no_temp_files(self):
        self.run_fit([self.webp_item()], ["--group", "test"])
        self.run_fit([self.webp_item()], ["--group", "test"])
        self.assertEqual([p.name for p in (self.root / "src/assets").iterdir()], ["cat.webp"])

    def test_table_accepts_png_and_webp_only(self):
        self.assertEqual(self.run_fit([self.webp_item(final="src/assets/cat.jpg")], ["--group", "test"]), fit.EXIT_USAGE)
        self.assertEqual(self.run_fit([self.webp_item(final="art/cat.webp")], ["--group", "test"]), fit.EXIT_USAGE)


class Pure(FitCase):
    def test_fit_scale_formula(self):
        opt = fit.Options()
        self.assertAlmostEqual(fit.fit_scale((50, 100), (100, 100), "feet", opt), 0.9)
        self.assertAlmostEqual(fit.fit_scale((100, 50), (100, 100), "center", opt), 0.92)

    def test_place_raises_instead_of_silently_overflowing(self):
        crop = Image.new("RGBA", (100, 100), (1, 1, 1, 255))
        with self.assertRaises(fit.FitError):
            fit.place(crop, (50, 50), "feet", 1.0, fit.Options())

    def test_bad_options(self):
        self.assertEqual(self.run_fit([self.fitem("cat")], ["--group", "test", "--margin", "0.7"]), fit.EXIT_USAGE)


if __name__ == "__main__":
    unittest.main()
