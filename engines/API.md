# libparity API

This document defines the public interface of every libparity engine, independent of
language. An engine is any implementation (the TypeScript reference, the Rust and C++
ports, future ports). `CONFORMANCE.md` defines how an engine is checked against the
reference; this document defines what a consumer may rely on.

Status: draft.

## Scope

Given the notes of one chart, an engine assigns a foot to every playable note and
derives per-row techs, errors and candles, and per-chart counts.

Out of scope:

- Parsing simfiles and computing timing. The consumer supplies each note's time in
  seconds (see [Timing](#timing)).
- Rendering and localisation. Codes come with English names and descriptions as
  defaults (see [Enumerations](#enumerations)); clients own any other text.
- Searching for alternative foot paths, editing weights, debug graphs. These are
  reference-only and unstable (see [Reference-only interfaces](#reference-only-interfaces)).

## Operations

| Operation | Input | Output |
|---|---|---|
| `analyze` | steps type, notes | an Analysis, or *none* |
| `analyzeCounts` | steps type, notes | Counts, or *none* |
| `isSupportedStepsType` | steps type | boolean |
| `SUPPORTED_STEPS_TYPES` | — | list of steps types |
| `stageLayout` | steps type | a StageLayout, or *none* when unsupported |
| `ENGINE_VERSION` | — | integer constant |

`analyze` is a pure function of its input. It analyzes the whole chart in one call.
It returns *none* when the steps type is unsupported or when no foot path exists, and
an empty Analysis (no rows, all counts zero) for a chart without playable notes. It
does not modify the input.

`analyzeCounts` returns only the `techCounts` and `techErrorCounts` of `analyze` on
the same input, and *none* exactly when `analyze` does. It is for charts where the
per-note output is not needed or too large, such as multi-hour mixes (see
[Resource use](#resource-use)).

Supported steps types: `dance-single` only. Engines contain a `dance-double` layout,
but nobody has tested libparity on doubles, so it is not supported: `analyze`
returns *none* and `stageLayout` returns *none* for it. Support is added by
listing it in `SUPPORTED_STEPS_TYPES` together with fixtures and corpus coverage
for it.

## Input: notes

A list of notes, **sorted by beat, then column**. Each note has:

| Field | Type | Meaning |
|---|---|---|
| `beat` | f64 | position in beats; the consumer's exact beat (ITGmania: row / 48) |
| `col` | int | column, `0 ≤ col < columnCount` of the steps type |
| `type` | NoteType | `Tap`, `Hold`, `Roll`, `Mine`, `Lift`, `Fake` |
| `second` | f64 | time of the note in seconds, see [Timing](#timing) |
| `hold` | f64 | `Hold` and `Roll` only: length in beats |
| `warped` | bool | optional, default false: the note lies in a warp |
| `fake` | bool | optional, default false: the note is fake (by type or by a fake segment) |
| `override` | FootOverride | optional: the foot the player wants on this note |
| `holdOverrides` | list of (beat, FootOverride) | optional, holds only, sorted by beat: the foot covering the hold from each beat onward |

FootOverride is `Left`, `Right` (either part of that foot) or one specific Foot.

Notes in the same column whose beats are equal to three decimals are treated as one
note and receive the same foot.

### Timing

`second` must be consistent within a chart: monotonic in beat outside warps, and
excluding the global offset and music rate, so results don't depend on player
preferences. The engine uses time differences between rows in its cost model, so two
consumers that compute seconds differently (float vs double, different timing
code) can get different results on charts that sit near a threshold or between two
paths of equal cost. Results are only guaranteed to match the reference when the
seconds match the reference's seconds bit for bit.

## Output: Counts

| Field | Type | Meaning |
|---|---|---|
| `techCounts` | list of int, indexed by TechCategory | dense, zeros included |
| `techErrorCounts` | list of int, indexed by TechError | dense, zeros included |

## Output: Analysis

| Field | Type | Meaning |
|---|---|---|
| `feet` | list of Foot, one per input note | in input order; `NONE` for mines, fakes and notes without a foot |
| `noteRows` | list of int, one per input note | index into `rows`; −1 when the note has no foot |
| `rows` | list of Row | every engine row, ascending by beat |
| `mineRows` | list of MineRow | beats with only mines that carry a tech (MD, and roll takeovers between rows), ascending by beat; not part of `rows` or `noteRows` |
| `holdOwnership` | list of (note index, timeline) | only holds whose covering foot changes mid-hold; timeline is a list of (beat, Foot) |
| `rollTaps` | list of (beat, second, column, Foot) | where a roll is taken as re-tapped between two rows (by the foot taking it over, or by the foot staying on it when the gap is a hole in the roll's stream), at the gap's midpoint, ascending by beat |
| `techCounts` | list of int, indexed by TechCategory | dense, zeros included |
| `techErrorCounts` | list of int, indexed by TechError | dense, zeros included |

A Row is a set of notes the player hits at the same time:

| Field | Type | Meaning |
|---|---|---|
| `beat` | f64 | the input beat of the row's notes |
| `second` | f64 | the input second of the row's notes |
| `techs` | set of TechCategory | an ascending list or a bitmask by value, depending on the language |
| `errors` | set of TechError | as `techs` |
| `candle` | Foot | `NONE` unless the row is a candle; then the foot that candles |
| `footColumns` | list of int, indexed by Foot (5 entries) | the column each foot part is planted on after this row (pressed, holding or resting), −1 when lifted; the `NONE` entry is always −1 |
| `angle` | f64 | the player's body angle after this row, in radians: `atan2(−dy, dx)` of the vector from the left foot to the right foot in stage coordinates (see StageLayout). 0 on the first row. |

A MineRow is a beat with mines and no notes the player hits. Its only tech is
`MD` (a mine dodge); a mine on a beat that also has notes labels that Row instead:

| Field | Type | Meaning |
|---|---|---|
| `beat` | f64 | the input beat of the mines |
| `second` | f64 | the input second of the mines |
| `techs` | set of TechCategory | as on a Row |

A foot that dodges a mine lifts off to the center (a ghost step): on the Row after the
mine its `footColumns` entries are −1.

Beats and seconds in the output are copied from the input, so a consumer can compare
them with its own values exactly.

Which panels a foot pressed on a row (as opposed to holding or resting) follows
from `feet` and `noteRows`. The occupant of a column is the foot part whose
`footColumns` entry is that column.

## StageLayout

The panel geometry the engine uses. Clients use it to classify techs by direction
(up/down footswitches) and to draw feet.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | the steps type |
| `columnCount` | int | |
| `layout` | list of (x, y, rotation), one per column | panel centre in stage units (dance-single: left (−1, 0), down (0, −1), up (0, 1), right (1, 0)); rotation in radians |
| `upArrows`, `downArrows`, `leftArrows`, `rightArrows`, `sideArrows` | list of column | panels by direction |

## Enumerations

The numeric values and codes are part of the API. Codes are stable identifiers, used
in serialized results and safe to store.

Every enumeration also has a table indexed by value whose entries carry the `code`,
an English `name` and an English `description` (one or two sentences on what the
value means). They are defaults: a client may show them, or use the code to look up
its own text. libparity does not localise them. Each table has a lookup from code to
value that returns *none* for an unknown code. The descriptions are the same in
every engine (the conformance API check compares them).

| Enumeration | Table | Lookup |
|---|---|---|
| Foot | `FOOT_INFO` | `footFromCode` |
| TechCategory | `TECH_INFO` | `techFromCode` |
| TechError | `TECH_ERROR_INFO` | `techErrorFromCode` |

**Foot**

| Value | Identifier | Code | English name |
|---|---|---|---|
| 0 | NONE | `.` | None |
| 1 | LEFT_HEEL | `L` | Left Heel |
| 2 | LEFT_TOE | `l` | Left Toe |
| 3 | RIGHT_HEEL | `R` | Right Heel |
| 4 | RIGHT_TOE | `r` | Right Toe |

**TechCategory**

| Value | Identifier | Code | English name |
|---|---|---|---|
| 0 | Crossovers | `XO` | Crossover |
| 1 | Footswitches | `FS` | Footswitch |
| 2 | Sideswitches | `SS` | Sideswitch |
| 3 | Jacks | `JA` | Jack |
| 4 | Brackets | `BR` | Bracket |
| 5 | Doublesteps | `DS` | Doublestep |
| 6 | Holdswitch | `HS` | Holdswitch |
| 7 | Jumps | `JU` | Jump |
| 8 | Brackettaps | `BT` | Bracket-tap |
| 9 | Stepjumps | `SJ` | Stepjump |
| 10 | Kickswitches | `KS` | Kickswitch |
| 11 | LateralCrossovers | `LX` | Lateral crossover |
| 12 | MineDodges | `MD` | Mine dodge |

**TechError**

| Value | Identifier | Code | English name |
|---|---|---|---|
| 0 | UnmarkedDoublestep | `DS` | Unmarked Doublestep |
| 1 | MissedFootswitch | `FS` | Mismarked Footswitch |
| 2 | Ambiguous | `AM` | Ambiguous Step |

New categories are appended. Appending changes the length of the dense count lists,
so consumers must index by value and not assume a fixed length.

## Versioning

- `ENGINE_VERSION` is an integer, equal in every engine at the same release. It
  increases whenever any output for the conformance corpus changes. Consumers store
  it next to anything they derive from an Analysis and recompute when it differs.
- The release version (semver) covers this interface. Adding a field or an
  enumeration value is minor; removing or renaming one is major.
- One release tag covers all engines. Every engine at a tag conforms to the reference
  at that tag.

## Resource use

Time grows roughly linearly with the number of rows, but the per-row cost varies a lot
between charts. Consumers that analyze charts on a latency-sensitive thread (a game
loop, an editor UI) should run `analyze` elsewhere.

The search settles a row's foot placement once it is 128 rows past it (the traceback
window) and drops every alternative that disagrees there. The result equals an
unbounded search unless the cheapest path through a row changes more than 128 rows
later; this does not happen on the conformance corpus, where the longest such change
is 45 rows. Exact ties are broken the same way either way.

So the search state is bounded by the window. `analyze` still grows with the chart:
it keeps every row and returns per-note and per-row output. `analyzeCounts` keeps only
the window, so beyond the input notes its memory does not grow with chart length
(TypeScript: about 4 MB for a ten-hour, 210,000-note mix, against about 500 MB for
`analyze`).

## Reference-only interfaces

The reference engine also exposes incremental recompute over a beat range, debug data
(the search graph, node costs, timings), weight overrides and the internal state
types. They exist for the editor and for engine development, have no stability
guarantee, and ports do not implement them.

The one reference-only interface with a defined shape is the editor session
(TypeScript `ParitySession`): `new ParitySession(stepsType)`, then
`update(notes, startBeat?, endBeat?)`, which returns the Analysis of the whole chart
while recomputing only the rows in the given beat range. The first call must cover
the whole chart (the default). Its result equals `analyze` on the same notes. Its
`internals` give the debug data and are unstable.

## Client coverage

What each known client uses, and what the interface above does not cover yet.

| Client | Engine | Uses | Not covered |
|---|---|---|---|
| arrow-cloud | TS | `analyze`, `isSupportedStepsType`, tech codes, counts | — |
| deadsync | Rust | `analyze`, `ENGINE_VERSION`, `feet`, `noteRows`, `rows`, counts | — |
| ITGmania | C++ | `analyze`, `ENGINE_VERSION`, `feet` and `noteRows` (Lua `whereTheFeetAre`: the feet on the row's notes), `rows`, `stageLayout` (up/down footswitch split) | — |
| smeditor | TS | `ParitySession`, `footColumns` and `angle` (dancing bot, facing timeline), `stageLayout`, overrides, code tables with their English names and descriptions | — (its debug overlay uses `ParitySession.internals`, as intended) |

## Language bindings

Names follow each language's conventions. Current names:

| Concept | TypeScript | Rust | C++ |
|---|---|---|---|
| analyze | `analyze(stepsType, notes)` → `ParityAnalysis \| null` | `analyze(steps_type, &notes)` → `Option<ParityAnalysis>` | `parity::analyze(stepsType, notes)` → `std::optional<ParityAnalysis>` |
| analyzeCounts | `analyzeCounts(stepsType, notes)` → `TechCounts \| null` | `analyze_counts(steps_type, &notes)` → `Option<TechCounts>` | `parity::analyzeCounts(stepsType, notes)` → `std::optional<TechCounts>` |
| stageLayout | `stageLayout(stepsType)` → `StageLayout \| null` | `stage_layout(steps_type)` → `Option<StageLayout>` | `parity::stageLayout(stepsType)` → `const StageLayout*` |
| row fields | `footColumns: number[]`, `angle` | `foot_columns: [i8; 5]`, `angle` | `std::array<int, 5> footColumns`, `angle` |
| code tables | `FOOT_INFO`, `TECH_INFO`, `TECH_ERROR_INFO`: `CodeInfo[]` | same names: `[CodeInfo; N]` | same names: `CodeInfo[N]` |
| code lookups | `footFromCode`, `techFromCode`, `techErrorFromCode` → value or `null` | `foot_from_code`, `tech_from_code`, `tech_error_from_code` → `Option` | `footFromCode`, `techFromCode`, `techErrorFromCode` → `std::optional<int>` |
| enumeration sizes | `TECH_CATEGORY_COUNT`, `TECH_ERROR_COUNT` | same names | `TechCategoryCount`, `TechErrorCount` |
| note | `NotedataEntry`; overrides under `parity.override`, `parity.holdOverrides` | `NotedataEntry` | `parity::NotedataEntry` |
| row techs, errors | ascending `TechCategory[]` | `BitSet` | `uint32_t` bitmask (`techs >> category & 1`) |
| import | `import { analyze } from "libparity"` | `use libparity::analyze` | `#include <libparity/libparity.h>`, CMake target `libparity::libparity` |
