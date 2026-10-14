"""generate.py 시험 — 가짜 클라이언트만 쓴다. 네트워크 · 실제 키 없음."""

import json
import os
import subprocess
import sys
import unittest
from types import SimpleNamespace

import support
import generate
from support import FAKE_KEY, Capture, FakeApiError, FakeClient, b64, make_png


class GenerateCase(support.TempRoot):
    def run_main(self, argv, client=None, key=FAKE_KEY, items=None, sleeps=None, factory_must_not_run=False):
        table = self.write_table(items if items is not None else [self.item("a")])
        cap = Capture()
        env = {generate.ENV_KEY: key} if key is not None else {}
        created = []

        def factory(api_key):
            if factory_must_not_run:
                raise AssertionError("클라이언트를 만들면 안 된다")
            created.append(api_key)
            return client

        code = generate.main(
            ["--table", str(table), *argv], root=self.root, env=env, client_factory=factory,
            sleep=(sleeps.append if sleeps is not None else (lambda s: None)),
            now=lambda: "2026-10-14T00:00:00+00:00", stdout=cap.out, stderr=cap.err,
        )
        self.cap = cap
        return code

    def ledger(self):
        path = self.root / "art" / "raw" / "ledger.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def assertNoSecret(self):
        self.assertNotIn(FAKE_KEY, self.cap.text)
        self.assertNotIn("SECRETKEY", self.cap.text)
        for p in self.root.rglob("*"):
            if p.is_file() and p.suffix != ".png":
                self.assertNotIn(b"SECRETKEY", p.read_bytes(), p)


class DryRunAndLimits(GenerateCase):
    def test_dry_run_needs_no_key_and_calls_nothing(self):
        code = self.run_main(["--group", "test", "--dry-run"], key=None, factory_must_not_run=True)
        self.assertEqual(code, 0)
        self.assertIn("만들 것 1장", self.cap.out.getvalue())
        self.assertIn("예상 비용", self.cap.out.getvalue())
        self.assertFalse((self.root / "art" / "raw").exists())

    def test_no_key_stops_before_any_call(self):
        code = self.run_main(["--group", "test"], key=None, factory_must_not_run=True)
        self.assertEqual(code, generate.EXIT_NOT_READY)
        self.assertIn("OPENAI_API_KEY", self.cap.err.getvalue())
        self.assertFalse((self.root / "art" / "raw").exists())  # 장부 · 잠금도 만들지 않음

    def test_blank_key_counts_as_missing(self):
        self.assertEqual(self.run_main(["--group", "test"], key="   ", factory_must_not_run=True), generate.EXIT_NOT_READY)

    def test_nothing_selected_is_an_error(self):
        self.assertEqual(self.run_main([], factory_must_not_run=True), generate.EXIT_USAGE)

    def test_max_images_default_blocks_everything(self):
        items = [self.item(f"i{n}", out=f"art/raw/i{n}.png") for n in range(11)]
        client = FakeClient()
        code = self.run_main(["--group", "test"], client=client, items=items)
        self.assertEqual(code, generate.EXIT_USAGE)
        self.assertEqual(client.calls, [])
        self.assertIn("--max-images 10", self.cap.err.getvalue())

    def test_max_images_raised(self):
        items = [self.item(f"i{n}", out=f"art/raw/i{n}.png") for n in range(11)]
        client = FakeClient()
        self.assertEqual(self.run_main(["--group", "test", "--max-images", "11"], client=client, items=items), 0)
        self.assertEqual(len(client.calls), 11)

    def test_skipped_items_do_not_count_toward_max(self):
        items = [self.item(f"i{n}", out=f"art/raw/i{n}.png") for n in range(12)]
        for n in range(5):
            (self.root / "art" / "raw").mkdir(exist_ok=True)
            (self.root / "art" / "raw" / f"i{n}.png").write_bytes(make_png())
        client = FakeClient()
        self.assertEqual(self.run_main(["--group", "test"], client=client, items=items), 0)
        self.assertEqual(len(client.calls), 7)

    def test_budget_blocks_everything(self):
        items = [self.item(f"i{n}", out=f"art/raw/i{n}.png") for n in range(3)]  # 3 x 0.053
        client = FakeClient()
        code = self.run_main(["--group", "test", "--budget-usd", "0.10"], client=client, items=items)
        self.assertEqual(code, generate.EXIT_USAGE)
        self.assertEqual(client.calls, [])
        self.assertIn("--budget-usd", self.cap.err.getvalue())

    def test_budget_enough(self):
        client = FakeClient()
        self.assertEqual(self.run_main(["--group", "test", "--budget-usd", "0.06"], client=client), 0)
        self.assertEqual(len(client.calls), 1)

    def test_dry_run_still_reports_limit_violation(self):
        items = [self.item(f"i{n}", out=f"art/raw/i{n}.png") for n in range(11)]
        code = self.run_main(["--group", "test", "--dry-run"], key=None, items=items, factory_must_not_run=True)
        self.assertEqual(code, generate.EXIT_USAGE)
        self.assertIn("예상 비용", self.cap.out.getvalue())

    def test_unknown_model_price_needs_override(self):
        client = FakeClient()
        self.assertEqual(self.run_main(["--group", "test", "--model", "mystery-1"], client=client), generate.EXIT_USAGE)
        self.assertEqual(client.calls, [])
        self.assertEqual(self.run_main(["--group", "test", "--model", "mystery-1", "--price-per-image", "0.05"], client=client), 0)

    def test_bad_arguments(self):
        for argv in (["--max-images", "0"], ["--budget-usd", "0"], ["--price-per-image", "-1"], ["--model", "a b"]):
            with self.subTest(argv=argv):
                self.assertEqual(self.run_main(["--group", "test", *argv], factory_must_not_run=True), generate.EXIT_USAGE)


class PriceEstimate(unittest.TestCase):
    def test_known_prices(self):
        c = generate.estimate_cost("gpt-image-2", "medium", "1024x1024", 0, None)
        self.assertEqual((c.usd, c.estimated), (0.053, False))
        self.assertEqual(generate.estimate_cost("gpt-image-1-mini", "low", "1536x1024", 0, None).usd, 0.006)

    def test_2_5_is_estimated_from_gpt_image_2(self):
        c = generate.estimate_cost("gpt-image-2.5-sunburst", "medium", "1024x1024", 0, None)
        self.assertEqual((c.usd, c.estimated), (0.053, True))
        c = generate.estimate_cost("gpt-image-2.5-flare-2026-09-08", "high", "1024x1024", 0, None)
        self.assertEqual(c.usd, 0.211)

    def test_default_model_is_the_pinned_snapshot_and_is_priced(self):
        self.assertEqual(generate.DEFAULT_MODEL, "gpt-image-2.5-sunburst-2026-09-08")
        c = generate.estimate_cost(generate.DEFAULT_MODEL, "medium", "1024x1024", 0, None)
        self.assertEqual((c.usd, c.estimated), (0.053, True))
        c = generate.estimate_cost("gpt-image-2.5-sunburst", "medium", "1024x1024", 0, None)
        self.assertEqual(c.usd, 0.053)  # 별칭도 그대로 알아본다 (--model 로 바꿀 수 있음)

    def test_refs_and_odd_sizes_cost_more_and_are_estimates(self):
        c = generate.estimate_cost("gpt-image-2", "medium", "1024x1024", 2, None)
        self.assertEqual(c.usd, round(0.053 + 2 * generate.REF_INPUT_COST_USD, 4))
        self.assertTrue(c.estimated)
        self.assertGreater(generate.estimate_cost("gpt-image-2", "medium", "2048x1024", 0, None).usd, 0.053)

    def test_auto_is_priced_as_high(self):
        self.assertEqual(generate.estimate_cost("gpt-image-2", "auto", "1024x1024", 0, None).usd, 0.211)
        self.assertEqual(generate.estimate_cost("gpt-image-2", "medium", "auto", 0, None).usd, 0.053)

    def test_unknown_model_without_override(self):
        with self.assertRaises(generate.PricingError):
            generate.estimate_cost("mystery", "medium", "1024x1024", 0, None)


class SkipAndForce(GenerateCase):
    def test_existing_out_is_skipped_without_a_call(self):
        out = self.root / "art" / "raw" / "a.png"
        out.parent.mkdir(parents=True)
        out.write_bytes(make_png())
        client = FakeClient()
        code = self.run_main(["--group", "test"], client=client, factory_must_not_run=True)
        self.assertEqual(code, 0)
        self.assertEqual(client.calls, [])
        self.assertIn("건너뜀", self.cap.out.getvalue())

    def test_zero_byte_out_is_not_treated_as_done(self):
        out = self.root / "art" / "raw" / "a.png"
        out.parent.mkdir(parents=True)
        out.write_bytes(b"")
        client = FakeClient()
        self.assertEqual(self.run_main(["--group", "test"], client=client), 0)
        self.assertEqual(len(client.calls), 1)
        self.assertGreater(out.stat().st_size, 0)

    def test_force_regenerates(self):
        out = self.root / "art" / "raw" / "a.png"
        out.parent.mkdir(parents=True)
        out.write_bytes(b"old image")
        client = FakeClient(png=make_png(8, 8))
        self.assertEqual(self.run_main(["--group", "test", "--force"], client=client), 0)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(out.read_bytes(), make_png(8, 8))

    def test_second_run_makes_nothing(self):
        client = FakeClient()
        self.run_main(["--group", "test"], client=client)
        self.run_main(["--group", "test"], client=client, factory_must_not_run=True)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(len(self.ledger()), 1)  # 건너뜀은 장부에 남기지 않는다 (호출이 아님)

    def test_resume_after_partial_run_only_makes_the_rest(self):
        items = [self.item(f"i{n}", out=f"art/raw/i{n}.png") for n in range(3)]
        client = FakeClient([None, FakeApiError("bad request", status_code=400)])
        self.assertEqual(self.run_main(["--group", "test"], client=client, items=items), generate.EXIT_FAILED)
        self.assertEqual(len(client.calls), 3)
        client2 = FakeClient()
        self.assertEqual(self.run_main(["--group", "test"], client=client2, items=items), 0)
        self.assertEqual([c["prompt"].split("\n\n")[1] for c in client2.calls], ["prompt i1"])


class ForcePreservesPrevious(GenerateCase):
    STAMP = "20261014-000000"  # run_main 의 now() 고정값에서 나온다

    def setUp(self):
        super().setUp()
        self.raw = self.root / "art" / "raw"
        self.raw.mkdir(parents=True)
        self.out = self.raw / "a.png"
        self.out.write_bytes(b"old image")

    def prevs(self):
        return sorted(p.name for p in self.raw.glob("a.prev-*.png"))

    def test_force_moves_old_image_aside_and_writes_new(self):
        client = FakeClient(png=make_png(8, 8))
        self.assertEqual(self.run_main(["--group", "test", "--force"], client=client), 0)
        self.assertEqual(self.out.read_bytes(), make_png(8, 8))
        self.assertEqual(self.prevs(), [f"a.prev-{self.STAMP}.png"])
        self.assertEqual((self.raw / self.prevs()[0]).read_bytes(), b"old image")
        self.assertIn("기존 그림 보존", self.ledger()[0]["note"])

    def test_second_force_in_same_second_does_not_overwrite_previous_backup(self):
        self.run_main(["--group", "test", "--force"], client=FakeClient(png=make_png(8, 8)))
        self.run_main(["--group", "test", "--force"], client=FakeClient(png=make_png(6, 6)))
        names = self.prevs()
        self.assertEqual(len(names), 2)
        contents = sorted((self.raw / n).read_bytes() for n in names)
        self.assertEqual(contents, sorted([b"old image", make_png(8, 8)]))

    def test_no_force_no_backup(self):
        self.out.unlink()
        self.run_main(["--group", "test"], client=FakeClient())
        self.assertEqual(self.prevs(), [])

    def test_missing_out_with_force_makes_no_backup(self):
        self.out.unlink()
        self.run_main(["--group", "test", "--force"], client=FakeClient())
        self.assertEqual(self.prevs(), [])

    def test_failed_request_puts_the_old_image_back(self):
        client = FakeClient([FakeApiError("nope", status_code=400)])
        self.assertEqual(self.run_main(["--group", "test", "--force"], client=client), generate.EXIT_FAILED)
        self.assertEqual(self.out.read_bytes(), b"old image")
        self.assertEqual(self.prevs(), [])
        self.assertIn("제자리", self.ledger()[0]["note"])

    def test_bad_response_puts_the_old_image_back(self):
        client = FakeClient(["!!!not base64!!!"])
        self.run_main(["--group", "test", "--force"], client=client)
        self.assertEqual(self.out.read_bytes(), b"old image")
        self.assertEqual(self.prevs(), [])

    def test_ctrl_c_puts_the_old_image_back(self):
        client = FakeClient([KeyboardInterrupt()])
        self.assertEqual(self.run_main(["--group", "test", "--force"], client=client), generate.EXIT_INTERRUPTED)
        self.assertEqual(self.out.read_bytes(), b"old image")
        self.assertEqual(self.prevs(), [])

    def test_cannot_move_aside_means_no_generation(self):
        real = generate.os.replace

        def deny(src, dst):
            raise PermissionError("locked")

        generate.os.replace = deny
        try:
            client = FakeClient()
            code = self.run_main(["--group", "test", "--force"], client=client)
        finally:
            generate.os.replace = real
        self.assertEqual(code, generate.EXIT_FAILED)
        self.assertEqual(client.calls, [])  # 호출도 비용도 없다
        self.assertEqual(self.out.read_bytes(), b"old image")
        self.assertEqual(self.ledger()[0]["est_cost_usd"], 0)
        self.assertIn("보존하지 못해", self.ledger()[0]["error"])

    def test_forced_producer_failure_does_not_feed_dependents_the_old_image(self):
        sheet = self.raw / "sheet.png"
        sheet.write_bytes(b"old sheet")
        items = [
            self.item("sheet", refs=["style-cat"], then_ref_as="cat-a"),
            self.item("pose", refs=["cat-a"], out="art/raw/pose.png"),
        ]
        client = FakeClient([FakeApiError("nope", status_code=400)])
        self.run_main(["--only", "sheet", "pose", "--force"], client=client, items=items)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(sheet.read_bytes(), b"old sheet")


class CallShape(GenerateCase):
    def test_generate_call_params_and_prompt(self):
        client = FakeClient()
        self.run_main(["--group", "test", "--quality", "high", "--model", "gpt-image-2.5-flare"], client=client,
                      items=[self.item("a", size="1536x1024", background="opaque")])
        (call,) = client.calls
        self.assertEqual(call["kind"], "generate")
        self.assertEqual(call["model"], "gpt-image-2.5-flare")
        self.assertEqual(call["size"], "1536x1024")
        self.assertEqual(call["quality"], "high")
        self.assertEqual(call["background"], "opaque")
        self.assertEqual(call["output_format"], "png")
        self.assertEqual(call["prompt"], "STYLE\n\nprompt a")
        self.assertNotIn("image_names", call)
        self.assertNotIn("input_fidelity", call)  # gpt-image-2 계열은 생략해야 한다

    def test_edit_with_reference_images(self):
        client = FakeClient()
        self.run_main(["--group", "test"], client=client,
                      items=[self.item("a", refs=["style-cat", "style-scene"])])
        (call,) = client.calls
        self.assertEqual(call["kind"], "edit")
        self.assertEqual([n.rsplit("/", 1)[-1] for n in call["image_names"]], ["style-cat.png", "style-scene.png"])
        self.assertTrue(all(h.startswith(b"\x89PNG") for h in call["image_heads"]))
        self.assertEqual(call["image_types"], ["image/png", "image/png"])

    def test_webp_reference_is_sent_with_webp_type(self):
        # WebP 참조를 종류 없이 보내면 API 가 application/octet-stream 으로 거부한다 (2026-10-14 실제 400)
        from generate import _ref_mimetype
        self.assertEqual(_ref_mimetype("scripts/cat-art/refs/bg-hanok.webp"), "image/webp")
        self.assertEqual(_ref_mimetype("a/b.PNG"), "image/png")
        self.assertEqual(_ref_mimetype("a/b.jpeg"), "image/jpeg")

    def test_then_ref_as_uses_previous_result_in_same_run(self):
        client = FakeClient(png=make_png(6, 6))
        items = [
            self.item("sheet", refs=["style-cat"], then_ref_as="cat-a"),
            self.item("pose", refs=["cat-a"], out="art/raw/pose.png"),
        ]
        self.assertEqual(self.run_main(["--group", "test"], client=client, items=items), 0)
        self.assertEqual([c["kind"] for c in client.calls], ["edit", "edit"])
        self.assertTrue(client.calls[1]["image_names"][0].endswith("art/raw/sheet.png"))
        self.assertEqual(client.calls[1]["image_heads"][0][:4], b"\x89PNG")

    def test_then_ref_as_missing_and_not_in_plan_is_a_clear_error(self):
        items = [
            self.item("sheet", group="test", refs=["style-cat"], then_ref_as="cat-a"),
            self.item("pose", group="cats", refs=["cat-a"], out="art/raw/pose.png"),
        ]
        client = FakeClient()
        code = self.run_main(["--group", "cats"], client=client, items=items)
        self.assertEqual(code, generate.EXIT_USAGE)
        self.assertEqual(client.calls, [])
        self.assertIn("--only sheet", self.cap.err.getvalue())

    def test_then_ref_as_from_earlier_run_is_found_on_disk(self):
        items = [
            self.item("sheet", group="test", refs=["style-cat"], then_ref_as="cat-a"),
            self.item("pose", group="cats", refs=["cat-a"], out="art/raw/pose.png"),
        ]
        sheet = self.root / "art" / "raw" / "sheet.png"
        sheet.parent.mkdir(parents=True)
        sheet.write_bytes(make_png())
        client = FakeClient()
        self.assertEqual(self.run_main(["--group", "cats"], client=client, items=items), 0)
        self.assertEqual(len(client.calls), 1)

    def test_missing_reference_file_is_a_plan_error(self):
        (self.root / "refs" / "style-cat.png").unlink()
        client = FakeClient()
        code = self.run_main(["--group", "test"], client=client, items=[self.item("a", refs=["style-cat"])])
        self.assertEqual(code, generate.EXIT_USAGE)
        self.assertEqual(client.calls, [])
        self.assertIn("style-cat", self.cap.err.getvalue())

    def test_failed_producer_fails_dependents_without_a_call(self):
        items = [
            self.item("sheet", refs=["style-cat"], then_ref_as="cat-a"),
            self.item("pose", refs=["cat-a"], out="art/raw/pose.png"),
            self.item("other", out="art/raw/other.png"),
        ]
        client = FakeClient([FakeApiError("nope", status_code=400)])
        code = self.run_main(["--group", "test"], client=client, items=items)
        self.assertEqual(code, generate.EXIT_FAILED)
        self.assertEqual([c["kind"] for c in client.calls], ["edit", "generate"])  # pose 는 호출 없음
        self.assertEqual([r["status"] for r in self.ledger()], ["failed", "failed", "ok"])

    def test_force_producer_with_stale_output_does_not_feed_dependents(self):
        sheet = self.root / "art" / "raw" / "sheet.png"
        sheet.parent.mkdir(parents=True)
        sheet.write_bytes(make_png())
        items = [
            self.item("sheet", refs=["style-cat"], then_ref_as="cat-a"),
            self.item("pose", refs=["cat-a"], out="art/raw/pose.png"),
        ]
        client = FakeClient([FakeApiError("nope", status_code=400)])
        self.run_main(["--group", "test", "--force"], client=client, items=items)
        self.assertEqual(len(client.calls), 1)


class LedgerAndSummary(GenerateCase):
    def test_ledger_fields_and_summary(self):
        items = [self.item("a", refs=["style-cat"]), self.item("b", out="art/raw/b.png", size="1536x1024")]
        client = FakeClient([None, FakeApiError("bad request", status_code=400)])
        code = self.run_main(["--group", "test"], client=client, items=items)
        self.assertEqual(code, generate.EXIT_FAILED)
        ok, bad = self.ledger()
        self.assertEqual(ok["id"], "a")
        self.assertEqual(ok["status"], "ok")
        self.assertEqual(ok["model"], generate.DEFAULT_MODEL)
        self.assertEqual((ok["size"], ok["quality"], ok["call"], ok["refs"]), ("1024x1024", "medium", "edit", 1))
        self.assertEqual(ok["ts"], "2026-10-14T00:00:00+00:00")
        self.assertGreater(ok["est_cost_usd"], 0)
        self.assertEqual(bad["status"], "failed")
        self.assertEqual(bad["est_cost_usd"], 0)
        self.assertIn("400", bad["error"])
        self.assertIn("만듦 1장, 건너뜀 0장, 실패 1장", self.cap.out.getvalue())
        self.assertIn("b", self.cap.out.getvalue().split("실패:")[1])

    def test_ledger_never_holds_response_body_or_key(self):
        client = FakeClient()
        self.run_main(["--group", "test"], client=client)
        text = (self.root / "art" / "raw" / "ledger.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("b64", text)
        self.assertNotIn("SECRETKEY", text)
        self.assertEqual(set(self.ledger()[0]), {
            "ts", "id", "group", "model", "size", "quality", "background", "call", "refs", "status", "est_cost_usd", "out",
        })


class Failures(GenerateCase):
    def test_rate_limit_retries_then_succeeds(self):
        sleeps = []
        client = FakeClient([FakeApiError("slow down", 429), FakeApiError("slow down", 429)])
        self.assertEqual(self.run_main(["--group", "test"], client=client, sleeps=sleeps), 0)
        self.assertEqual(len(client.calls), 3)
        self.assertEqual(sleeps, list(generate.RETRY_DELAYS_S))
        self.assertEqual([r["status"] for r in self.ledger()], ["ok"])

    def test_retries_run_out_then_only_that_item_fails_and_the_run_continues(self):
        items = [self.item("a"), self.item("b", out="art/raw/b.png")]
        client = FakeClient([FakeApiError("x", 500)] * 3)
        code = self.run_main(["--group", "test"], client=client, items=items)
        self.assertEqual(code, generate.EXIT_FAILED)
        self.assertEqual(len(client.calls), 4)  # a 3번 + b 1번
        self.assertEqual([r["status"] for r in self.ledger()], ["failed", "ok"])
        self.assertFalse((self.root / "art" / "raw" / "a.png").exists())

    def test_non_retryable_error_is_not_retried(self):
        client = FakeClient([FakeApiError("content policy", 400)])
        self.run_main(["--group", "test"], client=client)
        self.assertEqual(len(client.calls), 1)

    def test_connection_error_is_retried(self):
        client = FakeClient([ConnectionError("reset")])
        self.assertEqual(self.run_main(["--group", "test"], client=client), 0)
        self.assertEqual(len(client.calls), 2)

    def test_auth_error_stops_the_whole_run(self):
        items = [self.item("a"), self.item("b", out="art/raw/b.png")]
        client = FakeClient([FakeApiError("Incorrect API key provided: " + FAKE_KEY, 401)])
        code = self.run_main(["--group", "test"], client=client, items=items)
        self.assertEqual(code, generate.EXIT_FAILED)
        self.assertEqual(len(client.calls), 1)
        self.assertIn("중단", self.cap.out.getvalue())
        self.assertNoSecret()

    def test_quota_error_stops_the_whole_run(self):
        items = [self.item("a"), self.item("b", out="art/raw/b.png")]
        client = FakeClient([FakeApiError("quota", 429, code="insufficient_quota")])
        self.run_main(["--group", "test"], client=client, items=items)
        self.assertEqual(len(client.calls), 1)

    def test_key_in_error_messages_is_scrubbed_everywhere(self):
        client = FakeClient([FakeApiError(f"bad key {FAKE_KEY} and sk-proj-abcd****wxyz", 400)])
        self.run_main(["--group", "test"], client=client)
        self.assertNoSecret()
        self.assertNotIn("sk-proj", self.cap.text)
        self.assertIn("[key]", self.ledger()[0]["error"])

    def test_scrub_function(self):
        self.assertEqual(generate.scrub("a sk-abcdef1234 b", None), "a [key] b")
        self.assertEqual(generate.scrub("token=hello123", "hello123"), "token=[key]")

    def test_bad_response_leaves_no_file_and_counts_cost(self):
        no_field = lambda: SimpleNamespace(data=[SimpleNamespace(b64_json=None)])  # noqa: E731
        for bad in ("!!!not base64!!!", b64(b"GIF89a-not-png"), "", no_field):
            with self.subTest(bad=bad):
                client = FakeClient([bad])
                code = self.run_main(["--group", "test"], client=client)
                self.assertEqual(code, generate.EXIT_FAILED)
                raw = self.root / "art" / "raw"
                self.assertEqual([p.name for p in raw.iterdir() if p.name != "ledger.jsonl"], [])
                self.assertGreater(self.ledger()[-1]["est_cost_usd"], 0)  # 응답을 받았으니 돈은 나갔다
                (raw / "ledger.jsonl").unlink()

    def test_ctrl_c_keeps_finished_work_and_ledger(self):
        items = [self.item("a"), self.item("b", out="art/raw/b.png"), self.item("c", out="art/raw/c.png")]
        client = FakeClient([None, KeyboardInterrupt()])
        code = self.run_main(["--group", "test"], client=client, items=items)
        self.assertEqual(code, generate.EXIT_INTERRUPTED)
        raw = self.root / "art" / "raw"
        self.assertEqual(sorted(p.name for p in raw.iterdir() if p.suffix == ".png"), ["a.png"])
        self.assertFalse(list(raw.glob("*.tmp")))
        self.assertEqual([r["status"] for r in self.ledger()], ["ok", "interrupted"])
        self.assertIn("만듦 1장", self.cap.out.getvalue())
        self.assertFalse((raw / ".generate.lock").exists())

    def test_ctrl_c_during_retry_wait(self):
        def boom(_):
            raise KeyboardInterrupt()

        client = FakeClient([FakeApiError("x", 429)])
        table = self.write_table([self.item("a")])
        cap = Capture()
        code = generate.main(["--table", str(table), "--group", "test"], root=self.root,
                             env={generate.ENV_KEY: FAKE_KEY}, client_factory=lambda k: client, sleep=boom,
                             stdout=cap.out, stderr=cap.err)
        self.assertEqual(code, generate.EXIT_INTERRUPTED)
        self.assertFalse((self.root / "art" / "raw" / ".generate.lock").exists())

    def test_save_failure_is_reported_and_costed(self):
        raw = self.root / "art" / "raw"
        raw.mkdir(parents=True)
        (raw / "a.png").mkdir()  # 같은 이름의 폴더 → 덮어쓸 수 없다
        client = FakeClient()
        code = self.run_main(["--group", "test", "--force"], client=client)
        self.assertEqual(code, generate.EXIT_FAILED)
        self.assertGreater(self.ledger()[0]["est_cost_usd"], 0)
        self.assertFalse(list(raw.glob("*.tmp")))

    def test_transparent_requested_but_rgb_png_is_flagged(self):
        client = FakeClient(png=make_png(4, 4, color_type=2))
        self.assertEqual(self.run_main(["--group", "test"], client=client), 0)
        self.assertIn("알파", self.cap.err.getvalue())
        self.assertIn("알파", self.ledger()[0]["note"])


class Locking(GenerateCase):
    def test_existing_lock_blocks_a_second_run(self):
        raw = self.root / "art" / "raw"
        raw.mkdir(parents=True)
        (raw / ".generate.lock").write_text("123")
        client = FakeClient()
        code = self.run_main(["--group", "test"], client=client)
        self.assertEqual(code, generate.EXIT_LOCKED)
        self.assertEqual(client.calls, [])
        self.assertTrue((raw / ".generate.lock").exists())  # 남의 잠금은 지우지 않는다

    def test_lock_is_released_after_run(self):
        self.run_main(["--group", "test"], client=FakeClient())
        self.assertFalse((self.root / "art" / "raw" / ".generate.lock").exists())


class DefaultClientFactory(unittest.TestCase):
    def test_missing_package_gives_clear_setup_error(self):
        import builtins

        real_import = builtins.__import__

        def fake_import(name, *a, **kw):
            if name == "openai":
                raise ImportError("no openai")
            return real_import(name, *a, **kw)

        builtins.__import__ = fake_import
        try:
            with self.assertRaises(generate.SetupError):
                generate.default_client_factory("k")
        finally:
            builtins.__import__ = real_import


class CommandLine(support.TempRoot):
    """실제로 python generate.py 를 띄워 본다 (키 없는 환경)."""

    def run_cli(self, *argv):
        env = {k: v for k, v in os.environ.items() if k != "OPENAI_API_KEY"}
        script = str(support.SCRIPT_DIR / "generate.py")
        return subprocess.run([sys.executable, script, *argv], capture_output=True, text=True,
                              encoding="utf-8", env=env, timeout=60)

    def test_help(self):
        r = self.run_cli("--help")
        self.assertEqual(r.returncode, 0)
        for flag in ("--group", "--only", "--dry-run", "--max-images", "--budget-usd", "--quality", "--model", "--force"):
            self.assertIn(flag, r.stdout)

    def test_no_key_group_test_stops_with_guidance(self):
        table = self.write_table([self.item("never", out="art/raw/__unittest_never__.png")])
        r = self.run_cli("--table", str(table), "--group", "test")
        # 표의 out 은 이 저장소의 art/ 기준이지만, 키가 없으면 아무것도 쓰기 전에 멈춘다
        self.assertEqual(r.returncode, generate.EXIT_NOT_READY, r.stdout + r.stderr)
        self.assertIn("OPENAI_API_KEY", r.stderr)

    def test_dry_run_without_key(self):
        table = self.write_table([self.item("never", out="art/raw/__unittest_never__.png")])
        r = self.run_cli("--table", str(table), "--group", "test", "--dry-run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("예상 비용", r.stdout)


if __name__ == "__main__":
    unittest.main()
