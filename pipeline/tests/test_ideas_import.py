"""Tests for pipeline.ideas_import.

Covers the parser (header validation, filtering, normalization), the merge
contract (the four cases from
_plans/2026-06-23-ideasdb-priority-import.md), and the apply path
(dry-run vs --apply, idempotency, audit log write).

Each test class spins up an isolated SQLite DB via the same pattern as
test_store_reddit_source.py so the dev DB is never touched.
"""
from __future__ import annotations

import csv
import json
import os
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock


class _IsolatedDB(unittest.TestCase):
    """Per-test SQLite DB so the importer runs against a real reddit_source
    table without touching pipeline/lorewire.db. Mirrors the pattern from
    test_store_reddit_source.py:_IsolatedDB."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._patch = mock.patch.dict(os.environ, {
            "PIPELINE_DB": str(self.db_path),
            "DATABASE_URL": "",
        }, clear=False)
        self._patch.start()
        from pipeline import config, store
        reload(config)
        reload(store)
        # The importer module reads `store` at import time; reload it too so
        # it picks up the freshly-configured store.
        from pipeline import ideas_import
        reload(ideas_import)
        store.init()
        self.store = store
        self.ideas = ideas_import

    def tearDown(self):
        self._patch.stop()
        self.tmpdir.cleanup()
        from pipeline import config, store, ideas_import
        reload(config)
        reload(store)
        reload(ideas_import)


# Headers in IdeasDB order — DictWriter relies on a stable header list.
_HEADERS = [
    "Category", "Type", "Headline", "Summary",
    "Source", "Strength", "Done Already?",
]


def _write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=_HEADERS)
        w.writeheader()
        for r in rows:
            w.writerow({h: r.get(h, "") for h in _HEADERS})


def _seed_reddit(store_mod, **overrides) -> None:
    base = {
        "reddit_id": "abc123",
        "subreddit": "AITAH",
        "date_written": "2026-03-01T00:00:00+00:00",
        "title": "Existing reddit post title",
        "full_text": "real reddit body text",
        "comments": 42,
        "url": None,
        "summary": None,
        "length_chars": 22,
        "status": "imported",
        "story_id": None,
        "notes": None,
        "first_synced": "2026-03-01T00:00:00+00:00",
        "last_synced": "2026-03-01T00:00:00+00:00",
    }
    base.update(overrides)
    store_mod.upsert_reddit_source(base)


# ============================== parser =====================================


class ParserTests(_IsolatedDB):
    def test_happy_path_story_row(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ideas.csv"
            _write_csv(p, [{
                "Category": "Drama", "Type": "Story",
                "Headline": "A real story", "Summary": "Short summary.",
                "Source": "abc123", "Strength": "Strong",
                "Done Already?": "",
            }])
            rows, warns = self.ideas.parse_ideas_csv(p)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].headline, "A real story")
        self.assertEqual(rows[0].strength, "strong")
        self.assertEqual(rows[0].source_tokens, ("abc123",))
        self.assertFalse(rows[0].done)
        self.assertEqual(warns, [])

    def test_missing_header_raises(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "bad.csv"
            # Headers missing "Strength" — hard fail per the plan.
            with p.open("w", encoding="utf-8", newline="") as f:
                f.write("Category,Type,Headline,Summary,Source,Done Already?\n")
                f.write("Drama,Story,X,Y,abc123,No\n")
            with self.assertRaises(ValueError) as ctx:
                self.ideas.parse_ideas_csv(p)
        self.assertIn("Strength", str(ctx.exception))

    def test_multi_token_source_splits(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ideas.csv"
            _write_csv(p, [{
                "Category": "Drama", "Type": "Story",
                "Headline": "Multi-source", "Summary": "Combined from N posts.",
                "Source": "tok1aaa tok2bbb tok3ccc", "Strength": "Strong",
                "Done Already?": "",
            }])
            rows, _warns = self.ideas.parse_ideas_csv(p)
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0].source_tokens, ("tok1aaa", "tok2bbb", "tok3ccc")
        )

    def test_strength_parens_tolerance(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ideas.csv"
            _write_csv(p, [{
                "Category": "Drama", "Type": "Story",
                "Headline": "With paren", "Summary": "s",
                "Source": "x", "Strength": "Strong (Property Drama)",
                "Done Already?": "",
            }])
            rows, warns = self.ideas.parse_ideas_csv(p)
        self.assertEqual(rows[0].strength, "strong")
        self.assertEqual(warns, [])

    def test_blank_strength_warns_and_defaults_medium(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ideas.csv"
            _write_csv(p, [{
                "Category": "Drama", "Type": "Story",
                "Headline": "blank str", "Summary": "s",
                "Source": "x", "Strength": "", "Done Already?": "",
            }])
            rows, warns = self.ideas.parse_ideas_csv(p)
        self.assertEqual(rows[0].strength, "medium")
        self.assertEqual(len(warns), 1)
        self.assertIn("blank Strength", warns[0])

    def test_unrecognised_strength_warns_and_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ideas.csv"
            _write_csv(p, [{
                "Category": "Drama", "Type": "Story",
                "Headline": "weird str", "Summary": "s",
                "Source": "x", "Strength": "she needs to wait",
                "Done Already?": "",
            }])
            rows, warns = self.ideas.parse_ideas_csv(p)
        self.assertEqual(rows[0].strength, "medium")
        self.assertEqual(len(warns), 1)
        self.assertIn("unrecognised", warns[0].lower())

    def test_done_yes_recognised(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ideas.csv"
            _write_csv(p, [{
                "Category": "Drama", "Type": "Story",
                "Headline": "done one", "Summary": "s",
                "Source": "abc123", "Strength": "Strong",
                "Done Already?": "Yes",
            }, {
                "Category": "Drama", "Type": "Story",
                "Headline": "not done", "Summary": "s",
                "Source": "def456", "Strength": "Strong",
                "Done Already?": "",
            }])
            rows, _warns = self.ideas.parse_ideas_csv(p)
        self.assertTrue(rows[0].done)
        self.assertFalse(rows[1].done)

    def test_list_type_preserved_for_filter_downstream(self):
        # Parser keeps List rows; compute_diff drops them. Tested here so
        # a future filter at parse time doesn't slip in without us noticing.
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ideas.csv"
            _write_csv(p, [{
                "Category": "Drama", "Type": "List",
                "Headline": "a list", "Summary": "s",
                "Source": "x", "Strength": "Strong", "Done Already?": "",
            }])
            rows, _warns = self.ideas.parse_ideas_csv(p)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].type_, "List")

    def test_blank_headline_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ideas.csv"
            _write_csv(p, [{
                "Category": "Drama", "Type": "Story",
                "Headline": "", "Summary": "no headline",
                "Source": "x", "Strength": "Strong", "Done Already?": "",
            }])
            rows, warns = self.ideas.parse_ideas_csv(p)
        self.assertEqual(rows, [])
        self.assertEqual(len(warns), 1)
        self.assertIn("blank Headline", warns[0])

    def test_fingerprint_normalization(self):
        # "  Hello  WORLD  " and "hello world" produce the same fingerprint.
        f1 = self.ideas.normalize_fingerprint("  Hello  WORLD  ", "Drama")
        f2 = self.ideas.normalize_fingerprint("hello world", "drama")
        self.assertEqual(f1, f2)
        self.assertEqual(f1, "hello world|drama")


# ============================== diff =======================================


class DiffTests(_IsolatedDB):
    def _write_one(self, **kwargs) -> Path:
        d = Path(self.tmpdir.name)
        p = d / "ideas.csv"
        defaults = {
            "Category": "Drama", "Type": "Story",
            "Summary": "s", "Done Already?": "",
        }
        defaults.update(kwargs)
        _write_csv(p, [defaults])
        return p

    def test_matched_token_strong_flip(self):
        _seed_reddit(self.store, reddit_id="abc123")
        p = self._write_one(Headline="Existing reddit", Source="abc123",
                            Strength="Strong")
        rows, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows, str(p))
        self.assertEqual(summary.rows_updated, 1)
        self.assertEqual(summary.rows_added, 0)
        self.assertEqual(summary.rows_unchanged, 0)
        diff = summary.diffs[0]
        self.assertEqual(diff.action, "updated")
        self.assertEqual(diff.reddit_id, "abc123")
        self.assertEqual(diff.before["strength"], "none")
        self.assertEqual(diff.after["strength"], "strong")

    def test_unmatched_source_creates_idea(self):
        p = self._write_one(Headline="Pure idea", Source="external_search_1",
                            Strength="Medium")
        rows, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows, str(p))
        self.assertEqual(summary.rows_added, 1)
        diff = summary.diffs[0]
        self.assertEqual(diff.action, "added")
        self.assertTrue(diff.reddit_id.startswith("idea_"))
        self.assertEqual(diff.after["strength"], "medium")
        self.assertEqual(diff.after["needs_expansion"], 1)

    def test_type_list_skipped(self):
        _seed_reddit(self.store, reddit_id="abc123")
        d = Path(self.tmpdir.name)
        p = d / "ideas.csv"
        _write_csv(p, [{
            "Category": "Drama", "Type": "List",
            "Headline": "a list", "Summary": "s",
            "Source": "abc123", "Strength": "Strong", "Done Already?": "",
        }])
        rows, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows, str(p))
        self.assertEqual(summary.rows_skipped_list, 1)
        self.assertEqual(summary.rows_total, 1)
        self.assertEqual(summary.rows_updated, 0)
        self.assertEqual(len(summary.diffs), 0)

    def test_done_yes_flips_imported_to_skipped(self):
        _seed_reddit(self.store, reddit_id="abc123", status="imported")
        p = self._write_one(Headline="Match", Source="abc123",
                            Strength="Strong", **{"Done Already?": "Yes"})
        rows, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows, str(p))
        self.assertEqual(summary.rows_status_changed, 1)
        self.assertEqual(summary.diffs[0].after["status"], "skipped")

    def test_done_yes_on_used_seed_still_applies_priority(self):
        # Per Yoav's 2026-06-23 clarification: priority is editorial signal
        # and travels with the row regardless of Done state. So Done=Yes on
        # a used seed leaves status='used' (can't un-ship) but still flips
        # strength so the priority badge is filterable in the admin.
        _seed_reddit(self.store, reddit_id="abc123", status="used")
        p = self._write_one(Headline="Match", Source="abc123",
                            Strength="Strong", **{"Done Already?": "Yes"})
        rows, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows, str(p))
        # Status untouched, but strength + headline + category land.
        self.assertEqual(summary.rows_status_changed, 0)
        self.assertEqual(summary.rows_updated, 1)
        diff = summary.diffs[0]
        self.assertEqual(diff.action, "updated")
        self.assertEqual(diff.after["strength"], "strong")
        self.assertNotIn("status", diff.after)
        # Warning surfaces so the operator can see the status stalemate.
        self.assertTrue(any(
            "Done=Yes but seed.status=used" in w for w in diff.warnings
        ))

    def test_done_yes_then_no_restores_imported(self):
        _seed_reddit(self.store, reddit_id="abc123", status="imported")
        # First run with Done=Yes flips to skipped.
        p = self._write_one(Headline="Match", Source="abc123",
                            Strength="Strong", **{"Done Already?": "Yes"})
        rows, _ = self.ideas.parse_ideas_csv(p)
        self.ideas.apply(self.ideas.compute_diff(rows, str(p)), dry_run=False)
        row = self.store.fetch_reddit_source("abc123")
        self.assertEqual(row["status"], "skipped")
        # Second run with Done=No restores to imported.
        p2 = self._write_one(Headline="Match", Source="abc123",
                             Strength="Strong", **{"Done Already?": ""})
        rows2, _ = self.ideas.parse_ideas_csv(p2)
        summary = self.ideas.compute_diff(rows2, str(p2))
        self.assertEqual(summary.rows_status_changed, 1)
        self.assertEqual(summary.diffs[0].after["status"], "imported")

    def test_idempotent_second_run_is_all_unchanged(self):
        _seed_reddit(self.store, reddit_id="abc123")
        p = self._write_one(Headline="Match", Source="abc123",
                            Strength="Strong")
        rows1, _ = self.ideas.parse_ideas_csv(p)
        self.ideas.apply(self.ideas.compute_diff(rows1, str(p)), dry_run=False)
        # Second pass with the same CSV:
        rows2, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows2, str(p))
        self.assertEqual(summary.rows_unchanged, 1)
        self.assertEqual(summary.rows_updated, 0)
        self.assertEqual(summary.rows_added, 0)
        self.assertEqual(summary.rows_strength_only, 0)

    def test_strength_change_only_after_first_apply(self):
        _seed_reddit(self.store, reddit_id="abc123")
        p1 = self._write_one(Headline="Match", Source="abc123",
                             Strength="Medium")
        self.ideas.apply(
            self.ideas.compute_diff(self.ideas.parse_ideas_csv(p1)[0], str(p1)),
            dry_run=False,
        )
        # Now upgrade Medium -> Strong; everything else identical.
        p2 = self._write_one(Headline="Match", Source="abc123",
                             Strength="Strong")
        rows, _ = self.ideas.parse_ideas_csv(p2)
        summary = self.ideas.compute_diff(rows, str(p2))
        self.assertEqual(summary.rows_strength_only, 1)
        self.assertEqual(summary.rows_updated, 0)
        diff = summary.diffs[0]
        self.assertEqual(diff.action, "strength_only")
        self.assertEqual(diff.before["strength"], "medium")
        self.assertEqual(diff.after["strength"], "strong")

    def test_fingerprint_match_when_no_token(self):
        # First import: pure idea, no Source.
        p1 = self._write_one(Headline="No-source idea",
                             Source="", Strength="Medium")
        rows1, _ = self.ideas.parse_ideas_csv(p1)
        self.ideas.apply(self.ideas.compute_diff(rows1, str(p1)), dry_run=False)
        # Second import: same headline+category. Should hit fingerprint match,
        # not create a duplicate idea_<sha>.
        p2 = self._write_one(Headline="No-source idea",
                             Source="", Strength="Strong")
        rows2, _ = self.ideas.parse_ideas_csv(p2)
        summary = self.ideas.compute_diff(rows2, str(p2))
        self.assertEqual(summary.rows_added, 0)
        self.assertEqual(summary.rows_strength_only, 1)

    def test_multi_token_secondary_flips(self):
        # Two existing seeds in the pool. The IdeaRow's Source carries
        # both ids. The diff should fan out the strength flip.
        _seed_reddit(self.store, reddit_id="tok1aaa")
        _seed_reddit(self.store, reddit_id="tok2bbb",
                     title="another existing", full_text="another body",
                     summary="another sum", length_chars=11)
        p = self._write_one(Headline="Multi-row idea",
                            Source="tok1aaa tok2bbb", Strength="Strong")
        rows, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows, str(p))
        diff = summary.diffs[0]
        self.assertEqual(diff.reddit_id, "tok1aaa")  # first token wins primary
        self.assertEqual(diff.secondary_token_flips, ["tok2bbb"])

    def test_vanish_detection_no_op(self):
        # Insert an idea via first import.
        p1 = self._write_one(Headline="Vanishing idea", Source="",
                             Strength="Medium")
        rows1, _ = self.ideas.parse_ideas_csv(p1)
        self.ideas.apply(self.ideas.compute_diff(rows1, str(p1)), dry_run=False)
        # Second import: empty CSV (just headers + one unrelated row, so
        # vanishing isn't a parse error).
        p2 = self._write_one(Headline="Another idea entirely", Source="",
                             Strength="Strong")
        rows2, _ = self.ideas.parse_ideas_csv(p2)
        summary = self.ideas.compute_diff(rows2, str(p2))
        self.assertEqual(summary.seeds_vanished, 1)
        self.assertEqual(len(summary.vanished_ids), 1)

    def test_headline_edit_triggers_re_expansion_on_idea_seed(self):
        # First insert an idea-only seed.
        p1 = self._write_one(Headline="Original long headline about a dog",
                             Source="", Strength="Medium")
        rows1, _ = self.ideas.parse_ideas_csv(p1)
        self.ideas.apply(self.ideas.compute_diff(rows1, str(p1)), dry_run=False)

        # Mark it as already expanded (worker would do this after stage 0).
        row = self.store.fetch_reddit_source_by_fingerprint(
            self.ideas.normalize_fingerprint(
                "Original long headline about a dog", "Drama"
            )
        )
        self.assertIsNotNone(row)
        self.store.update_ideas_fields(row["reddit_id"], needs_expansion=0)

        # Major headline rewrite. Should fire re-expansion.
        p2 = self._write_one(
            Headline="Completely different idea about a cat instead",
            Source="", Strength="Medium",
        )
        rows2, _ = self.ideas.parse_ideas_csv(p2)
        summary = self.ideas.compute_diff(rows2, str(p2))
        # Either updated or added depending on whether the new headline's
        # fingerprint matches anything. Since headline+category changed
        # completely, expect a new added row (not a re-expansion of the
        # original). That's per-plan behavior: substantial rewrite = new seed
        # because the fingerprint changed.
        self.assertEqual(summary.rows_added, 1)


# ============================== apply ======================================


class ApplyTests(_IsolatedDB):
    def _write(self, rows: list[dict]) -> Path:
        d = Path(self.tmpdir.name)
        p = d / "ideas.csv"
        _write_csv(p, rows)
        return p

    def test_dry_run_writes_log_but_no_mutations(self):
        _seed_reddit(self.store, reddit_id="abc123")
        p = self._write([
            {"Category": "Drama", "Type": "Story", "Headline": "Match",
             "Summary": "s", "Source": "abc123", "Strength": "Strong",
             "Done Already?": ""},
        ])
        rows, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows, str(p))
        self.ideas.apply(summary, dry_run=True)
        # reddit_source untouched
        row = self.store.fetch_reddit_source("abc123")
        self.assertEqual(row["strength"], "none")  # not flipped
        # but log row exists
        from pipeline import store
        logs = self._all_log_rows(store)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["dry_run"], 1)
        self.assertEqual(logs[0]["rows_updated"], 1)

    def test_apply_commits_mutations(self):
        _seed_reddit(self.store, reddit_id="abc123")
        p = self._write([
            {"Category": "Drama", "Type": "Story", "Headline": "Match",
             "Summary": "s", "Source": "abc123", "Strength": "Strong",
             "Done Already?": ""},
        ])
        rows, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows, str(p))
        self.ideas.apply(summary, dry_run=False)
        row = self.store.fetch_reddit_source("abc123")
        self.assertEqual(row["strength"], "strong")
        self.assertEqual(row["headline"], "Match")
        self.assertEqual(row["category"], "Drama")

    def test_apply_inserts_idea_only_seed(self):
        p = self._write([
            {"Category": "Drama", "Type": "Story", "Headline": "Pure idea",
             "Summary": "headline-only.", "Source": "external_search_1",
             "Strength": "Medium", "Done Already?": ""},
        ])
        rows, _ = self.ideas.parse_ideas_csv(p)
        summary = self.ideas.compute_diff(rows, str(p))
        self.ideas.apply(summary, dry_run=False)
        from pipeline import store
        # The idea_<sha> seed should be inserted.
        seeds = store.list_ideas_touched_seeds()
        self.assertEqual(len(seeds), 1)
        self.assertTrue(seeds[0]["reddit_id"].startswith("idea_"))
        self.assertEqual(seeds[0]["strength"], "medium")
        full = store.fetch_reddit_source(seeds[0]["reddit_id"])
        self.assertEqual(full["needs_expansion"], 1)
        self.assertEqual(full["subreddit"], "curated")
        self.assertEqual(full["full_text"], "")  # worker dispatch signal

    def _all_log_rows(self, store_mod) -> list[dict]:
        # The log table has no public reader yet — read it directly. Pure
        # test helper; not used outside the test module.
        cols = (
            "run_id, started_at, finished_at, csv_path, dry_run, "
            "rows_total, rows_skipped_list, rows_skipped_done, "
            "rows_added, rows_updated, rows_strength_only, "
            "rows_status_changed, rows_unchanged, rows_warned, "
            "seeds_vanished, notes, diff_json"
        )
        with store_mod._sqlite_conn() as c:
            return [dict(r) for r in c.execute(
                f"SELECT {cols} FROM ideas_import_log"
            ).fetchall()]


# ============================== queue ordering ==============================


class QueueOrderingTests(_IsolatedDB):
    """Verify claim_next_story_job orders by strength DESC then
    requested_at ASC. This is the worker behaviour the plan requires."""

    def _seed_with_strength(self, reddit_id: str, strength: str) -> None:
        _seed_reddit(
            self.store,
            reddit_id=reddit_id,
            title=f"title {reddit_id}",
            full_text=f"body {reddit_id}",
            length_chars=10,
        )
        if strength != "none":
            self.store.update_ideas_fields(reddit_id, strength=strength)

    def _enqueue(self, reddit_id: str, job_id: str) -> None:
        self.store.enqueue_story_job(
            job_id=job_id, reddit_id=reddit_id, with_media=True,
            requested_by="test",
        )

    def test_strong_claims_before_medium_before_none(self):
        # Three seeds, three queued jobs, requested oldest-first as
        # (none, medium, strong) to prove strength weight beats FIFO.
        self._seed_with_strength("seed_none", "none")
        self._seed_with_strength("seed_med", "medium")
        self._seed_with_strength("seed_str", "strong")
        # The seeds are inserted by the test helper at status='imported'.
        # enqueue_story_job is the public entrypoint that mirrors the
        # admin's "Process N" bulk action, so wire that up.
        self._enqueue("seed_none", "job_none")
        self._enqueue("seed_med", "job_med")
        self._enqueue("seed_str", "job_str")

        claim1 = self.store.claim_next_story_job()
        self.assertEqual(claim1["reddit_id"], "seed_str")
        claim2 = self.store.claim_next_story_job()
        self.assertEqual(claim2["reddit_id"], "seed_med")
        claim3 = self.store.claim_next_story_job()
        self.assertEqual(claim3["reddit_id"], "seed_none")
        self.assertIsNone(self.store.claim_next_story_job())

    def test_fifo_within_strength_tier(self):
        # Two strong-strength seeds, enqueued at different times. The
        # older one wins. Proves the secondary `requested_at ASC` still
        # fires within a tier.
        self._seed_with_strength("strong_old", "strong")
        self._seed_with_strength("strong_new", "strong")
        # enqueue in reverse age order to be sure the FIFO is doing work
        # — if we enqueued in chronological order, an accidental
        # `ORDER BY id` would still appear to pass.
        self._enqueue("strong_new", "job_new")
        self._enqueue("strong_old", "job_old")
        claim1 = self.store.claim_next_story_job()
        # `strong_new` was enqueued first → has the earlier requested_at →
        # claims first.
        self.assertEqual(claim1["reddit_id"], "strong_new")
        claim2 = self.store.claim_next_story_job()
        self.assertEqual(claim2["reddit_id"], "strong_old")

    def test_strength_flip_reorders_queue_live(self):
        # Council-flagged scenario: a job is enqueued at default strength,
        # then the operator runs the IdeasDB importer which flips strength
        # on the seed. Because we JOIN at claim time (no denormalization),
        # the next claim should respect the new strength immediately
        # without re-enqueuing the job.
        self._seed_with_strength("late_strong", "none")
        self._seed_with_strength("early_medium", "medium")
        # Enqueue 'late_strong' second so its requested_at is later.
        self._enqueue("early_medium", "job_med")
        self._enqueue("late_strong", "job_strong")
        # Today: medium beats none at the same FIFO position? No — medium
        # claims first.
        claim_before = self.store.claim_next_story_job()
        self.assertEqual(claim_before["reddit_id"], "early_medium")
        # Re-queue medium so two jobs remain (medium + none).
        self.store.set_reddit_source_status("early_medium", "queued")
        # Recreate the medium-priority job (the worker would normally do
        # this via the admin Process N path; here we re-enqueue directly).
        # First, settle the in-flight medium job:
        self.store.finish_story_job("job_med", "fake_story_1")
        # Now: bump 'late_strong' to strong via the ideas-fields updater.
        # This is the post-import path: scripts/import_ideas.py would do
        # exactly this via update_ideas_fields.
        self.store.update_ideas_fields("late_strong", strength="strong")
        # The remaining queued job ('job_strong') should now claim
        # immediately at strong priority.
        claim_after = self.store.claim_next_story_job()
        self.assertEqual(claim_after["reddit_id"], "late_strong")


# ============================== expansion dispatch =========================


class ExpansionDispatchTests(_IsolatedDB):
    """Verify the worker's reddit_source_to_post dispatches to
    expand_seed_to_post for idea-only seeds (needs_expansion=1,
    full_text='') and writes the synthesized body back to the DB."""

    def test_idea_seed_triggers_expansion_and_persists(self):
        # Seed an idea-only row directly, mimicking what
        # pipeline/ideas_import.py would insert.
        self.store.upsert_reddit_source({
            "reddit_id": "idea_test_abc",
            "subreddit": "curated",
            "date_written": "2026-06-23T00:00:00+00:00",
            "title": "Sample idea headline",
            "full_text": "",
            "comments": None,
            "url": None,
            "summary": "Headline-only seed used as expansion input.",
            "length_chars": 0,
            "status": "imported",
            "story_id": None,
            "notes": None,
            "first_synced": "2026-06-23T00:00:00+00:00",
            "last_synced": "2026-06-23T00:00:00+00:00",
            "strength": "strong",
            "category": "Drama",
            "headline": "Sample idea headline",
            "source_hint": None,
            "needs_expansion": 1,
            "fingerprint": "sample idea headline|drama",
        })

        from pipeline import stages, story_jobs_worker
        # Monkey-patch the expansion to return a deterministic stub so we
        # don't hit the LLM and don't depend on prompt drift in the test.
        real_expand = stages.expand_seed_to_post

        def fake_expand(**kwargs):
            return "[fake expansion] " + kwargs["headline"]

        stages.expand_seed_to_post = fake_expand
        try:
            row = self.store.fetch_reddit_source("idea_test_abc")
            post = story_jobs_worker.reddit_source_to_post(row)
        finally:
            stages.expand_seed_to_post = real_expand

        # The post dict should carry the synthesized body in selftext.
        self.assertEqual(post["selftext"],
                         "[fake expansion] Sample idea headline")
        # And the row in DB should have full_text persisted and the
        # needs_expansion flag flipped, so a re-claim skips the LLM.
        row2 = self.store.fetch_reddit_source("idea_test_abc")
        self.assertEqual(row2["full_text"],
                         "[fake expansion] Sample idea headline")
        self.assertEqual(row2["needs_expansion"], 0)

    def test_already_expanded_idea_does_not_re_expand(self):
        # needs_expansion=0 + non-empty full_text → no LLM call.
        self.store.upsert_reddit_source({
            "reddit_id": "idea_already_done",
            "subreddit": "curated",
            "date_written": "2026-06-23T00:00:00+00:00",
            "title": "Cached idea",
            "full_text": "pre-existing expanded body",
            "comments": None, "url": None, "summary": "s", "length_chars": 25,
            "status": "imported", "story_id": None, "notes": None,
            "first_synced": "2026-06-23T00:00:00+00:00",
            "last_synced": "2026-06-23T00:00:00+00:00",
            "strength": "medium", "category": "Drama",
            "headline": "Cached idea", "source_hint": None,
            "needs_expansion": 0, "fingerprint": "cached idea|drama",
        })
        from pipeline import stages, story_jobs_worker
        called: list[str] = []

        def trip_wire(**kwargs):
            called.append(kwargs["headline"])
            return "should not be returned"

        real_expand = stages.expand_seed_to_post
        stages.expand_seed_to_post = trip_wire
        try:
            row = self.store.fetch_reddit_source("idea_already_done")
            post = story_jobs_worker.reddit_source_to_post(row)
        finally:
            stages.expand_seed_to_post = real_expand

        self.assertEqual(called, [], "expand_seed_to_post should NOT fire")
        self.assertEqual(post["selftext"], "pre-existing expanded body")

    def test_regular_reddit_row_uses_full_text_directly(self):
        # A real reddit_source row (needs_expansion=0, non-empty full_text)
        # should pass through unchanged — no expansion, no DB write.
        _seed_reddit(self.store, reddit_id="real_reddit_001")
        from pipeline import stages, story_jobs_worker
        called: list[str] = []
        real_expand = stages.expand_seed_to_post
        stages.expand_seed_to_post = lambda **kw: called.append(kw) or ""
        try:
            row = self.store.fetch_reddit_source("real_reddit_001")
            post = story_jobs_worker.reddit_source_to_post(row)
        finally:
            stages.expand_seed_to_post = real_expand
        self.assertEqual(called, [])
        self.assertEqual(post["selftext"], "real reddit body text")


if __name__ == "__main__":
    unittest.main()
