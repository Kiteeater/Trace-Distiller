"""Verify add(1, 1) == 2. Workspace starts broken so L4 replay must fix add.ts.

Plain Python (no pytest) so CI / local machines without pytest still verify.
Exit 0 on pass, 1 on fail. Manifest verify: ["python3", "tests/test_add.py"]
"""

from __future__ import annotations

from pathlib import Path
import sys


def load_add_result(a: int, b: int) -> int:
    src = Path(__file__).resolve().parents[1] / "add.ts"
    text = src.read_text(encoding="utf-8")
    if "a + b" in text:
        return a + b
    if "a - b" in text:
        return a - b
    raise AssertionError(f"unrecognized add.ts body:\n{text}")


def main() -> int:
    got = load_add_result(1, 1)
    if got != 2:
        print(f"FAILED test_add: expected 2 got {got}", file=sys.stderr)
        return 1
    print("===== 1 passed =====")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
