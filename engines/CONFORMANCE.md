# Conformance

The TypeScript engine in `engines/typescript/src/` is the reference. A port (Rust, C++, ...) conforms
when it produces the same result as the reference for every case in the corpus.

## Workflow

```sh
./run.py corpus extract ~/Songs ~/MorePacks  # corpus/inputs.ndjson.gz
./run.py corpus reference                    # corpus/reference.ndjson.gz
./run.py check rust                          # build and run engines/rust/run, diff against the reference
./run.py corpus diff expected.ndjson actual.ndjson  # diff two result files
./run.py test                                # typecheck, fixtures, every port's API and corpus check, counts checks
```

`./run.py -h` lists the commands. They use the host's toolchains;
`container/run.py` takes the same arguments and runs them in a container
(podman or docker) that has every dependency. Each run is logged to `.logs/`.
Each port has a `run` script that builds it when needed and speaks the port
protocol.

Rerun `corpus reference` after every engine change. It uses `computeBatch()`
(the default; `--incremental` uses `compute()`), which gives the same result as `compute()` with far less memory and
is the only way to cover marathon charts. After an engine change, confirm that
the two still agree (`./run.py corpus reference --incremental --out corpus/incremental.ndjson.gz`,
then `corpus diff`). Cases that exceed the
per-worker heap (`--heap`, `-j`) are retried one at a time with most of the
machine's memory. A case that still fails is recorded as `{"id", "error"}` and
skipped by `diff`. The corpus is built from local song
folders and is not committed. `./run.py shell tsx engines/typescript/conformance/cli.ts check -- tsx engines/typescript/conformance/cli.ts serve` runs
the reference through the port protocol and must always agree.

`./run.py test` also checks `analyzeCounts` in every engine (`counts-ts`,
`counts-<port>`): its counts must equal the reference's counts for every case.

## Public API

`API.md` defines the interface every engine exposes. The result format below is
a serialization of its Analysis.

`ENGINE_VERSION` is the same constant in every engine (the API check below
compares it). Bump it in all three with any change that alters an engine's Analysis
on the corpus, so consumers can tell when stored results are stale.

## Port protocol

A port is an executable that reads cases from stdin, one JSON object per line, and
writes one result line per case to stdout, in any order. Stderr is free for logging.
It exits 0 when every case was processed. Files ending in `.gz` are gzipped NDJSON.

Run with `--counts`, a port computes `analyzeCounts` instead of `analyze` and writes
a result with only `id`, `counts` and `errorCounts` (or `{"id", "noPath": true}`).
`conformance check --counts` runs a port this way and compares only those fields.

Run with `--describe`, a port instead prints one JSON object describing its public
API: `ENGINE_VERSION`, the supported steps types, the code tables and code lookups,
the stage layouts and `analyze` and `analyzeCounts` on an unsupported and an empty chart, all for a
fixed set of probes (`engines/typescript/conformance/describe.ts`). `conformance check-api`
compares it with the reference's, value by value; `./run.py test` and
`./run.py check` run it for every port.

## Case

```json
{"id": "pack/song/song.ssc#2:Hard", "stepsType": "dance-single",
 "notes": [{"beat": 4, "col": 0, "type": "Tap", "second": 1.875},
           {"beat": 4.5, "col": 2, "type": "Hold", "second": 2.0625, "hold": 1.5},
           {"beat": 6, "col": 1, "type": "Mine", "second": 2.8125, "fake": true}]}
```

- `stepsType` is a supported steps type (`dance-single`). A case with any other
  steps type is an error.
- `notes` are sorted by beat, then column. Seconds are precomputed, so a port never
  needs timing data.
- `type`: `Tap`, `Hold`, `Roll`, `Mine`, `Lift`, `Fake`. `hold` (beats) is present on
  `Hold` and `Roll`.
- Optional, absent when false or unset: `warped`, `fake`, `override` (`"Left"`, `"Right"`
  or a foot 1-4), `holdOverrides` (`[{beat, foot}]`, sorted by beat).
- Numbers are IEEE doubles and must be parsed exactly. All engine arithmetic is f64.
- The reference computes the whole chart: `compute(-1, lastBeat + 4, notes)`, where
  `lastBeat` is the largest `beat + hold`.

## Result

```json
{"id": "pack/song/song.ssc#2:Hard", "feet": "LR.", "rowCount": 2,
 "rows": [[4, [], ["AM"]]], "mineRows": [], "holdOwnership": [], "candles": [],
 "stance": "0...0.2.", "angleChecksum": -1.5707963267948966, "counts": {},
 "errorCounts": {"AM": 1}}
```

- `feet`: one character per input note, in input order. `L` left heel, `l` left toe,
  `R` right heel, `r` right toe, `.` no foot (mines, fakes, unassigned notes).
  Notes in the same column whose beats round to the same `toFixed(3)` share one label.
- `rowCount`: number of engine rows.
- `rows`: `[beat, techs, errors]` for each row that has a tech or an error, by beat.
  Techs (`XO FS SS JA BR DS HS JU BT SJ KS LX MD`) and errors (`DS FS AM`) are in category
  order.
- `mineRows`: `[beat, techs]` for each beat that has only mines and carries a tech
  (`MD`), by beat. Not counted in `rowCount`, `stance` or `angleChecksum`.
- `holdOwnership`: `[noteIndex, [[beat, foot], ...]]` for holds whose covering foot
  changes mid-hold.
- `candles`: `[beat, foot]` for each candle row, by beat.
- `stance`: four characters per row, in row order, one per foot part (`L l R r`):
  the part's `footColumns` entry in base 36, `.` when lifted.
- `angleChecksum`: the sum over rows of `(rowIndex + 1) * angle`, accumulated in row
  order in f64 (exact, so ports must not contract it into FMA).
- `counts`, `errorCounts`: totals by name, zero counts omitted.
- When no foot path exists: `{"id", "noPath": true}` with the other fields empty.

Beats in the result are the input beats, so they compare exactly.

## Not covered

Incremental recompute, debug data and weight overrides are reference-only APIs.
Timing is out of scope: the case carries seconds, so a consumer that computes its
own seconds must match the reference timing separately.
