"""Image-output safety for user submissions (Phase 4 of
_plans/2026-06-29-user-submitted-stories.md). A flagged generated image must halt
the render; the check must fail CLOSED when it cannot run."""

import json
import unittest
import urllib.error
from unittest import mock

from pipeline import image_safety


def _resp(payload: dict):
    """A fake urlopen context manager returning the JSON payload."""
    cm = mock.MagicMock()
    cm.__enter__.return_value.read.return_value = json.dumps(payload).encode("utf-8")
    return cm


class CheckImagesSafeTests(unittest.TestCase):
    def setUp(self) -> None:
        patch_key = mock.patch.object(image_safety.config, "env", return_value="sk-test")
        patch_key.start()
        self.addCleanup(patch_key.stop)

    def test_empty_list_is_a_noop(self) -> None:
        with mock.patch.object(image_safety.urllib.request, "urlopen") as uo:
            image_safety.check_images_safe([])
            uo.assert_not_called()

    def test_clean_images_pass(self) -> None:
        payload = {"results": [{"flagged": False, "categories": {}}]}
        with mock.patch.object(
            image_safety.urllib.request, "urlopen", return_value=_resp(payload)
        ):
            image_safety.check_images_safe(["https://img/1.png"])  # no raise

    def test_flagged_image_raises(self) -> None:
        payload = {"results": [{"flagged": True, "categories": {"violence": True}}]}
        with mock.patch.object(
            image_safety.urllib.request, "urlopen", return_value=_resp(payload)
        ):
            with self.assertRaises(image_safety.ImageSafetyError):
                image_safety.check_images_safe(["https://img/bad.png"])

    def test_api_error_fails_closed(self) -> None:
        with mock.patch.object(
            image_safety.urllib.request,
            "urlopen",
            side_effect=urllib.error.URLError("down"),
        ):
            with self.assertRaises(image_safety.ImageSafetyError):
                image_safety.check_images_safe(["https://img/1.png"])

    def test_missing_key_fails_closed(self) -> None:
        with mock.patch.object(image_safety.config, "env", return_value=""):
            with self.assertRaises(image_safety.ImageSafetyError):
                image_safety.check_images_safe(["https://img/1.png"])


if __name__ == "__main__":
    unittest.main()
