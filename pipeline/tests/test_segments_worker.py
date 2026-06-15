"""Tests for the intro/outro normalize worker (pipeline/segments_worker.py)
and the store helpers it depends on.

Two layers:
  * `_StoreHelperTestCase` covers `list_pending_segments`,
    `list_abandoned_pending_segments`, and `set_segment_status` against a
    real temp SQLite. These are the worker's only DB-write surface.
  * `_WorkerTestCase` covers `process_segment`, `sweep_abandoned`, and
    `tick` with all collaborators stubbed. The point isn't to test the
    network or ffmpeg (covered elsewhere in test_gcs / test_segments_ffmpeg),
    it's to pin the orchestration: status transitions, failure paths, and
    idempotency.

Per pipeline/tests/test_render_queue.py: every test gets its own SQLite
file via DB_PATH monkey-patch so the production DB is never touched.
"""
from __future__ import annotations

import datetime
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import segments_worker, store


# --- shared base -------------------------------------------------------------

class _SegmentsTestCase(unittest.TestCase):
    """Per-test SQLite. Mirrors the pattern used by test_render_queue."""

    def setUp(self) -> None:
        # `ignore_cleanup_errors=True` papers over a Windows-only quirk where
        # SQLite connections opened inside `with _sqlite_conn() as c:` blocks
        # don't always release the OS file handle by the time the test's
        # `tearDown` removes the tempdir. The handle gets GC'd eventually and
        # the next test's tempdir is fresh, so leaking a few KB into the OS
        # tmp dir for one test run is a fair price for keeping the tests
        # deterministic. Linux/macOS never hit this branch.
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "segments.db"
        self._db_patch = mock.patch.object(store, "DB_PATH", str(db_path))
        self._db_patch.start()
        self._env_patch = mock.patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        os.environ.pop("DATABASE_URL", None)
        store.init()

    def tearDown(self) -> None:
        self._db_patch.stop()
        self._env_patch.stop()
        self._tmpdir.cleanup()

    @staticmethod
    def _insert(
        seg_id: str,
        *,
        kind: str = "intro",
        status: str = "uploading",
        source_url: str = "https://example.test/source.mp4",
        normalized_url: str | None = None,
        created_at: str | None = None,
    ) -> None:
        # We bypass `upsert_segment` so tests can write rows with an arbitrary
        # `created_at` for the abandoned-sweep cases — `upsert_segment` would
        # stamp 'now' and make the time-travel awkward.
        now = created_at or datetime.datetime.now(datetime.timezone.utc).isoformat()
        store.upsert_segment({
            "id": seg_id,
            "kind": kind,
            "label": f"label-{seg_id}",
            "source_url": source_url,
            "normalized_url": normalized_url,
            "duration_ms": None,
            "enabled": 0,
            "status": status,
            "error": None,
            "uploaded_at": None,
            "created_at": now,
            "updated_at": now,
        })


# --- store helper coverage ---------------------------------------------------

class StoreHelperTests(_SegmentsTestCase):
    def test_list_pending_returns_only_uploading_rows(self):
        # The worker must not pick up 'pending' (browser still PUT-ing) nor
        # 'normalizing' (another worker holds it) nor 'ready' / 'error'.
        for sid, status in [
            ("a", "pending"),
            ("b", "uploading"),
            ("c", "uploading"),
            ("d", "normalizing"),
            ("e", "ready"),
            ("f", "error"),
        ]:
            self._insert(sid, status=status)
        ids = sorted(r["id"] for r in store.list_pending_segments(limit=10))
        self.assertEqual(ids, ["b", "c"])

    def test_list_pending_returns_oldest_first(self):
        old = "2026-06-10T00:00:00+00:00"
        new = "2026-06-11T00:00:00+00:00"
        self._insert("newer", status="uploading", created_at=new)
        self._insert("older", status="uploading", created_at=old)
        rows = store.list_pending_segments(limit=10)
        self.assertEqual([r["id"] for r in rows], ["older", "newer"])

    def test_list_pending_respects_limit(self):
        for sid in ("a", "b", "c"):
            self._insert(sid)
        self.assertEqual(len(store.list_pending_segments(limit=2)), 2)

    def test_list_abandoned_pending_returns_old_pending_rows_only(self):
        old = "2026-06-10T00:00:00+00:00"
        new = "2026-06-11T12:00:00+00:00"
        self._insert("old-pending", status="pending", created_at=old)
        self._insert("new-pending", status="pending", created_at=new)
        # Uploading rows must NOT be swept, even if they're old — they're the
        # worker's queue, not browser garbage.
        self._insert("old-uploading", status="uploading", created_at=old)
        rows = store.list_abandoned_pending_segments(
            older_than_iso="2026-06-11T00:00:00+00:00"
        )
        ids = sorted(r["id"] for r in rows)
        self.assertEqual(ids, ["old-pending"])

    def test_set_segment_status_updates_status_and_updated_at(self):
        self._insert("a", status="uploading")
        before = store.fetch_segment("a")["updated_at"]
        store.set_segment_status("a", "normalizing")
        after = store.fetch_segment("a")
        self.assertEqual(after["status"], "normalizing")
        self.assertNotEqual(after["updated_at"], before)

    def test_set_segment_status_patches_allowed_fields(self):
        self._insert("a", status="uploading")
        store.set_segment_status(
            "a",
            "ready",
            normalized_url="https://example.test/a.norm.mp4",
            duration_ms=4180,
            enabled=1,
            error=None,
        )
        row = store.fetch_segment("a")
        self.assertEqual(row["status"], "ready")
        self.assertEqual(row["normalized_url"], "https://example.test/a.norm.mp4")
        self.assertEqual(row["duration_ms"], 4180)
        self.assertEqual(row["enabled"], 1)

    def test_set_segment_status_rejects_unknown_column(self):
        self._insert("a")
        # Defense-in-depth: a typo like `normalised_url` must raise, not
        # silently dump the value into a sibling column.
        with self.assertRaises(ValueError):
            store.set_segment_status("a", "ready", source_url="x")  # not in allow-list

    def test_set_segment_status_requires_id(self):
        with self.assertRaises(ValueError):
            store.set_segment_status("", "ready")


# --- worker orchestration coverage -------------------------------------------

class ProcessSegmentTests(_SegmentsTestCase):
    """`process_segment` is the load-bearing piece. We stub download /
    normalize / upload so the test never touches network or ffmpeg, and
    assert the row goes through the right status sequence."""

    def setUp(self) -> None:
        super().setUp()
        self._tmp_root = Path(tempfile.mkdtemp(prefix="lw-segments-worker-test-"))
        self.addCleanup(_rmtree, self._tmp_root)

    def _row(self, seg_id: str = "abc") -> dict:
        self._insert(seg_id, kind="intro", status="uploading")
        return store.fetch_segment(seg_id)

    def test_happy_path_flips_uploading_to_ready(self):
        row = self._row("seg1")
        # Fakes: download writes a placeholder file; normalize claims a
        # duration; upload returns a public URL.
        downloads: list[tuple[str, Path]] = []
        def fake_download(url: str, dest: Path) -> None:
            downloads.append((url, dest))
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"fake source bytes")

        def fake_normalize(src: Path, out: Path, seg_id: str, aspect: str = "9:16") -> dict:
            # The contract is "writes `out`, returns duration_ms" — match it.
            out.write_bytes(b"fake normalized bytes")
            return {"duration_ms": 4180}

        uploads: list[tuple[Path, str]] = []
        def fake_upload(local: Path, key: str) -> str:
            uploads.append((local, key))
            return f"https://example.test/{key}"

        segments_worker.process_segment(
            row,
            tmp_root=self._tmp_root,
            download=fake_download,
            normalize_fn=fake_normalize,
            upload_fn=fake_upload,
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            # 2026-06-14 plan: process_segment now ffprobes the source
            # to override declared aspect on mismatch. Existing tests
            # use fake bytes that ffprobe can't parse — stub the probe
            # to None so we keep their assertions about the declared
            # path untouched. Probe-override behavior gets its own
            # dedicated tests in ProbeAspectOverrideTests below.
            probe_dims=lambda p: None,
        )

        # Side effects all happened with the right args.
        self.assertEqual(len(downloads), 1)
        self.assertEqual(downloads[0][0], row["source_url"])
        self.assertEqual(len(uploads), 1)
        self.assertEqual(uploads[0][1], "segments/seg1.norm.mp4")

        # Row ends in 'ready' with the worker's outputs persisted.
        after = store.fetch_segment("seg1")
        self.assertEqual(after["status"], "ready")
        self.assertEqual(after["normalized_url"], "https://example.test/segments/seg1.norm.mp4")
        self.assertEqual(after["duration_ms"], 4180)
        self.assertEqual(after["enabled"], 1)
        self.assertIsNone(after["error"])

        # First segment of its kind+aspect auto-activates so the admin doesn't
        # have to click "Set as active" on a fresh install (matches the old
        # uploadSegmentAction's behavior). seg1 has no aspect column -> 9:16
        # slot. The 16:9 slot stays empty — they're independent (2026-06-15).
        self.assertEqual(store.get_setting("video.active_intro_id_9x16"), "seg1")
        self.assertIsNone(store.get_setting("video.active_intro_id_16x9"))

        # Tmp workdir is cleaned up.
        self.assertFalse((self._tmp_root / "seg1").exists())

    def test_auto_activate_does_not_override_existing_pick(self):
        # If an admin has already picked an active intro for this aspect, a
        # later upload of the same aspect MUST NOT clobber that choice — the
        # user already made an explicit decision. seg2 has no aspect -> 9:16.
        store.set_setting("video.active_intro_id_9x16", "older-pick")
        row = self._row("seg2")
        def fake_download(url: str, dest: Path) -> None:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"x")
        def fake_normalize(src: Path, out: Path, sid: str, aspect: str = "9:16") -> dict:
            out.write_bytes(b"y")
            return {"duration_ms": 1000}
        def fake_upload(local: Path, key: str) -> str:
            return f"https://example.test/{key}"

        segments_worker.process_segment(
            row,
            tmp_root=self._tmp_root,
            download=fake_download,
            normalize_fn=fake_normalize,
            upload_fn=fake_upload,
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            # 2026-06-14 plan: process_segment now ffprobes the source
            # to override declared aspect on mismatch. Existing tests
            # use fake bytes that ffprobe can't parse — stub the probe
            # to None so we keep their assertions about the declared
            # path untouched. Probe-override behavior gets its own
            # dedicated tests in ProbeAspectOverrideTests below.
            probe_dims=lambda p: None,
        )

        # Active id is the admin's earlier pick, not the just-uploaded seg2.
        self.assertEqual(
            store.get_setting("video.active_intro_id_9x16"), "older-pick"
        )
        # Row itself still went ready.
        self.assertEqual(store.fetch_segment("seg2")["status"], "ready")

    def test_download_failure_flips_to_error(self):
        self._row("seg-dl")
        def fake_download(url: str, dest: Path) -> None:
            raise RuntimeError("download HTTP 404: not found")

        segments_worker.process_segment(
            store.fetch_segment("seg-dl"),
            tmp_root=self._tmp_root,
            download=fake_download,
            normalize_fn=mock.Mock(),     # must not be called
            upload_fn=mock.Mock(),         # must not be called
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            # 2026-06-14 plan: process_segment now ffprobes the source
            # to override declared aspect on mismatch. Existing tests
            # use fake bytes that ffprobe can't parse — stub the probe
            # to None so we keep their assertions about the declared
            # path untouched. Probe-override behavior gets its own
            # dedicated tests in ProbeAspectOverrideTests below.
            probe_dims=lambda p: None,
        )

        after = store.fetch_segment("seg-dl")
        self.assertEqual(after["status"], "error")
        self.assertIn("download HTTP 404", after["error"])
        self.assertIsNone(after["normalized_url"])

    def test_normalize_failure_flips_to_error(self):
        self._row("seg-nm")
        def fake_download(url: str, dest: Path) -> None:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"fake")
        def fake_normalize(src: Path, out: Path, seg_id: str, aspect: str = "9:16") -> dict:
            raise RuntimeError("ffmpeg rc=1: invalid input")

        segments_worker.process_segment(
            store.fetch_segment("seg-nm"),
            tmp_root=self._tmp_root,
            download=fake_download,
            normalize_fn=fake_normalize,
            upload_fn=mock.Mock(),
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            # 2026-06-14 plan: process_segment now ffprobes the source
            # to override declared aspect on mismatch. Existing tests
            # use fake bytes that ffprobe can't parse — stub the probe
            # to None so we keep their assertions about the declared
            # path untouched. Probe-override behavior gets its own
            # dedicated tests in ProbeAspectOverrideTests below.
            probe_dims=lambda p: None,
        )

        after = store.fetch_segment("seg-nm")
        self.assertEqual(after["status"], "error")
        self.assertIn("ffmpeg rc=1", after["error"])

    def test_upload_failure_flips_to_error(self):
        self._row("seg-up")
        def fake_download(url: str, dest: Path) -> None:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"fake")
        def fake_normalize(src: Path, out: Path, seg_id: str, aspect: str = "9:16") -> dict:
            out.write_bytes(b"fake")
            return {"duration_ms": 1000}
        def fake_upload(local: Path, key: str) -> str:
            raise RuntimeError("GCS upload HTTP 500")

        segments_worker.process_segment(
            store.fetch_segment("seg-up"),
            tmp_root=self._tmp_root,
            download=fake_download,
            normalize_fn=fake_normalize,
            upload_fn=fake_upload,
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            # 2026-06-14 plan: process_segment now ffprobes the source
            # to override declared aspect on mismatch. Existing tests
            # use fake bytes that ffprobe can't parse — stub the probe
            # to None so we keep their assertions about the declared
            # path untouched. Probe-override behavior gets its own
            # dedicated tests in ProbeAspectOverrideTests below.
            probe_dims=lambda p: None,
        )

        after = store.fetch_segment("seg-up")
        self.assertEqual(after["status"], "error")
        self.assertIn("GCS upload HTTP 500", after["error"])

    def test_empty_source_url_flips_to_error(self):
        # source_url None / "" is a programmer error (sign-upload would never
        # write one), but the worker still needs to handle it gracefully
        # rather than blow up with a misleading download exception.
        self._insert("seg-empty", status="uploading", source_url="")
        segments_worker.process_segment(
            store.fetch_segment("seg-empty"),
            tmp_root=self._tmp_root,
            download=mock.Mock(),
            normalize_fn=mock.Mock(),
            upload_fn=mock.Mock(),
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            # 2026-06-14 plan: process_segment now ffprobes the source
            # to override declared aspect on mismatch. Existing tests
            # use fake bytes that ffprobe can't parse — stub the probe
            # to None so we keep their assertions about the declared
            # path untouched. Probe-override behavior gets its own
            # dedicated tests in ProbeAspectOverrideTests below.
            probe_dims=lambda p: None,
        )
        after = store.fetch_segment("seg-empty")
        self.assertEqual(after["status"], "error")
        self.assertIn("source_url", after["error"])

    def test_missing_id_is_a_noop(self):
        # The worker pulled a row that somehow has no id (truncated read?).
        # We log and skip rather than crash the loop.
        must_not_call = mock.Mock(side_effect=AssertionError("must not be called"))
        segments_worker.process_segment(
            {"id": "", "source_url": "x", "kind": "intro"},
            tmp_root=self._tmp_root,
            download=mock.Mock(),
            normalize_fn=mock.Mock(),
            upload_fn=mock.Mock(),
            set_status=must_not_call,
            get_setting=must_not_call,
            set_setting=must_not_call,
        )


class ProbeAspectOverrideTests(_SegmentsTestCase):
    """2026-06-14 plan: the worker probes the source file's actual width
    and height and overrides the row's `aspect` column when it disagrees
    with what the client claimed. Production trigger: the upload form's
    aspect chip silently defaulted to 9:16 so 16:9 uploads got stamped
    9:16 and the segment-resolver dropped them on every 16:9 story."""

    def setUp(self) -> None:
        super().setUp()
        self._tmp_root = Path(tempfile.mkdtemp(prefix="lw-worker-probe-test-"))
        self.addCleanup(_rmtree, self._tmp_root)

    def _insert_with_aspect(self, seg_id: str, declared_aspect: str) -> dict:
        """Insert a row with a specific declared aspect so we can drive
        the override branch deterministically."""
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        store.upsert_segment({
            "id": seg_id,
            "kind": "intro",
            "label": f"label-{seg_id}",
            "source_url": "https://example.test/source.mp4",
            "normalized_url": None,
            "duration_ms": None,
            "enabled": 0,
            "status": "uploading",
            "error": None,
            "uploaded_at": None,
            "created_at": now,
            "updated_at": now,
            "aspect": declared_aspect,
        })
        return store.fetch_segment(seg_id)

    @staticmethod
    def _fakes():
        """Common stub bundle for the probe tests. Returns the four
        injected collaborators plus a list the test can inspect to
        confirm normalize was called with the corrected aspect."""
        normalize_calls: list[tuple[str, str]] = []

        def fake_download(url: str, dest: Path) -> None:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"source")

        def fake_normalize(src: Path, out: Path, sid: str, aspect: str = "9:16") -> dict:
            normalize_calls.append((sid, aspect))
            out.write_bytes(b"out")
            return {"duration_ms": 1000}

        def fake_upload(local: Path, key: str) -> str:
            return f"https://example.test/{key}"

        return fake_download, fake_normalize, fake_upload, normalize_calls

    def test_landscape_source_overrides_declared_portrait(self):
        # The triggering case: the form sent 9:16, the file is 16:9.
        row = self._insert_with_aspect("seg-land", "9:16")
        fake_download, fake_normalize, fake_upload, normalize_calls = self._fakes()

        segments_worker.process_segment(
            row,
            tmp_root=self._tmp_root,
            download=fake_download,
            normalize_fn=fake_normalize,
            upload_fn=fake_upload,
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            probe_dims=lambda p: (3840, 2160),  # 4K landscape
        )

        # Normalize was called with the corrected aspect, not the declared.
        self.assertEqual(normalize_calls, [("seg-land", "16:9")])
        # Row's aspect column was patched to match reality.
        after = store.fetch_segment("seg-land")
        self.assertEqual(after["aspect"], "16:9")
        self.assertEqual(after["status"], "ready")
        # Auto-activate keyed by the CORRECTED aspect (2026-06-15): the segment
        # landed in the 16:9 slot, not the declared-9:16 slot. Writing the slot
        # from the declared aspect instead of the probed one is the cheapest
        # silent bug here, so pin it.
        self.assertEqual(
            store.get_setting("video.active_intro_id_16x9"), "seg-land"
        )
        self.assertIsNone(store.get_setting("video.active_intro_id_9x16"))

    def test_matching_aspect_leaves_column_untouched(self):
        # Declared and actual agree — no override, row aspect stays as-is.
        row = self._insert_with_aspect("seg-match", "16:9")
        fake_download, fake_normalize, fake_upload, normalize_calls = self._fakes()

        segments_worker.process_segment(
            row,
            tmp_root=self._tmp_root,
            download=fake_download,
            normalize_fn=fake_normalize,
            upload_fn=fake_upload,
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            probe_dims=lambda p: (1920, 1080),
        )

        self.assertEqual(normalize_calls, [("seg-match", "16:9")])
        after = store.fetch_segment("seg-match")
        # Aspect stays at declared (no override write fired).
        self.assertEqual(after["aspect"], "16:9")
        self.assertEqual(after["status"], "ready")

    def test_probe_failure_falls_back_to_declared(self):
        # ffprobe couldn't decode the source. The worker logs and
        # proceeds with the declared aspect — same as the pre-2026-06-14
        # behavior. The DB row's aspect column stays untouched.
        row = self._insert_with_aspect("seg-probefail", "9:16")
        fake_download, fake_normalize, fake_upload, normalize_calls = self._fakes()

        segments_worker.process_segment(
            row,
            tmp_root=self._tmp_root,
            download=fake_download,
            normalize_fn=fake_normalize,
            upload_fn=fake_upload,
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            probe_dims=lambda p: None,
        )

        # Declared aspect used as before.
        self.assertEqual(normalize_calls, [("seg-probefail", "9:16")])
        after = store.fetch_segment("seg-probefail")
        self.assertEqual(after["aspect"], "9:16")
        self.assertEqual(after["status"], "ready")

    def test_portrait_source_overrides_declared_landscape(self):
        # Symmetric to the landscape case — a portrait file uploaded
        # via a form stuck on 16:9 lands as 9:16 in the DB.
        row = self._insert_with_aspect("seg-port", "16:9")
        fake_download, fake_normalize, fake_upload, normalize_calls = self._fakes()

        segments_worker.process_segment(
            row,
            tmp_root=self._tmp_root,
            download=fake_download,
            normalize_fn=fake_normalize,
            upload_fn=fake_upload,
            set_status=store.set_segment_status,
            get_setting=store.get_setting,
            set_setting=store.set_setting,
            probe_dims=lambda p: (1080, 1920),
        )

        self.assertEqual(normalize_calls, [("seg-port", "9:16")])
        after = store.fetch_segment("seg-port")
        self.assertEqual(after["aspect"], "9:16")


class SeedActiveSegmentAspectTests(_SegmentsTestCase):
    """2026-06-15: store.init() seeds the per-aspect active slots from the
    pre-existing single active pointer so existing renders keep their branding
    without a manual migration. Idempotent and fill-if-empty; mirror of
    seedActiveSegmentAspect in lorewire-app/src/lib/db.ts."""

    def _insert_ready(self, seg_id: str, aspect) -> None:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        row = {
            "id": seg_id,
            "kind": "intro",
            "label": seg_id,
            "source_url": "https://example.test/s.mp4",
            "normalized_url": "https://example.test/s.norm.mp4",
            "duration_ms": 4000,
            "enabled": 1,
            "status": "ready",
            "error": None,
            "uploaded_at": None,
            "aspect": aspect,
            "created_at": now,
            "updated_at": now,
        }
        store.upsert_segment(row)

    def test_seeds_legacy_pointer_into_matching_aspect_slot(self):
        self._insert_ready("landscape", "16:9")
        store.set_setting("video.active_intro_id", "landscape")
        store._seed_active_segment_aspect()
        self.assertEqual(
            store.get_setting("video.active_intro_id_16x9"), "landscape"
        )
        # The other aspect's slot is untouched — they're independent.
        self.assertIsNone(store.get_setting("video.active_intro_id_9x16"))

    def test_null_aspect_legacy_row_seeds_the_9x16_slot(self):
        # A row predating the aspect column stores NULL; the seed coalesces it
        # to the legacy 9:16 floor, same as the resolver.
        self._insert_ready("legacy", None)
        store.set_setting("video.active_intro_id", "legacy")
        store._seed_active_segment_aspect()
        self.assertEqual(store.get_setting("video.active_intro_id_9x16"), "legacy")

    def test_does_not_overwrite_a_slot_the_admin_already_filled(self):
        self._insert_ready("old", "9:16")
        self._insert_ready("new", "9:16")
        store.set_setting("video.active_intro_id", "old")
        store.set_setting("video.active_intro_id_9x16", "new")  # explicit pick
        store._seed_active_segment_aspect()
        self.assertEqual(store.get_setting("video.active_intro_id_9x16"), "new")

    def test_dangling_legacy_pointer_is_skipped(self):
        # The legacy key names a deleted segment — seeding it would just point a
        # slot at a missing row, so the seed leaves the slots empty.
        store.set_setting("video.active_intro_id", "ghost")
        store._seed_active_segment_aspect()
        self.assertIsNone(store.get_setting("video.active_intro_id_9x16"))
        self.assertIsNone(store.get_setting("video.active_intro_id_16x9"))

    def test_is_idempotent(self):
        self._insert_ready("seg", "9:16")
        store.set_setting("video.active_intro_id", "seg")
        store._seed_active_segment_aspect()
        store._seed_active_segment_aspect()
        self.assertEqual(store.get_setting("video.active_intro_id_9x16"), "seg")


class SweepAbandonedTests(_SegmentsTestCase):
    def test_marks_old_pending_rows_as_error(self):
        old = "2026-06-10T00:00:00+00:00"
        new = "2026-06-11T12:00:00+00:00"
        self._insert("old-pending", status="pending", created_at=old)
        self._insert("new-pending", status="pending", created_at=new)
        self._insert("old-uploading", status="uploading", created_at=old)

        now = datetime.datetime(
            2026, 6, 11, 0, 30, tzinfo=datetime.timezone.utc
        )
        swept = segments_worker.sweep_abandoned(
            now=now,
            abandon_after_min=5,
            list_abandoned=store.list_abandoned_pending_segments,
            set_status=store.set_segment_status,
        )
        self.assertEqual(swept, 1)

        self.assertEqual(store.fetch_segment("old-pending")["status"], "error")
        self.assertIn(
            "abandoned",
            store.fetch_segment("old-pending")["error"].lower(),
        )
        # The new pending row is still in flight; do not touch.
        self.assertEqual(store.fetch_segment("new-pending")["status"], "pending")
        # Uploading rows are the worker's queue — never sweep them.
        self.assertEqual(store.fetch_segment("old-uploading")["status"], "uploading")


class TickTests(_SegmentsTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._tmp_root = Path(tempfile.mkdtemp(prefix="lw-segments-tick-test-"))
        self.addCleanup(_rmtree, self._tmp_root)

    def test_returns_false_when_queue_empty(self):
        called = {"download": 0, "normalize": 0, "upload": 0}
        def dl(u, p): called["download"] += 1
        def nm(s, o, sid, aspect="9:16"): called["normalize"] += 1; return {"duration_ms": 0}
        def up(p, k): called["upload"] += 1; return "u"
        processed = segments_worker.tick(
            tmp_root=self._tmp_root,
            abandon_after_min=5,
            download=dl,
            normalize_fn=nm,
            upload_fn=up,
        )
        self.assertFalse(processed)
        self.assertEqual(called, {"download": 0, "normalize": 0, "upload": 0})

    def test_returns_true_and_processes_when_queue_has_a_row(self):
        self._insert("tick1", status="uploading")
        def dl(u, p): p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b"x")
        def nm(s, o, sid, aspect="9:16"): o.write_bytes(b"y"); return {"duration_ms": 100}
        def up(p, k): return f"https://example.test/{k}"

        processed = segments_worker.tick(
            tmp_root=self._tmp_root,
            abandon_after_min=5,
            download=dl,
            normalize_fn=nm,
            upload_fn=up,
        )
        self.assertTrue(processed)
        self.assertEqual(store.fetch_segment("tick1")["status"], "ready")


# --- pure-helper coverage ----------------------------------------------------

class TruncateErrorTests(unittest.TestCase):
    def test_short_message_unchanged(self):
        self.assertEqual(segments_worker._truncate_error("ok"), "ok")

    def test_long_message_keeps_tail(self):
        msg = "x" * 5000 + "FINAL"
        out = segments_worker._truncate_error(msg)
        self.assertLessEqual(len(out), 500 + len("...\n"))
        self.assertTrue(out.endswith("FINAL"))
        self.assertTrue(out.startswith("...\n"))


# --- helpers ----------------------------------------------------------------

def _rmtree(p: Path) -> None:
    import shutil
    shutil.rmtree(p, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
