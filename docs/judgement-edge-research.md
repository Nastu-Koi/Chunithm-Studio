# Native judgement edge cases

This investigation reads the local game files and PE instructions without launching or modifying the game. Counts from C2S headers are comparison evidence, never inputs to the generated judgement timeline. No rule is accepted solely because it makes one total agree.

## Reproduction

Run `node --import tsx out/judgement-edge-research/probe.ts` from the repository. `CHUNI_GAME_ROOT` can replace the default `/mnt/d/chunithm`. The script writes per-note, per-point, collision and header comparisons for four original charts under `out/judgement-edge-research/`. The original C2S files remain outside the repository.

All chart paths are `data/A000/music/music<ID>/<ID>_<difficulty>.c2s` relative to the game directory.

| Chart | Original SHA-256 | Initial discrepancy |
| --- | --- | --- |
| 2477_01 | `1792a1bb85799b5fa0d54a9c46668c5c5bcb8870cb52ec1c77c06399f4c462dd` | TAP 452 versus 456 |
| 0050_00 | `aee857274e2d14b133f9f3b89381debd74149e8c6a74940ef88738d11a7e2c51` | HLD 37 versus 8; AIR 132 versus 115 |
| 2033_03 | `85f89fa0dcfc97ebe9040ae6ee43835065cc3795dfbc1c1aa39de0c45fd1c3c9` | AIR 781 versus 780 |
| 2652_02 | `48d4a3d8426e113cbebc8a6a67902aafd9e5eed937ad4bab974d541099be5e9c` | AIR 802 versus 801 |

The baseline above predates the separate ScoreReader-order SLIDE correction. That correction resolves the SLIDE category independently and must not be replaced by compensating TAP/AIR counts.

## Tutorial 0050_00

The chart contains `TUTORIAL 1`, BPM 120, and six zero-speed SFL ranges. Its two HOLDs without an attached AIR each yield four HLD points; those eight match the header. The nine HOLDs with AIR/AHD attachments supply the other 29 HLD points under ordinary rules.

A single AIR HOLD crosses `SFL 78 192 864 0`. The strict interior of that interval contains 17 continuation points at the native 48-tick spacing. Including either endpoint gives 18, including both gives 19. Removing only the strict interior would reduce AIR 132 to 115. This numerical observation is now supported by a separate executable branch, described below; it is not by itself the basis for a rule.

### Native instruction evidence

The local executable is `bin/chusanApp.exe` (PE32, image base `0x400000`). Addresses below are virtual addresses. Disassembly is saved locally in `out/judgement-edge-research/score-region.asm` and was obtained with `objdump -d -Mintel`, never by running the program.

- Header reader `0x11fc440` dispatches tags through the table at `0x11fc5b4`. Tag 12 (`TUTORIAL`) reaches `0x11fc59e`; `0x11fc5ac` writes `(parsedInteger > 0)` to the chart byte at `+0xcc`. Neighboring PROGJUDGE_BPM and PROGJUDGE_AER values occupy `+0xc4` and `+0xc8`.
- `0x407c11` is a jump thunk to `0x11fb740`. This helper selects key 0 from the chart map at `+0xe8` when called with its first argument 0. It scans records of 32 bytes. It returns true only when record start (`+0x08`) is strictly below the supplied time, time is strictly below record end (`+0x1c`), and the value at `+0x10` is exactly zero. Both equality endpoints return false. The SFL registration at `0x52be95..0x52be9a` assigns tag 16. The dispatch table at `0x11fc1d8` sends tag 16 to `0x11fbf24`, which reads value field 4, computes `start + duration`, and passes key 0 to the insertion helper at `0x11fe350`. Its container offset is event-base `+0x18`; the caller at `0x11fbac1` passes chart `+0xd0`, establishing the same chart `+0xe8` map.
- At `0x11f3c7e..0x11f3d01`, a nonzero tutorial byte enables two loops over a note root's vectors at `+0x15c` and `+0x16c`. Each loop passes its point time to that helper with key 0 and clears the point's enabled byte at `+0x14` when true. Thus the strict-open interval behavior is explicit, not an inferred rounding convention.
- At `0x11f3822..0x11f385d`, roots whose attached type at `+0x14` is 3, 5 or 8 enter a tutorial branch that clears every enabled byte in the `+0x15c` vector, regardless of point time. The mapping is verified by `0x1200930`: it reads the family table at `0x1c26be4 + tagIndex * 16`. Tag names are stored at `0x1c26bdc + tagIndex * 16`; AIR/AUR/AUL/ADW/ADR/ADL map to 3, AHD/AHX to 5, and ASD/ASC to 8. The decoded table and executable SHA-256 are in `out/judgement-edge-research/native-tag-types.json`.

The ordinary rules also use these vectors for the existing AIR release window. The tutorial branch must be applied to the same native parent root; it must not suppress all HOLDs, all AIRs, or every event under zero scroll when `TUTORIAL` is zero.

## 2477_01

The native headers separate `T_NUM_TAP = 250` and `T_NUM_CHR = 206`, summing to the expected TAP category 456. Current explicit heads and reconstructed ground roots yield ordinary 249 and EX 203: the unexplained difference is one ordinary head and three EX heads.

There are two two-input/two-output geometric SLIDE joins, one ordinary and one EX. Turning all four outgoing segments into new roots would produce two ordinary and two EX extra heads, so that explanation is rejected. Native-order root reconstruction still produces 72 roots while `T_NOTE_SLD` records 76; its SLIDE continuation total already agrees at 611. No extra heads have been synthesized to match the header.

## 2033_03 and 2652_02

Current AIR decomposition:

| Chart | Heads | Visible ends | Sustains | CRUSH | Total / header |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2033_03 | 395 | 158 | 158 | 70 | 781 / 780 |
| 2652_02 | 161 | 55 | 476 | 110 | 802 / 801 |

Both charts contain deliberate overlapping explicit AIRs and AIR SLIDE branches. A geometry-only deduplication would remove many points, not one: the probe records 39 and 29 tick/lane/width collision groups respectively. Even equal height and kind do not isolate one duplicate. Generic deduplication is rejected.

2033_03 has two distinct CRUSH paths ending at the same 3D point, but 2652_02 has no corresponding duplicated CRUSH endpoint. Removing that endpoint would explain only one chart and is not justified. Invisible `NON` CRUSH segments also contribute deliberate stacks in 2652_02; suppressing invisible or stationary CRUSH points is not supported.

### Resolved mechanism: ground-root order

The native reader stores AIR continuations on their original ground note root and searches roots in ground creation order. It does not order candidates by AIR head time or by when a shape endpoint entered a queue. This is independently visible in the AIR reader: AHD continuation at `0x11fd940`, initial ASD attachment at `0x11fdc57`, and ASD continuation search at `0x11fdcf2..0x11fdd68`. The latter checks the current last segment's time, lane, width, height and normal/control flag, then advances by the root stride `0x178`. It has no color comparison.

In 2033_03, `SLD 70 0 4 4 1 9 4 SLD` creates a ground root before `TAP 70 0 9 4`. The first root's ASC begins at 70:1 while the second begins at 70:0. Both reach 70:96 at lane 9, width 4, height 5. The native reader connects the first outgoing ASC to the older SLIDE ground root, preserving its one-tick phase difference. The old AIR-first ordering assigned it to the TAP root. The native connection produces 157 sustained points instead of 158, leaving heads, visible ends and CRUSH unchanged.

In 2652_02, two identical HXD roots at 38:0 carry identical ASC starts at 38:1. One path has normal joints and the other stays all-control. Their paths meet at 44:336. Keeping the original root order across that meeting, instead of the latest endpoint insertion order, produces 475 sustained points instead of 476. Identical source text on the first records does not imply the roots are interchangeable: their earlier normal joints establish different continuation phases.

The independent experiment `out/judgement-edge-research/air-corpus.ts` follows these executable conditions and compares all 8,193 enabled charts with stored AIR statistics. Result: **8,193 / 8,193 match, zero missing parents, zero regressions**. The only changed charts are 2033_03 (781 → 780) and 2652_02 (802 → 801). It reuses the previous CRUSH counts; no CRUSH, head or endpoint deduplication was introduced. Complete output: `out/judgement-edge-research/air-corpus.json`.

`tests/judgement-edge-research.test.ts` adds two original minimal charts: an older ground root whose AIR starts later, and unequal paths that rejoin in a different endpoint-arrival order. The expected values follow native root order; no statistics are present in the fixtures. It also checks all categories for the three native tutorial/AIR charts, then removes every `T_` statistic and verifies the calculated counts stay identical. The test file passed after the common root reader was integrated.

## Current result and limits

0050_00, 2033_03 and 2652_02 now match every original category. The independent AIR experiment is complete. The original executable was neither launched nor injected, so this is a static native-code and corpus validation, not an actual game playthrough.

2477_01 still has four unexplained TAP judgements. The native time comparison at `0x11e8e90` compares normalized time with a two-native-clock-unit tolerance; the normalization routine at `0x11fb220` rounds to the native grid. These do not establish four missing roots. Native ground-root reconstruction still gives 72 geometric SLIDE roots; its continuation category is already correct. An authoring-time chain boundary lost in serialized geometry, or an outdated header, would be possible explanations, but neither is proven. The implementation keeps the discrepancy visible rather than inserting four heads.

