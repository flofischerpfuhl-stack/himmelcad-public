from __future__ import annotations

import base64
import csv
import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[2]
PACKAGER = ROOT / "scripts/package-staged-python-wheel.py"


class PackageStagedPythonWheelTest(unittest.TestCase):
    def test_output_is_deterministic_and_record_is_complete(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hcad-wheel-packager-") as temporary:
            root = Path(temporary)
            site = root / "site-packages"
            package = site / "sample"
            dist_info = site / "sample-1.0.dist-info"
            package.mkdir(parents=True)
            dist_info.mkdir()
            (package / "__init__.py").write_text("VALUE = 1\n", encoding="utf-8")
            (site / "native.pyd").write_bytes(b"MZ\x00fixture")
            (dist_info / "METADATA").write_text(
                "Metadata-Version: 2.1\nName: sample\nVersion: 1.0\n",
                encoding="utf-8",
            )
            first = root / "first.whl"
            second = root / "second.whl"
            for output in (first, second):
                subprocess.run(
                    [
                        sys.executable,
                        str(PACKAGER),
                        "--site-packages",
                        str(site),
                        "--package",
                        "sample",
                        "--module",
                        "native.pyd",
                        "--dist-info",
                        "sample-1.0.dist-info",
                        "--tag",
                        "cp312-cp312-win_amd64",
                        "--output",
                        str(output),
                    ],
                    check=True,
                )
            self.assertEqual(first.read_bytes(), second.read_bytes())

            with zipfile.ZipFile(first) as wheel:
                names = wheel.namelist()
                self.assertEqual(names, sorted(names))
                self.assertTrue(all(info.date_time == (2026, 1, 1, 0, 0, 0) for info in wheel.infolist()))
                record_name = "sample-1.0.dist-info/RECORD"
                rows = list(csv.reader(wheel.read(record_name).decode("utf-8").splitlines()))
                self.assertEqual(rows[-1], [record_name, "", ""])
                for name, declared_hash, declared_size in rows[:-1]:
                    data = wheel.read(name)
                    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
                    self.assertEqual(declared_hash, f"sha256={digest.decode('ascii')}")
                    self.assertEqual(declared_size, str(len(data)))

    def test_rejects_paths_outside_the_staging_root(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hcad-wheel-packager-invalid-") as temporary:
            site = Path(temporary) / "site-packages"
            dist_info = site / "sample-1.0.dist-info"
            dist_info.mkdir(parents=True)
            result = subprocess.run(
                [
                    sys.executable,
                    str(PACKAGER),
                    "--site-packages",
                    str(site),
                    "--package",
                    "../escape",
                    "--dist-info",
                    "sample-1.0.dist-info",
                    "--tag",
                    "py3-none-any",
                    "--output",
                    str(Path(temporary) / "invalid.whl"),
                ],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unsafe staged package name", result.stderr)


if __name__ == "__main__":
    unittest.main()
