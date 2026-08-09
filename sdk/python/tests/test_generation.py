from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SDK_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SDK_ROOT.parents[1]
GENERATOR = REPOSITORY_ROOT / "scripts/generate-automation-sdk.py"
SCHEMA = REPOSITORY_ROOT / "schemas/automation/himmelcad-automation-v1.schema.json"
FIXTURE = REPOSITORY_ROOT / "schemas/automation/fixtures/automation-wire-v1.json"

sys.path.insert(0, str(SDK_ROOT / "src"))

from himmelcad.models import (  # noqa: E402
    AppProtocolRequestEnvelope,
    CanonicalCommandTransaction,
    ScreenshotRequestV1,
    ScreenshotResultV1,
    ViewStateV1,
)


class GenerationTests(unittest.TestCase):
    def test_generated_tree_is_current(self) -> None:
        subprocess.run([sys.executable, str(GENERATOR), "--check"], cwd=REPOSITORY_ROOT, check=True)

    def test_contract_shape_pin_fails_closed(self) -> None:
        schema = json.loads(SCHEMA.read_text())
        path = next(iter(schema["contractSourcePins"]))
        schema["contractSourcePins"][path] = "0" * 64
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            altered = temporary_path / "schema.json"
            altered.write_text(json.dumps(schema))
            result = subprocess.run([sys.executable, str(GENERATOR), "--schema", str(altered), "--output", str(temporary_path / "sdk")], cwd=REPOSITORY_ROOT, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("canonical contract shape drifted", result.stderr)

    def test_shared_wire_fixture_round_trips_exactly_in_python(self) -> None:
        fixture = json.loads(FIXTURE.read_text())
        cases = (
            (CanonicalCommandTransaction, "canonicalTransaction"),
            (AppProtocolRequestEnvelope, "appRequestEnvelope"),
            (ViewStateV1, "viewState"),
            (ScreenshotRequestV1, "screenshotRequest"),
            (ScreenshotResultV1, "screenshotResult"),
        )
        for model, key in cases:
            with self.subTest(model=model.__name__):
                self.assertEqual(model.from_dict(fixture[key]).to_dict(), fixture[key])

    def test_view_clips_and_screenshot_storage_variants_fail_closed(self) -> None:
        fixture = json.loads(FIXTURE.read_text())
        view = fixture["viewState"]
        view["scopedClips"] = [
            {
                "id": "section",
                "enabled": True,
                "scope": {"kind": "entities", "entityIds": ["mesh-1"]},
                "primitive": {
                    "kind": "plane",
                    "normal": {"x": 0.0, "y": 0.0, "z": 1.0},
                    "constant": 12.5,
                    "keep": "positive",
                },
            }
        ]
        self.assertEqual(ViewStateV1.from_dict(view).to_dict(), view)

        invalid_scope = json.loads(json.dumps(view))
        invalid_scope["scopedClips"][0]["scope"] = {
            "kind": "all",
            "entityIds": ["mesh-1"],
        }
        with self.assertRaisesRegex(ValueError, "invalid ClipScope variant"):
            ViewStateV1.from_dict(invalid_scope)

        invalid_primitive = json.loads(json.dumps(view))
        invalid_primitive["scopedClips"][0]["primitive"]["center"] = {
            "x": 0.0,
            "y": 0.0,
            "z": 0.0,
        }
        with self.assertRaisesRegex(ValueError, "invalid ClipPrimitive variant"):
            ViewStateV1.from_dict(invalid_primitive)

        screenshot = fixture["screenshotResult"]
        screenshot["lease"] = {
            "leaseId": "lease",
            "accessToken": "opaque",
            "contentHash": "a" * 64,
            "mediaType": "image/png",
            "elementType": "bytes",
            "shape": [8],
            "endianness": "notApplicable",
            "byteLength": 8,
            "expiresAt": "2099-01-01T00:00:00Z",
            "maxReadableRange": 8,
            "remainingReadBudget": 8,
            "readOnly": True,
        }
        with self.assertRaisesRegex(ValueError, "invalid ScreenshotResultV1 variant"):
            ScreenshotResultV1.from_dict(screenshot)


if __name__ == "__main__":
    unittest.main()
