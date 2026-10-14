"""프롬프트 표 읽기 · 검사 시험 (네트워크 없음)."""

import json
import os
import unittest

import support
import artlib
from artlib import TableError


class TableValidation(support.TempRoot):
    def load(self, items, **top):
        return artlib.load_table(self.write_table(items, **top), self.root)

    def errors_of(self, items, **top) -> str:
        with self.assertRaises(TableError) as cm:
            self.load(items, **top)
        return "\n".join(cm.exception.errors)

    def test_valid_table(self):
        t = self.load([
            self.item("a", refs=["style-cat"], then_ref_as="cat-a", final="src/assets/cats/a.png",
                      canvas="512x512", anchor="feet"),
            self.item("b", refs=["cat-a"]),
        ])
        self.assertEqual([i.id for i in t.items], ["a", "b"])
        self.assertEqual(t.items[0].canvas, (512, 512))
        self.assertEqual(t.prompt_for(t.items[0]), "STYLE\n\nprompt a")
        self.assertEqual(t.warnings, [])

    def test_bad_json_names_the_position(self):
        path = self.root / "prompts.json"
        path.write_text('{"version": 1,\n "items": [}', encoding="utf-8")
        with self.assertRaises(TableError) as cm:
            artlib.load_table(path, self.root)
        self.assertIn("JSON 문법 오류", cm.exception.errors[0])
        self.assertIn("2줄", cm.exception.errors[0])

    def test_missing_file(self):
        with self.assertRaises(TableError):
            artlib.load_table(self.root / "nope.json", self.root)

    def test_missing_required_keys(self):
        for key in ("id", "group", "prompt", "size", "out"):
            it = self.item("a")
            del it[key]
            self.assertIn(f"'{key}'", self.errors_of([it]), key)

    def test_wrong_version_and_empty_items(self):
        self.assertIn("version", self.errors_of([self.item("a")], version=2))
        self.assertIn("items", self.errors_of([]))

    def test_duplicate_id(self):
        err = self.errors_of([self.item("a"), self.item("a", out="art/raw/other.png")])
        self.assertIn("id 가", err)

    def test_duplicate_out_and_final(self):
        err = self.errors_of([self.item("a"), self.item("b", out="art/raw/a.png")])
        self.assertIn("같은 파일", err)
        err = self.errors_of([
            self.item("a", final="src/assets/x.png"), self.item("b", final="src/assets/x.png"),
        ])
        self.assertIn("final", err)

    def test_bad_out_paths(self):
        bad = [
            "art/../src/x.png", "../art/x.png", "/etc/x.png", "C:/x.png", "art\\raw\\x.png",
            "src/assets/x.png", "x.png", "art/raw/../../x.png", "art//x.png", "art/./x.png",
            "art", "art/raw/x.png ", "art/raw./x.png", "art/raw/x.txt", "art/raw/\x00.png",
        ]
        for path in bad:
            with self.subTest(path=path):
                self.errors_of([self.item("a", out=path)])

    def test_bad_final_paths(self):
        for path in ("art/raw/x.png", "src/assets/../x.png", "src/x.png", "src/assets/x.jpg", "/src/assets/x.png"):
            with self.subTest(path=path):
                self.errors_of([self.item("a", final=path)])

    def test_symlink_cannot_escape_art(self):
        outside = self.root / "outside"
        outside.mkdir()
        try:
            os.symlink(outside, self.root / "art" / "link", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("이 환경에서는 심볼릭 링크를 못 만든다")
        self.errors_of([self.item("a", out="art/link/x.png")])

    def test_references_must_stay_inside_repo(self):
        err = self.errors_of([self.item("a")], references={"r": "../secret.png"})
        self.assertIn("references['r']", err)

    def test_unknown_ref(self):
        err = self.errors_of([self.item("a", refs=["nope"])])
        self.assertIn("'nope'", err)

    def test_ref_to_later_item_is_rejected(self):
        err = self.errors_of([self.item("a", refs=["cat-b"]), self.item("b", then_ref_as="cat-b")])
        self.assertIn("앞에 있어야", err)

    def test_ref_to_own_output_is_rejected(self):
        self.errors_of([self.item("a", refs=["cat-a"], then_ref_as="cat-a")])

    def test_then_ref_as_collisions(self):
        self.assertIn("겹친다", self.errors_of([self.item("a", then_ref_as="style-cat")]))
        self.assertIn("겹친다", self.errors_of([
            self.item("a", then_ref_as="x"), self.item("b", then_ref_as="x"),
        ]))

    def test_bad_values(self):
        for kw in (
            {"size": "1000x1000"}, {"size": "big"}, {"size": "4096x16"}, {"background": "red"},
            {"anchor": "head"}, {"canvas": "512"}, {"canvas": "0x0"}, {"refs": "style-cat"},
            {"refs": ["style-cat", "style-cat"]}, {"group": "a b"},
        ):
            with self.subTest(kw=kw):
                self.errors_of([self.item("a", **kw)])

    def test_size_like_valid(self):
        t = self.load([
            self.item("a", final="src/assets/a.png", anchor="feet", canvas="100x100"),
            self.item("b", final="src/assets/b.png", anchor="feet", canvas="100x100", size_like="a"),
        ])
        self.assertEqual(t.items[1].size_like, "a")
        self.assertEqual(t.warnings, [])

    def test_size_like_errors(self):
        fin = dict(anchor="feet", canvas="100x100")
        a = self.item("a", final="src/assets/a.png", **fin)
        self.assertIn("자기 자신", self.errors_of([self.item("b", final="src/assets/b.png", size_like="b", **fin)]))
        self.assertIn("표에 없는", self.errors_of([a, self.item("b", final="src/assets/b.png", size_like="zzz", **fin)]))
        self.assertIn("final 이 없다", self.errors_of([self.item("a"), self.item("b", size_like="a")]))
        self.assertIn("문자열", self.errors_of([a, self.item("b", size_like=5)]))
        err = self.errors_of([
            self.item("a", final="src/assets/a.png", size_like="b", **fin),
            self.item("b", final="src/assets/b.png", size_like="a", **fin),
        ])
        self.assertIn("돌고 돈다", err)

    def test_size_auto_is_allowed(self):
        self.load([self.item("a", size="auto")])

    def test_unknown_keys_only_warn(self):
        t = self.load([self.item("a", mood="happy")], extra=1)
        self.assertEqual(len(t.warnings), 2)
        self.assertTrue(any("mood" in w for w in t.warnings))

    def test_all_errors_reported_together(self):
        err = self.errors_of([self.item("a", out="../x.png"), self.item("b", size="oops")])
        self.assertIn("items[0]", err)
        self.assertIn("items[1]", err)


class Selection(support.TempRoot):
    def setUp(self):
        super().setUp()
        self.table = artlib.load_table(self.write_table([
            self.item("a", group="g1"), self.item("b", group="g2"), self.item("c", group="g2"),
        ]), self.root)

    def ids(self, *a):
        return [i.id for i in artlib.select_items(self.table, *a)]

    def test_union_in_table_order(self):
        self.assertEqual(self.ids(["g2"], ["a"], False), ["a", "b", "c"])
        self.assertEqual(self.ids(["g1", "g2"], [], False), ["a", "b", "c"])
        self.assertEqual(self.ids([], ["c"], False), ["c"])
        self.assertEqual(self.ids([], [], True), ["a", "b", "c"])

    def test_unknown_group_or_id(self):
        with self.assertRaises(TableError):
            self.ids(["nope"], [], False)
        with self.assertRaises(TableError):
            self.ids([], ["nope"], False)

    def test_must_choose_something(self):
        with self.assertRaises(TableError) as cm:
            self.ids([], [], False)
        self.assertIn("--all", str(cm.exception))


class AtomicWrite(support.TempRoot):
    def test_writes_and_leaves_no_temp(self):
        target = self.root / "art" / "deep" / "x.png"
        artlib.atomic_write_bytes(target, b"abc")
        self.assertEqual(target.read_bytes(), b"abc")
        self.assertEqual([p.name for p in target.parent.iterdir()], ["x.png"])

    def test_failure_keeps_old_file_and_cleans_temp(self):
        target = self.root / "art" / "x.png"
        target.write_bytes(b"old")
        with self.assertRaises(TypeError):
            artlib.atomic_write_bytes(target, "not bytes")  # type: ignore[arg-type]
        self.assertEqual(target.read_bytes(), b"old")
        self.assertEqual([p.name for p in target.parent.iterdir()], ["x.png"])


if __name__ == "__main__":
    unittest.main()
