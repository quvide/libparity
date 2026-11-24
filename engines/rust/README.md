# libparity (Rust port)

A Rust port of the batch path of the TypeScript engine in `engines/typescript/src/`
(`ParityInternals.computeBatch()` and everything it calls). The TS engine is the
reference; `engines/CONFORMANCE.md` is the spec.

- `libparity/`: the engine, no dependencies. One module per TS file, same
  function names in snake_case, same order of operations. `js.rs` holds the JS
  number semantics the engine depends on (`toFixed`, `Math.round`, `Math.max/min`,
  truthiness of sparse-array numbers).
- `conform-port/`: the `libparity-port` binary implementing the port protocol
  (cases as NDJSON on stdin, one result per line on stdout, in completion order).
  `format.rs` mirrors `engines/typescript/conformance/format.ts`. `-j N` sets the worker threads
  (default: all cores).

Not ported: incremental `compute()`, edge caches, debug data, `setWeights`.

## Build

```sh
cd engines/rust
cargo build --release
cargo test --release
```

`engines/rust/run` builds when needed and runs `libparity-port`.

## Use

```toml
libparity = { git = "...", package = "libparity" }  # or path = ".../engines/rust/libparity"
```

```rust
let analysis = libparity::analyze("dance-single", &notes)?;  // None: unsupported or no path
analysis.feet;        // per input note
analysis.note_rows;   // per input note, index into rows
analysis.rows;        // beat, second, tech and error bits, candle, foot_columns, angle
analysis.mine_rows;   // mine-only beats that carry a tech (MD)
analysis.tech_counts; // indexed by TechCategory
```

`libparity::ENGINE_VERSION` changes whenever results change; fold it into cache keys.

## Check

From the repository root:

```sh
./run.py check rust --out corpus/rust.ndjson.gz
```

Expected: `4686/4686 agree`. A subset:

```sh
zcat corpus/inputs.ndjson.gz | head -50 | gzip > corpus/in50.gz
zcat corpus/reference.ndjson.gz | head -50 | gzip > corpus/ref50.gz
./run.py check rust --in corpus/in50.gz --ref corpus/ref50.gz --out corpus/rust50.ndjson.gz
```

## Porting notes

- State keys are packed structs equal exactly when the TS `toKey()` strings are
  equal within a row (the row key is shared by every state of a row, so it is
  left out, and so are row ids).
- Ties in the search go to the path whose states sort first where the paths
  split (`compare_states`); its field order must match the TS `compareStates`.
  Node creation order does not decide results.
- `movedFeet` keeps `Set` insertion order: the footswitch/sideswitch label takes
  the first matching foot.
- The initial state's empty `action`/`combinedColumns` read as `UNDEFINED_FOOT`,
  which equals only itself, like `undefined`.
- `Math.pow` and `Math.atan2` use the platform libm; V8 uses fdlibm ports, which
  may differ in the last ulp. No case in the corpus is affected.
