# libparity C++ port

A C++17 port of the batch path of the TypeScript engine in `engines/typescript/src`
(`ParityInternals.computeBatch()` and everything it calls). It has no
dependencies. The incremental `compute()`, edge caches, debug data and
`setWeights` are not ported.

- `include/libparity/`: the headers, one per TS file, with the same names and
  order of operations. `JsCompat` holds the JS number semantics the engine
  depends on (`toFixed`, `Math.round`, NaN-aware `Math.min/max`, `undefined`
  reads from sparse arrays). `libparity.h` includes everything.
- `src/`: the sources of the `parity` static library (`libparity::libparity`).
- `tools/`: `parity-conform`, which implements the port protocol in
  `CONFORMANCE.md`. `Format.cpp` mirrors `engines/typescript/conformance/format.ts`.

## Build

```sh
cmake -S engines/cpp -B engines/cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build engines/cpp/build -j
```

`engines/cpp/run` does this when needed (in `$CPP_BUILD_DIR`, default
`engines/cpp/build/<OS>-<arch>`) and runs `parity-conform`.

Set `-DLIBPARITY_BUILD_CONFORM=OFF` to build only the library.

## Use

```cmake
add_subdirectory(path/to/libparity/engines/cpp libparity)
target_link_libraries(game PRIVATE libparity::libparity)
```

```cpp
#include <libparity/libparity.h>

auto analysis = parity::analyze("dance-single", notes);
if (analysis) {
  analysis->feet;        // per input note
  analysis->noteRows;    // per input note, index into rows
  analysis->rows;        // beat, second, tech and error bits, candle, footColumns, angle
  analysis->techCounts;  // indexed by TechCategory
}
```

`engines/API.md` defines the interface. `notes` are sorted by beat, then column, with columns inside the layout.
`analyze` returns `std::nullopt` for an unsupported steps type or when no foot
path exists; a chart without steps gives an empty analysis. It throws only
where the reference throws on malformed input (`std::runtime_error`). `parity::ENGINE_VERSION`
changes whenever results change; fold it into cache keys.

Every source includes `src/FloatSemantics.h` first, which turns floating-point
contraction off with compiler pragmas, so results do not depend on the
consumer's flags. The CMake target adds `-ffp-contract=off` as well. As a
subproject, libparity leaves `CMAKE_BUILD_TYPE` alone and does not build
`parity-conform`.

## Check

```sh
./run.py check cpp --out corpus/cpp.ndjson.gz
```

`parity-conform -j N` sets the number of worker threads (default: all cores).
Results are written in completion order.
