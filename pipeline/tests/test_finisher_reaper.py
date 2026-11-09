"""Tests for the finisher crash-recovery lane: claim stamping, the stale
reaper, the timed-out requeue helper, the conditional terminal write, and
the cron's enforced DEADLINE_S budget.

Regression suite for the 2026-07-05 incident where a SIGKILLed finisher
left finisher_status='running' for 4 hours (story 1kg8vng). Store tests
mirror test_story_jobs.py (_IsolatedDB); the run_drain tests import the
Vercel cron the same way test_drain_story_jobs.py imports its drain.

Plan: _plans/2026-07-05-finisher-stale-running-recovery.md.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import time
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DRAIN_DIR = REPO_ROOT / "lorewire-app" / "api"
if str(DRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(DRAIN_DIR))

# Imported here so the sys.path insert is in effect before the module
# resolves `from pipeline import ...` via the local pipeline pkg.
import run_hero_thumbnail_finisher as cron  # noqa: E402

OLD = "2020-01-01T00:00:00+00:00"


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

    # ── seeding ──────────────────────────────────────────────────────────

    def _seed_source(self, reddit_id: str) -> None:
        self.store.upsert_reddit_source({
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

    def _seed_finisher_pending(self, n: str) -> str:
        """One finished story_job with a done short and a pending
        finisher — exactly the state claim_finisher_job looks for.
        Returns the job id."""
        reddit_id = f"src-{n}"
        job_id = f"job-{n}"
        story_id = f"story-{n}"
        self._seed_source(reddit_id)
        self.store.enqueue_story_job(job_id, reddit_id)
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], story_id)
        self.store.enqueue_short_render(f"short-{n}", story_id, f"hash-{n}")
        self._sql(
            "UPDATE short_renders SET status='done', output_url='u' "
            "WHERE story_id=?",
            (story_id,),
        )
        self.store.mark_finisher_pending(job_id)
        return job_id

    def _seed_finisher_running(
        self, n: str, *, claimed_at: str | None, attempts: int = 0,
    ) -> str:
        job_id = self._seed_finisher_pending(n)
        claimed = self.store.claim_finisher_job()
        self.assertEqual(claimed["id"], job_id)
        self._sql(
            "UPDATE story_jobs SET finisher_claimed_at=?, "
            "finisher_attempts=? WHERE id=?",
            (claimed_at, attempts, job_id),
        )
        return job_id

    # ── raw row access (finisher_* columns aren't in _STORY_JOB_COLUMNS) ─

    def _sql(self, sql: str, params: tuple = ()):
        with sqlite3.connect(self.db_path) as c:
            c.row_factory = sqlite3.Row
            return c.execute(sql, params).fetchall()

    def _finisher_row(self, job_id: str) -> sqlite3.Row:
        rows = self._sql(
            "SELECT finisher_status, finisher_claimed_at, "
            "COALESCE(finisher_attempts, 0) AS attempts "
            "FROM story_jobs WHERE id=?",
            (job_id,),
        )
        return rows[0]

    def _event_types(self, job_id: str) -> list[str]:
        return [e["event"] for e in self.store.list_story_job_events(job_id)]


class ClaimStampTests(_IsolatedDB):
    def test_claim_stamps_claimed_at(self):
        job_id = self._seed_finisher_pending("a")
        claimed = self.store.claim_finisher_job()
        self.assertEqual(claimed["id"], job_id)
        row = self._finisher_row(job_id)
        self.assertEqual(row["finisher_status"], "running")
        self.assertIsNotNone(row["finisher_claimed_at"])


class ReapStaleFinisherTests(_IsolatedDB):
    def test_revives_old_claim_to_pending(self):
        job_id = self._seed_finisher_running("a", claimed_at=OLD)
        acted = self.store.reap_stale_finisher_jobs(60)
        self.assertEqual(acted, 1)
        row = self._finisher_row(job_id)
        self.assertEqual(row["finisher_status"], "pending")
        self.assertIsNone(row["finisher_claimed_at"])
        self.assertEqual(row["attempts"], 1)
        self.assertIn("finisher_reaper_revived", self._event_types(job_id))

    def test_revived_row_is_reclaimable(self):
        job_id = self._seed_finisher_running("a", claimed_at=OLD)
        self.store.reap_stale_finisher_jobs(60)
        reclaimed = self.store.claim_finisher_job()
        self.assertIsNotNone(reclaimed)
        self.assertEqual(reclaimed["id"], job_id)

    def test_null_claimed_at_is_treated_as_stale(self):
        # A 'running' row with no stamp was claimed before the column
        # existed — the exact production zombie this feature clears.
        job_id = self._seed_finisher_running("a", claimed_at=None)
        acted = self.store.reap_stale_finisher_jobs(60)
        self.assertEqual(acted, 1)
        self.assertEqual(self._finisher_row(job_id)["finisher_status"], "pending")

    def test_fresh_claim_is_left_alone(self):
        job_id = self._seed_finisher_pending("a")
        self.store.claim_finisher_job()  # claimed_at = now
        acted = self.store.reap_stale_finisher_jobs(60)
        self.assertEqual(acted, 0)
        self.assertEqual(self._finisher_row(job_id)["finisher_status"], "running")

    def test_gives_up_at_attempts_cap(self):
        cap = self.store.MAX_FINISHER_ATTEMPTS
        job_id = self._seed_finisher_running("a", claimed_at=OLD, attempts=cap)
        acted = self.store.reap_stale_finisher_jobs(60)
        self.assertEqual(acted, 1)
        row = self._finisher_row(job_id)
        self.assertEqual(row["finisher_status"], "failed")
        self.assertIn("finisher_reaper_gave_up", self._event_types(job_id))

    def test_non_running_rows_are_untouched(self):
        job_id = self._seed_finisher_pending("a")
        acted = self.store.reap_stale_finisher_jobs(60)
        self.assertEqual(acted, 0)
        self.assertEqual(self._finisher_row(job_id)["finisher_status"], "pending")


class SetFinisherStatusTests(_IsolatedDB):
    def test_writes_terminal_state_on_running_row(self):
        job_id = self._seed_finisher_running("a", claimed_at=OLD)
        self.store.set_finisher_status(job_id, "done")
        self.assertEqual(self._finisher_row(job_id)["finisher_status"], "done")

    def test_orphan_write_cannot_clobber_cancelled(self):
        # Admin Stop writes 'cancelled' while the worker thread is still
        # in flight; the thread's late 'done' must be a no-op.
        job_id = self._seed_finisher_running("a", claimed_at=OLD)
        self._sql(
            "UPDATE story_jobs SET finisher_status='cancelled' WHERE id=?",
            (job_id,),
        )
        self.store.set_finisher_status(job_id, "done")
        self.assertEqual(
            self._finisher_row(job_id)["finisher_status"], "cancelled",
        )


class RequeueTimedOutTests(_IsolatedDB):
    def test_requeues_under_the_cap(self):
        job_id = self._seed_finisher_running("a", claimed_at=OLD)
        outcome = self.store.requeue_or_fail_timed_out_finisher(job_id)
        self.assertEqual(outcome, "requeued")
        row = self._finisher_row(job_id)
        self.assertEqual(row["finisher_status"], "pending")
        self.assertIsNone(row["finisher_claimed_at"])
        self.assertEqual(row["attempts"], 1)
        self.assertIn("finisher_timeout_requeued", self._event_types(job_id))

    def test_fails_at_the_cap(self):
        cap = self.store.MAX_FINISHER_ATTEMPTS
        job_id = self._seed_finisher_running("a", claimed_at=OLD, attempts=cap)
        outcome = self.store.requeue_or_fail_timed_out_finisher(job_id)
        self.assertEqual(outcome, "failed")
        self.assertEqual(self._finisher_row(job_id)["finisher_status"], "failed")
        self.assertIn("finisher_timeout_gave_up", self._event_types(job_id))

    def test_noops_on_a_non_running_row(self):
        job_id = self._seed_finisher_pending("a")
        outcome = self.store.requeue_or_fail_timed_out_finisher(job_id)
        self.assertIsNone(outcome)
        self.assertEqual(self._finisher_row(job_id)["finisher_status"], "pending")


class RunDrainTests(_IsolatedDB):
    """The cron entry point. run_finisher_for_job is stubbed — its
    internals are covered by test_worker_short_orchestration.py; here we
    exercise the reap + claim + budget wrapper around it."""

    def test_idle_when_queue_empty(self):
        self.assertEqual(cron.run_drain(), {"drained": 0, "remaining": 0})

    def test_drains_one_row(self):
        self._seed_finisher_pending("a")
        with mock.patch.object(
            cron.story_jobs_worker, "run_finisher_for_job",
        ) as m:
            body = cron.run_drain()
        m.assert_called_once()
        self.assertEqual(body["drained"], 1)

    def test_reaps_stale_running_row_then_reclaims_it(self):
        job_id = self._seed_finisher_running("a", claimed_at=OLD)
        with mock.patch.object(
            cron.story_jobs_worker, "run_finisher_for_job",
        ) as m:
            body = cron.run_drain()
        # The zombie was revived to 'pending' and re-claimed on the SAME
        # tick — no wasted 2-minute wait.
        m.assert_called_once()
        self.assertEqual(m.call_args[0][0]["id"], job_id)
        self.assertEqual(body["drained"], 1)

    def test_timeout_requeues_the_row(self):
        job_id = self._seed_finisher_pending("a")

        def hang(_claimed):
            time.sleep(1.0)

        with mock.patch.object(cron, "DEADLINE_S", 0.0), \
                mock.patch.object(cron, "MIN_BUDGET_S", 0.05), \
                mock.patch.object(
                    cron.story_jobs_worker, "run_finisher_for_job", hang,
                ):
            body = cron.run_drain()
        self.assertTrue(body["timed_out"])
        self.assertEqual(body["outcome"], "requeued")
        self.assertEqual(body["drained"], 0)
        row = self._finisher_row(job_id)
        self.assertEqual(row["finisher_status"], "pending")
        self.assertEqual(row["attempts"], 1)

    def test_timeout_fails_the_row_at_the_cap(self):
        job_id = self._seed_finisher_pending("a")
        self._sql(
            "UPDATE story_jobs SET finisher_attempts=? WHERE id=?",
            (self.store.MAX_FINISHER_ATTEMPTS, job_id),
        )

        def hang(_claimed):
            time.sleep(1.0)

        with mock.patch.object(cron, "DEADLINE_S", 0.0), \
                mock.patch.object(cron, "MIN_BUDGET_S", 0.05), \
                mock.patch.object(
                    cron.story_jobs_worker, "run_finisher_for_job", hang,
                ):
            body = cron.run_drain()
        self.assertEqual(body["outcome"], "failed")
        self.assertEqual(self._finisher_row(job_id)["finisher_status"], "failed")

    def test_fatal_marks_failed_and_reraises(self):
        job_id = self._seed_finisher_pending("a")
        with mock.patch.object(
            cron.story_jobs_worker, "run_finisher_for_job",
            side_effect=RuntimeError("boom"),
        ):
            with self.assertRaises(RuntimeError):
                cron.run_drain()
        self.assertEqual(self._finisher_row(job_id)["finisher_status"], "failed")


if __name__ == "__main__":
    unittest.main()
