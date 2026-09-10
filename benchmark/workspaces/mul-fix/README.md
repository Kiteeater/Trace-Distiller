# mul-fix replay workspace

Tiny real repo for a second L4 fixture (product of two numbers).

- Starts **broken**: `mul.ts` uses `a + b`.
- Task: fix so `3*3` equals `9`, then pass `tests/test_mul.py`.
- Not yet mapped to a bench track sample; available for future traces / manual mint smoke.
- Fake L4 heal: `applyFakeReplayHeal` also rewrites `a + b` → `a * b` in `mul.ts`.
