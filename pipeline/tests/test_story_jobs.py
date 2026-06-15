"""Tests for the story_jobs queue: store helpers + worker tick paths.

The worker's process_fn is the real pipeline (LLM + kie + voice + video);
we don't exercise it here. Tests inject a stub that returns a synthetic
story row, so the claim → finish / claim → fail paths are covered without
burning real credits.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock


class _IsolatedDB(unittest.TestCase):
    def setUp(self):
        # ignore_cleanup_errors: matches the codebase convention for
        # tempdir + sqlite on Windows.
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
        store.init()
        self.store = store

    def tearDown(self):
        self._patch.stop()
        self.tmpdir.cleanup()
        from pipeline import config, store
        reload(config)
        reload(store)


def _seed_reddit_source(store_mod, reddit_id: str = "abc"):
    store_mod.upsert_reddit_source({
        "reddit_id": reddit_id,
        "subreddit": "AITAH",
        "date_written": "2026-01-01T00:00:00+00:00",
        "title": "T",
        "full_text": "F",
        "comments": 1,
        "url": None,
        "summary": None,
        "length_chars": 1,
        "status": "imported",
        "story_id": None,
        "notes": None,
        "first_synced": "2026-06-14T00:00:00+00:00",
        "last_synced": "2026-06-14T00:00:00+00:00",
    })


class EnqueueTests(_IsolatedDB):
    def test_first_enqueue_inserts_row(self):
        _seed_reddit_source(self.store)
        row = self.store.enqueue_story_job("job-1", "abc")
        self.assertIsNotNone(row)
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["reddit_id"], "abc")
        self.assertEqual(row["with_media"], 1)

    def test_second_enqueue_is_noop_while_active(self):
        _seed_reddit_source(self.store)
        first = self.store.enqueue_story_job("job-1", "abc")
        second = self.store.enqueue_story_job("job-2", "abc")
        self.assertIsNotNone(first)
        self.assertIsNone(second, "duplicate enqueue should no-op")

    def test_enqueue_after_done_is_allowed(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        # Worker claims and finishes.
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "story-1")
        # A re-process attempt is allowed (previous job is done, not active).
        second = self.store.enqueue_story_job("job-2", "abc")
        self.assertIsNotNone(second)

    def test_with_media_flag_round_trips(self):
        _seed_reddit_source(self.store)
        row = self.store.enqueue_story_job("job-1", "abc", with_media=False)
        self.assertEqual(row["with_media"], 0)
        # DB-side too.
        claimed = self.store.claim_next_story_job()
        self.assertEqual(claimed["with_media"], 0)

    # 2026-06-16 Reddit-import per-batch output override. The TS side
    # (lib/story-jobs.ts) writes this column from
    # processRedditSourcesAction; the worker reads it via
    # resolve_output_format. See _plans/2026-06-16-reddit-default-to-shorts.md.
    def test_output_format_short_round_trips(self):
        _seed_reddit_source(self.store)
        row = self.store.enqueue_story_job("job-1", "abc", output_format="short")
        self.assertEqual(row["output_format"], "short")
        claimed = self.store.claim_next_story_job()
        self.assertEqual(claimed["output_format"], "short")

    def test_output_format_long_round_trips(self):
        _seed_reddit_source(self.store)
        row = self.store.enqueue_story_job("job-1", "abc", output_format="long")
        self.assertEqual(row["output_format"], "long")
        claimed = self.store.claim_next_story_job()
        self.assertEqual(claimed["output_format"], "long")

    def test_output_format_omitted_is_null(self):
        _seed_reddit_source(self.store)
        row = self.store.enqueue_story_job("job-1", "abc")
        self.assertIsNone(row["output_format"])
        claimed = self.store.claim_next_story_job()
        self.assertIsNone(claimed["output_format"])

    def test_output_format_bad_value_normalised_to_null(self):
        """Closed-enum defence: a stale caller (or a hand-crafted POST that
        squeaked past the TS action's validation) must not be able to
        smuggle a typo through the storage layer, because the worker's
        resolver would then see something it doesn't recognise and fall
        through to the global setting — silently overriding the admin's
        explicit per-batch pick."""
        _seed_reddit_source(self.store)
        row = self.store.enqueue_story_job("job-1", "abc", output_format="shrt")
        self.assertIsNone(row["output_format"])


class ResolveOutputFormatTests(unittest.TestCase):
    """Pure-function tests for the worker's per-row format resolution.
    No DB needed — the resolver takes a `get_setting` callable, so the
    tests can synthesise rows + settings without isolating the store."""

    def _resolve(self, row_format, setting_value):
        from pipeline.story_jobs_worker import resolve_output_format

        def fake_setting(key):
            if key == "reddit.default_output":
                return setting_value
            return None

        return resolve_output_format(
            {"id": "job-1", "output_format": row_format},
            get_setting=fake_setting,
        )

    def test_row_override_short_wins_over_setting(self):
        self.assertEqual(self._resolve("short", "long"), ("short", "row"))

    def test_row_override_long_wins_over_setting(self):
        self.assertEqual(self._resolve("long", "short"), ("long", "row"))

    def test_setting_used_when_row_null(self):
        self.assertEqual(self._resolve(None, "long"), ("long", "setting"))

    def test_setting_used_when_row_empty_string(self):
        self.assertEqual(self._resolve("", "long"), ("long", "setting"))

    def test_default_short_when_both_unset(self):
        self.assertEqual(self._resolve(None, None), ("short", "default"))

    def test_default_short_when_setting_malformed(self):
        # A typo in the setting falls through to the hardcoded default
        # rather than crashing the worker — the admin can fix the
        # setting next time they visit the page without a queue drain.
        self.assertEqual(self._resolve(None, "vertical"), ("short", "default"))

    def test_row_override_falls_through_when_malformed(self):
        # Defence-in-depth: if a stale row somehow has a bad value, fall
        # through to the setting layer instead of crashing.
        self.assertEqual(self._resolve("shrt", "long"), ("long", "setting"))

    def test_case_insensitive(self):
        self.assertEqual(self._resolve("SHORT", None), ("short", "row"))
        self.assertEqual(self._resolve(None, "Long"), ("long", "setting"))


class ClaimAndTransitionTests(_IsolatedDB):
    def test_claim_returns_none_on_empty(self):
        self.assertIsNone(self.store.claim_next_story_job())

    def test_claim_flips_status_and_sets_started_at(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.assertEqual(claimed["status"], "processing")
        self.assertIsNotNone(claimed["started_at"])

    def test_claim_with_text_only_only_filter_skips_media_jobs(self):
        """Production regression: the Vercel cron drain previously
        called run_one_tick(skip_with_media=True), which still let
        claim_next_story_job claim ANY queued row and then failed it
        with the unsupported-media error. That created a race against
        the local worker — whichever fired first killed the row for
        the other. Pushing the filter down to the SQL means the drain
        physically can't claim what it can't process, so with_media=True
        rows wait patiently for the local worker."""
        # Seed a media row and a text-only row, with the media row
        # older so it'd be claimed first by the default ORDER BY.
        _seed_reddit_source(self.store, "media-row")
        _seed_reddit_source(self.store, "text-row")
        self.store.enqueue_story_job("media-job", "media-row", with_media=True)
        # Tiny delay so requested_at differs in lexical sort.
        import time as _t
        _t.sleep(0.01)
        self.store.enqueue_story_job("text-job", "text-row", with_media=False)

        # text_only_only=True must skip the media row even though it's
        # the oldest, and claim the text row instead.
        claimed = self.store.claim_next_story_job(text_only_only=True)
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["reddit_id"], "text-row")
        self.assertEqual(claimed["with_media"], 0)

        # Media row is still queued, untouched.
        media_job = self.store.get_story_job("media-job")
        self.assertEqual(media_job["status"], "queued")
        self.assertIsNone(media_job["started_at"])

    def test_claim_with_text_only_only_returns_none_when_only_media_queued(self):
        """If there are ONLY with_media=True rows queued, the
        text-only-filtered claim must return None instead of falling
        through to claim a media row."""
        _seed_reddit_source(self.store, "media-row")
        self.store.enqueue_story_job("media-job", "media-row", with_media=True)

        claimed = self.store.claim_next_story_job(text_only_only=True)
        self.assertIsNone(claimed)

        # Default claim still picks it up — local worker path.
        claimed = self.store.claim_next_story_job()
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["with_media"], 1)

    def test_claim_does_not_re_claim(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        a = self.store.claim_next_story_job()
        b = self.store.claim_next_story_job()
        self.assertIsNotNone(a)
        self.assertIsNone(b, "second claim on same row should return None")

    def test_finish_marks_done(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "story-1")
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["story_id"], "story-1")
        self.assertEqual(row["progress"], 100)
        self.assertIsNotNone(row["finished_at"])

    def test_fail_marks_error_with_message(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.store.fail_story_job(claimed["id"], "kie down")
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error"], "kie down")
        self.assertIsNotNone(row["finished_at"])

    def test_finish_after_cancellation_is_noop(self):
        # We don't have a cancellation surface yet, but the conditional
        # UPDATE in finish_story_job guards against future cancel paths
        # the same way finish_image_render does. Force the row out of
        # 'processing'/'queued' to simulate cancellation.
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        # Bypass status helpers to force 'cancelled' shape.
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "UPDATE story_jobs SET status='cancelled' WHERE id=?",
                (claimed["id"],),
            )
        self.store.finish_story_job(claimed["id"], "story-1")
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "cancelled", "cancelled wins over done")

    def test_finish_after_reap_does_not_silently_no_op(self):
        """Regression: previously finish_story_job had a strict
        `status='processing'` guard. When the reaper flipped a stale
        row back to 'queued', the original worker's finish call would
        silently no-op, leaving story_jobs.status='queued' while the
        admin's reddit_source.status flipped to 'used' — an
        inconsistency that triggered a double-process on the next tick
        and burned LLM/kie cost twice. Softened to
        `status IN ('queued', 'processing')`."""
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        # Reaper kicks in mid-run — flip back to queued.
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "UPDATE story_jobs SET status='queued', started_at=NULL "
                "WHERE id=?",
                (claimed["id"],),
            )
        # The original worker's finish call must still succeed.
        self.store.finish_story_job(claimed["id"], "story-1")
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["story_id"], "story-1")

    def test_fail_after_reap_does_not_silently_no_op(self):
        """Same regression, fail side."""
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "UPDATE story_jobs SET status='queued', started_at=NULL "
                "WHERE id=?",
                (claimed["id"],),
            )
        self.store.fail_story_job(claimed["id"], "ELK down")
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error"], "ELK down")

    def test_latest_for_reddit_returns_newest(self):
        _seed_reddit_source(self.store, "x")
        self.store.enqueue_story_job("j1", "x")
        claimed = self.store.claim_next_story_job()
        self.store.fail_story_job(claimed["id"], "first fail")
        # New attempt — slightly later requested_at via the natural clock.
        import time as _t
        _t.sleep(0.01)
        self.store.enqueue_story_job("j2", "x")
        latest = self.store.latest_story_job_for_reddit("x")
        self.assertEqual(latest["id"], "j2")
        self.assertEqual(latest["status"], "queued")

    def test_count_pending_only_counts_active(self):
        _seed_reddit_source(self.store, "a")
        _seed_reddit_source(self.store, "b")
        self.store.enqueue_story_job("j1", "a")
        self.store.enqueue_story_job("j2", "b")
        self.assertEqual(self.store.count_pending_story_jobs(), 2)
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "s1")
        self.assertEqual(self.store.count_pending_story_jobs(), 1)


class PartialUniqueIndexTests(_IsolatedDB):
    """Phase 5: the partial unique index `idx_story_jobs_one_active`
    enforces "at most one active job per reddit_id" at the DB level.
    These tests verify both that the index actually rejects duplicates
    AND that the enqueue helper's ON CONFLICT clause turns a rejection
    into a clean no-op (instead of an exception that would crash the
    bulk-enqueue action)."""

    def test_index_rejects_raw_duplicate_insert(self):
        """Bypass the helper and insert two rows directly. The second
        must fail with a UNIQUE / IntegrityError, proving the index is
        in force. This is the load-bearing safety net — the rest of the
        defenses are convenience."""
        import sqlite3
        _seed_reddit_source(self.store, "abc")
        # Use the helper for row 1 so we get a valid shape.
        self.store.enqueue_story_job("job-1", "abc")
        # Second raw insert with status='queued' must violate the index.
        with sqlite3.connect(self.store.DB_PATH) as c:
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute(
                    "INSERT INTO story_jobs "
                    "(id, reddit_id, status, progress, with_media, requested_at) "
                    "VALUES ('job-2', 'abc', 'queued', 0, 1, '2026-06-14T00:00:00+00:00')"
                )

    def test_index_allows_done_and_error_rows(self):
        """The index's WHERE is 'queued OR processing' — once a job
        settles to done or error, a new active job for the same
        reddit_id is allowed (and is exactly the re-process path)."""
        import sqlite3
        _seed_reddit_source(self.store, "abc")
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "story-1")
        # Now a fresh raw insert with status='queued' must succeed —
        # the prior 'done' row is outside the partial-index predicate.
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "INSERT INTO story_jobs "
                "(id, reddit_id, status, progress, with_media, requested_at) "
                "VALUES ('job-2', 'abc', 'queued', 0, 1, '2026-06-14T00:00:00+00:00')"
            )
        # Sanity: the count of active jobs for 'abc' is now 1.
        with sqlite3.connect(self.store.DB_PATH) as c:
            row = c.execute(
                "SELECT count(*) FROM story_jobs WHERE reddit_id='abc' "
                "AND status IN ('queued', 'processing')"
            ).fetchone()
            self.assertEqual(row[0], 1)

    def test_enqueue_helper_returns_none_on_race_loss(self):
        """Simulate the race: bypass has_active_story_job (pretend it
        returned False for both callers) and call the INSERT path
        twice. The second call's ON CONFLICT DO NOTHING must catch
        the index rejection and return None — NOT raise."""
        _seed_reddit_source(self.store, "abc")
        # First enqueue is normal.
        first = self.store.enqueue_story_job("job-1", "abc")
        self.assertIsNotNone(first)

        # Now monkey-patch has_active_story_job to lie (return False),
        # so the second enqueue tries the INSERT path. Without ON
        # CONFLICT this would crash with IntegrityError; with it, we
        # expect a clean None.
        original = self.store.has_active_story_job
        try:
            self.store.has_active_story_job = lambda _rid: False
            second = self.store.enqueue_story_job("job-2", "abc")
            self.assertIsNone(second, "race-loser must return None, not raise")
        finally:
            self.store.has_active_story_job = original

        # And the DB still has exactly one active job for 'abc'.
        self.assertEqual(self.store.count_pending_story_jobs(), 1)


class StaleReapTests(_IsolatedDB):
    def test_reap_moves_old_processing_back_to_queued(self):
        _seed_reddit_source(self.store, "a")
        self.store.enqueue_story_job("j1", "a")
        claimed = self.store.claim_next_story_job()
        # Backdate started_at well past the stale window.
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "UPDATE story_jobs SET started_at=? WHERE id=?",
                ("2020-01-01T00:00:00+00:00", claimed["id"]),
            )
        reaped = self.store.reap_stale_story_jobs(60)
        self.assertEqual(reaped, 1)
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "queued")
        self.assertIsNone(row["started_at"])

    def test_reap_leaves_fresh_in_flight_alone(self):
        _seed_reddit_source(self.store, "a")
        self.store.enqueue_story_job("j1", "a")
        self.store.claim_next_story_job()  # started_at = now
        reaped = self.store.reap_stale_story_jobs(60)
        self.assertEqual(reaped, 0)


class WorkerTickTests(_IsolatedDB):
    def test_happy_path_calls_process_and_finishes(self):
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.enqueue_story_job("job-1", "abc")

        def stub_process(job, row):
            self.assertEqual(job["reddit_id"], "abc")
            self.assertEqual(row["reddit_id"], "abc")
            return {"id": "abc"}  # the stories.id matches reddit_id by convention

        ran = story_jobs_worker.run_one_tick(process_fn=stub_process)
        self.assertTrue(ran)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["story_id"], "abc")
        src = self.store.fetch_reddit_source("abc")
        self.assertEqual(src["status"], "used")
        self.assertEqual(src["story_id"], "abc")

    def test_failure_records_error_and_resets_source_row(self):
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.enqueue_story_job("job-1", "abc")

        def stub_process(job, row):
            raise RuntimeError("kie down")

        ran = story_jobs_worker.run_one_tick(process_fn=stub_process)
        self.assertTrue(ran)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "error")
        self.assertIn("kie down", row["error"])
        src = self.store.fetch_reddit_source("abc")
        # Source row resets to 'queued' so a future Process re-pick works.
        self.assertEqual(src["status"], "queued")

    def test_empty_queue_returns_false(self):
        from pipeline import story_jobs_worker
        ran = story_jobs_worker.run_one_tick(process_fn=lambda j, r: {"id": "x"})
        self.assertFalse(ran)

    def test_missing_source_row_fails_job_cleanly(self):
        from pipeline import story_jobs_worker
        # Enqueue a job pointing at a non-existent reddit_source row.
        # We bypass the active-check by writing the row directly.
        import sqlite3
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "INSERT INTO story_jobs (id, reddit_id, status, progress, "
                "with_media, requested_at) VALUES (?, ?, 'queued', 0, 1, ?)",
                ("job-1", "missing", now),
            )

        ran = story_jobs_worker.run_one_tick(
            process_fn=lambda j, r: {"id": "x"},
        )
        self.assertTrue(ran)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "error")
        self.assertIn("not found", row["error"])

    def test_skip_with_media_does_not_claim_video_job_at_all(self):
        """skip_with_media=True now pushes the filter all the way down
        to the claim SQL — the drain doesn't see media jobs in the
        first place, so it can't race the local worker and kill them.

        Previously the drain claimed THEN failed, which meant whichever
        drain fired first won the row: Vercel cron at minute boundaries
        kept beating the local worker that polls every 5s, killing
        every with_media=True job the admin enqueued (production bug,
        25 dead rows on 2026-06-14)."""
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.set_reddit_source_status("abc", "queued")
        self.store.enqueue_story_job("job-1", "abc", with_media=True)

        process_calls: list[dict] = []

        def stub_process(job, row):
            process_calls.append(job)
            return {"id": "abc"}

        ran = story_jobs_worker.run_one_tick(
            process_fn=stub_process, skip_with_media=True,
        )
        # The drain's tick sees an empty queue (text-only filter excludes
        # the only row) and returns False.
        self.assertFalse(ran)
        self.assertEqual(process_calls, [])

        # Critical: the row is UNTOUCHED. Local worker can still pick it up.
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "queued")
        self.assertIsNone(row["started_at"])
        src = self.store.fetch_reddit_source("abc")
        self.assertEqual(src["status"], "queued")

    def test_skip_with_media_lets_text_only_job_process_normally(self):
        """When the claimed job is with_media=False, skip_with_media=True
        must NOT pre-skip it — the drain can run text-only jobs to
        completion. Guards against an over-broad skip flag that would
        block every drained row."""
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.set_reddit_source_status("abc", "queued")
        self.store.enqueue_story_job("job-1", "abc", with_media=False)

        def stub_process(job, row):
            return {"id": "abc"}

        ran = story_jobs_worker.run_one_tick(
            process_fn=stub_process, skip_with_media=True,
        )
        self.assertTrue(ran)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "done")
        src = self.store.fetch_reddit_source("abc")
        self.assertEqual(src["status"], "used")

    def test_skip_with_media_default_off_preserves_local_worker_path(self):
        """The default skip_with_media=False must keep the local worker's
        behaviour identical — video jobs run, no pre-skip. Backwards
        compatibility guard: if a future refactor flips the default to
        True this test catches it before video jobs get silently dropped
        on every local CLI run."""
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.set_reddit_source_status("abc", "queued")
        self.store.enqueue_story_job("job-1", "abc", with_media=True)

        process_calls: list[dict] = []

        def stub_process(job, row):
            process_calls.append(job)
            return {"id": "abc"}

        ran = story_jobs_worker.run_one_tick(process_fn=stub_process)
        self.assertTrue(ran)
        self.assertEqual(
            len(process_calls), 1,
            "Default tick must run the process_fn even for video jobs.",
        )
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "done")


class BudgetGateTests(_IsolatedDB):
    """Phase 7: daily-budget cap. Worker tick checks projected spend
    BEFORE claiming a job, blocks when projection + next-job-estimate
    would breach the cap, and proceeds otherwise."""

    def _set_cap(self, cents: int | None):
        from pipeline.story_jobs_worker import DAILY_BUDGET_CAP_SETTING_KEY
        if cents is None:
            self.store.set_setting(DAILY_BUDGET_CAP_SETTING_KEY, "")
        else:
            self.store.set_setting(DAILY_BUDGET_CAP_SETTING_KEY, str(cents))

    def test_no_cap_means_no_block(self):
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.enqueue_story_job("job-1", "abc")
        # No cap set — gate must let the tick claim.
        self.assertIsNone(story_jobs_worker._budget_block_reason())

    def test_invalid_cap_treated_as_unset(self):
        """A corrupt or zero / negative cap value must NOT silently block
        every tick forever — admin intent of 'off' beats 'broken setting
        equals total halt.'"""
        from pipeline import story_jobs_worker
        for bad in ("", "  ", "0", "-50", "abc"):
            self._set_cap(None)  # clear
            self.store.set_setting(
                story_jobs_worker.DAILY_BUDGET_CAP_SETTING_KEY, bad
            )
            self.assertIsNone(
                story_jobs_worker._budget_block_reason(),
                f"bad cap {bad!r} should be treated as unset",
            )

    def test_block_when_next_job_would_exceed_cap(self):
        """Single queued job + cap of 1¢ = blocked (any positive job
        cost would breach a 1-cent cap)."""
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.enqueue_story_job("job-1", "abc")
        # Today's estimate is 1 active job × $0.50 = $0.50 = 50c. Cap of
        # 1c is way under the projection + next-job-estimate.
        self._set_cap(1)
        reason = story_jobs_worker._budget_block_reason()
        self.assertIsNotNone(reason)
        self.assertIn("cap=1c", reason)
        # And run_one_tick returns False (no work claimed).
        ran = story_jobs_worker.run_one_tick(
            process_fn=lambda j, r: {"id": "should-not-run"},
        )
        self.assertFalse(ran, "worker tick must not claim when blocked")
        # The queued row is still queued (not claimed).
        job = self.store.get_story_job("job-1")
        self.assertEqual(job["status"], "queued")

    def test_proceed_when_under_cap(self):
        """Generous cap leaves room — tick claims and finishes."""
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.enqueue_story_job("job-1", "abc")
        self._set_cap(100_00)  # $100 cap — way over the $0.50 estimate

        ran = story_jobs_worker.run_one_tick(
            process_fn=lambda j, r: {"id": "abc"},
        )
        self.assertTrue(ran)
        job = self.store.get_story_job("job-1")
        self.assertEqual(job["status"], "done")

    def test_estimate_counts_done_today_plus_active(self):
        """The projection includes today's finished jobs AND in-flight
        (queued/processing) jobs. A row queued yesterday but still active
        today counts toward today's projection."""
        import datetime as _dt
        # Seed 3 rows: one done today, one queued, one done long ago.
        for rid in ("a", "b", "c"):
            _seed_reddit_source(self.store, rid)
        self.store.enqueue_story_job("j-done-today", "a")
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "story-a")

        self.store.enqueue_story_job("j-active", "b")  # stays queued

        # An ancient done row outside today's window — must NOT count.
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "INSERT INTO story_jobs (id, reddit_id, status, progress, "
                "with_media, requested_at, finished_at, story_id) "
                "VALUES ('j-ancient', 'c', 'done', 100, 1, ?, ?, 'story-c')",
                ("2020-01-01T00:00:00+00:00", "2020-01-01T00:00:00+00:00"),
            )

        from pipeline.story_jobs_worker import ESTIMATED_JOB_COST_CENTS
        estimate = self.store.today_story_job_estimate_cents(
            ESTIMATED_JOB_COST_CENTS,
        )
        # 1 done today + 1 active = 2 × 50c = 100c. Ancient row excluded.
        self.assertEqual(estimate, 2 * ESTIMATED_JOB_COST_CENTS)
        _ = _dt  # quiet pyflakes; future use

    def test_estimate_includes_last_microsecond_of_today(self):
        """Regression: the day-window upper bound used to be
        '23:59:59.999999' which lex-compared as LESS than
        '23:59:59.999999+00:00' (longer strings win), so timestamps
        stamped with a timezone suffix at the very end of the day were
        silently excluded. Half-open [day_start, next_midnight) fixes
        that and includes every microsecond of today."""
        import datetime as _dt
        today = _dt.datetime.now(_dt.timezone.utc).date().isoformat()
        # A job that finished at the very last microsecond, with a
        # timezone suffix — exactly the row that previously dropped.
        _seed_reddit_source(self.store, "edge")
        self.store.enqueue_story_job("j-edge", "edge")
        claimed = self.store.claim_next_story_job()
        # Manually rewrite finished_at to the end-of-day boundary.
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "UPDATE story_jobs SET status='done', "
                "finished_at=?, story_id='story-edge' WHERE id=?",
                (f"{today}T23:59:59.999999+00:00", claimed["id"]),
            )

        from pipeline.story_jobs_worker import ESTIMATED_JOB_COST_CENTS
        estimate = self.store.today_story_job_estimate_cents(
            ESTIMATED_JOB_COST_CENTS,
        )
        # 1 done today (the edge row) = 1 × 50c.
        self.assertEqual(estimate, ESTIMATED_JOB_COST_CENTS)

    def test_zero_estimate_when_no_jobs(self):
        """Empty queue + no done-today rows = $0 projected. Even with
        a small cap the gate lets the (non-existent) next tick proceed.
        We verify the helper directly since there's nothing to claim."""
        from pipeline import story_jobs_worker
        self._set_cap(50_00)  # $50 cap
        # No jobs at all → no_active and no done-today → projection 0.
        # Gate sees 0 + 50c next < 5000c cap = NOT blocked.
        self.assertIsNone(story_jobs_worker._budget_block_reason())


class ActualCostTests(_IsolatedDB):
    """Micro-phase: real cost capture. The worker now writes
    stories.cost_cents on every run; this helper sums it for today UTC."""

    def _insert_story(
        self,
        story_id: str,
        cost_cents: int | None,
        created_at: str,
    ) -> None:
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "INSERT INTO stories (id, status, cost_cents, created_at) "
                "VALUES (?, 'review', ?, ?)",
                (story_id, cost_cents, created_at),
            )

    def test_returns_zero_when_no_stories(self):
        self.assertEqual(self.store.today_actual_story_cost_cents(), 0)

    def test_sums_today_cost_cents(self):
        import datetime as _dt
        today = _dt.datetime.now(_dt.timezone.utc).date().isoformat()
        self._insert_story("s1", 25, f"{today}T01:00:00+00:00")
        self._insert_story("s2", 73, f"{today}T15:00:00+00:00")
        self.assertEqual(self.store.today_actual_story_cost_cents(), 98)

    def test_excludes_other_days(self):
        import datetime as _dt
        today = _dt.datetime.now(_dt.timezone.utc).date().isoformat()
        self._insert_story("s-today", 50, f"{today}T01:00:00+00:00")
        self._insert_story("s-old", 9999, "2020-01-01T00:00:00+00:00")
        self.assertEqual(self.store.today_actual_story_cost_cents(), 50)

    def test_excludes_null_cost_rows(self):
        """Older rows that pre-date the cost-capture wiring have
        cost_cents NULL. Those must not break the SUM."""
        import datetime as _dt
        today = _dt.datetime.now(_dt.timezone.utc).date().isoformat()
        self._insert_story("legacy", None, f"{today}T01:00:00+00:00")
        self._insert_story("new", 33, f"{today}T02:00:00+00:00")
        self.assertEqual(self.store.today_actual_story_cost_cents(), 33)

    def test_includes_last_microsecond_of_today(self):
        """Same boundary regression as today_story_job_estimate_cents:
        a row stamped at 23:59:59.999999 with a timezone suffix used to
        drop out of the SUM. With half-open [day_start, next_midnight)
        it counts."""
        import datetime as _dt
        today = _dt.datetime.now(_dt.timezone.utc).date().isoformat()
        self._insert_story("edge", 77, f"{today}T23:59:59.999999+00:00")
        self.assertEqual(self.store.today_actual_story_cost_cents(), 77)


class CostCaptureTests(_IsolatedDB):
    """Regression coverage for `compute_job_cost_cents` — the pure helper
    that turns the per-job media + LLM deltas into the integer cents
    that lands in stories.cost_cents.

    Before this micro-phase, `cost_cents` was computed inline in
    `_default_process` and the formula excluded LLM token cost entirely.
    Every `with_media=False` job reported $0 even though the article-
    writing LLM calls cost real money. Extracting the formula and
    testing it locks that down."""

    def test_pure_media_delta_converts_to_cents(self):
        from pipeline.story_jobs_worker import compute_job_cost_cents
        # $0.32 media delta, 0 LLM tokens = 32 cents.
        self.assertEqual(compute_job_cost_cents(0.32, 0), 32)

    def test_pure_llm_delta_converts_to_cents(self):
        """Regression for the LLM-cost gap. Pre-fix this returned 0."""
        from pipeline.story_jobs_worker import (
            compute_job_cost_cents,
            LLM_USD_PER_TOKEN,
        )
        # 100k tokens × 1e-6 USD/token = $0.10 = 10 cents.
        tokens = 100_000
        expected = round(tokens * LLM_USD_PER_TOKEN * 100)
        self.assertEqual(compute_job_cost_cents(0.0, tokens), expected)
        self.assertEqual(expected, 10)

    def test_combined_media_and_llm_delta(self):
        from pipeline.story_jobs_worker import compute_job_cost_cents
        # $0.32 media + 100k tokens ($0.10 LLM) = $0.42 = 42 cents.
        self.assertEqual(compute_job_cost_cents(0.32, 100_000), 42)

    def test_clamps_negative_deltas_to_zero(self):
        """Defensive — `totals` should be monotonic, but driver quirks
        could in principle return a negative read. Clamp."""
        from pipeline.story_jobs_worker import compute_job_cost_cents
        self.assertEqual(compute_job_cost_cents(-0.50, -100_000), 0)
        # Mixed: negative LLM, positive media — media still wins.
        self.assertEqual(compute_job_cost_cents(0.32, -100_000), 32)

    def test_zero_deltas_yield_zero(self):
        from pipeline.story_jobs_worker import compute_job_cost_cents
        self.assertEqual(compute_job_cost_cents(0.0, 0), 0)


class VideoRenderHandoffTests(_IsolatedDB):
    """The story-jobs worker no longer renders MP4 itself — instead it
    enqueues a video_renders row that the Cloud Run cron drain picks
    up. This split makes every story-job fully completable on Vercel's
    Python runtime; the only thing that still needs Node + Remotion is
    the render step, which lives behind its own queue and own service."""

    def _story_row(self, **overrides) -> dict:
        base = {
            "id": "story-1",
            "title": "T",
            "body": "Body",
            "hero_image": "https://example/hero.png",
            "images": '["https://example/scene1.png"]',
            "audio_url": "https://example/voice.mp3",
            "alignment": "[]",
        }
        base.update(overrides)
        return base

    def test_enqueues_video_render_for_a_fresh_story(self):
        from pipeline import story_jobs_worker
        story_jobs_worker._enqueue_video_render_for_story(self._story_row())
        # video_renders should now have exactly one row pointing at story-1.
        # Use the latest_render_for_story helper as the read surface.
        row = self.store.latest_render_for_story("story-1")
        self.assertIsNotNone(row)
        self.assertEqual(row["story_id"], "story-1")
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["requested_by"], "story_jobs_worker")

    def test_idempotent_against_same_content(self):
        """Re-processing the same story (e.g. after a worker retry)
        with identical content must NOT insert a second render — the
        ON CONFLICT DO NOTHING on (story_id, config_hash) is the guard."""
        from pipeline import story_jobs_worker
        story_jobs_worker._enqueue_video_render_for_story(self._story_row())
        first = self.store.latest_render_for_story("story-1")
        story_jobs_worker._enqueue_video_render_for_story(self._story_row())
        second = self.store.latest_render_for_story("story-1")
        self.assertEqual(first["id"], second["id"])

    def test_fresh_render_when_content_changes(self):
        """If the body / hero / images change between re-processes, the
        config hash flips and a fresh video_render row is inserted —
        Cloud Run will then re-render with the new content."""
        from pipeline import story_jobs_worker
        story_jobs_worker._enqueue_video_render_for_story(self._story_row())
        first = self.store.latest_render_for_story("story-1")
        story_jobs_worker._enqueue_video_render_for_story(
            self._story_row(body="An edited body — fresh content"),
        )
        # Two distinct render rows now exist for the same story.
        # latest_render_for_story returns the newest by requested_at.
        second = self.store.latest_render_for_story("story-1")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(second["status"], "queued")


class CancelTests(_IsolatedDB):
    """Stop button. Admin cancels a row → DB flips to 'cancelled'
    immediately; any later finish/fail from the worker no-ops against
    the existing `status IN ('queued','processing')` guards on those
    helpers (see test_finish_after_cancellation_is_noop above)."""

    def test_cancel_queued_job_succeeds(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        flipped = self.store.cancel_story_job("job-1")
        self.assertTrue(flipped)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "cancelled")
        self.assertIsNotNone(row["finished_at"])

    def test_cancel_processing_job_succeeds(self):
        """Mid-render cancel is the whole point of the Stop button."""
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        self.store.claim_next_story_job()  # status -> processing
        flipped = self.store.cancel_story_job("job-1")
        self.assertTrue(flipped)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "cancelled")

    def test_cancel_done_is_noop(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "story-1")
        flipped = self.store.cancel_story_job("job-1")
        self.assertFalse(flipped)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "done")

    def test_cancel_error_is_noop(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.store.fail_story_job(claimed["id"], "kie boom")
        flipped = self.store.cancel_story_job("job-1")
        self.assertFalse(flipped)

    def test_cancel_unknown_id_is_noop(self):
        self.assertFalse(self.store.cancel_story_job("does-not-exist"))

    def test_late_finish_after_cancel_does_not_overwrite(self):
        """Regression-protect the key invariant: cancellation is sticky.
        Worker mid-render flips a row to cancelled — its eventual finish
        call (which may land minutes later) must NOT overwrite."""
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.store.cancel_story_job("job-1")
        # Worker comes back from its LLM call and tries to finish.
        self.store.finish_story_job(claimed["id"], "story-1")
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "cancelled")

    def test_bulk_cancel_targets_only_active_rows(self):
        for rid in ("a", "b", "c"):
            _seed_reddit_source(self.store, rid)
        self.store.enqueue_story_job("ja", "a")
        self.store.enqueue_story_job("jb", "b")
        self.store.enqueue_story_job("jc", "c")
        # Craft state: a queued, b processing, c done.
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as conn:
            conn.execute(
                "UPDATE story_jobs SET status='processing', "
                "started_at='2026-06-14T00:00:00+00:00' WHERE id='jb'"
            )
            conn.execute("UPDATE story_jobs SET status='done' WHERE id='jc'")

        cancelled = self.store.cancel_active_jobs_for_reddit_ids(
            ["a", "b", "c"]
        )
        self.assertEqual(cancelled, 2)
        self.assertEqual(self.store.get_story_job("ja")["status"], "cancelled")
        self.assertEqual(self.store.get_story_job("jb")["status"], "cancelled")
        # Done row untouched.
        self.assertEqual(self.store.get_story_job("jc")["status"], "done")

    def test_bulk_cancel_empty_input_is_noop(self):
        self.assertEqual(
            self.store.cancel_active_jobs_for_reddit_ids([]), 0,
        )


class HelpersTests(_IsolatedDB):
    def test_category_for_known_subreddit(self):
        from pipeline.story_jobs_worker import _category_for
        self.assertEqual(_category_for("AmItheAsshole"), "Entitled")
        self.assertEqual(_category_for("relationships"), "Dating")

    def test_category_for_unknown_subreddit_defaults_to_drama(self):
        from pipeline.story_jobs_worker import _category_for
        self.assertEqual(_category_for("WeirdNicheNewSub"), "Drama")
        self.assertEqual(_category_for(""), "Drama")

    def test_reddit_source_to_post_shape(self):
        from pipeline.story_jobs_worker import reddit_source_to_post
        row = {
            "reddit_id": "rid",
            "subreddit": "AmItheAsshole",
            "title": "T",
            "full_text": "Body",
            "comments": 42,
            "url": "https://example",
        }
        post = reddit_source_to_post(row)
        self.assertEqual(post["id"], "rid")
        self.assertEqual(post["selftext"], "Body")
        self.assertEqual(post["num_comments"], 42)
        # Category is derived (case-insensitive lookup), not parroted.
        self.assertEqual(post["category"], "Entitled")


if __name__ == "__main__":
    unittest.main()
