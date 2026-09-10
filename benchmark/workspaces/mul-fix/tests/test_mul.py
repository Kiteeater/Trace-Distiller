"""Verify mul(3, 3) == 9. Workspace starts broken so L4 replay must fix mul.ts.

Plain Python (no pytest). Exit 0 on pass, 1 on fail.
Manifest verify: ["python3", "tests/test_mul.py"]
"""

from __future__ import annotations

from pathlib import Path
import sys


def load_mul_result(a: int, b: int) -> int:
    src = Path(__file__).resolve().parents[1] / "mul.ts"
    text = src.read_text(encoding="utf-8")
    if "a * b" in text:
        return a * b
    if "a + b" in text:
        return a + b
    raise AssertionError(f"unrecognized mul.ts body:\n{text}")


def main() -> int:
    got = load_mul_result(3, 3)
    if got != 9:
        print(f"FAILED test_mul: expected 9 got {got}", file=sys.stderr)
        return 1
    print("===== 1 passed =====")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
