# libparity

Determines foot placement and tech notation for ITG charts.
The goal of this project is to provide native implementations compatible with all major ITGmania ecosystem projects. See [`API.md`](engines/API.md) for a list of supported features (currently LLM generated).

The base of this project started from the parity engine of [SMEditor](https://github.com/tillvit/smeditor).


## Philosophy

The core of the repository is a set of fixtures, which are player interpretations of step sequences.
The reference engine passes all the fixtures.
Engine ports are then updated to match the reference engine output on the chart corpus.
All the engines conform to a unified API shape to keep supported features aligned and documented.

There is an intentional split of what is expected to be human-curated and what can be handled completely with agentic LLM or other methods.
As a courtesy, human written or carefully verified should be:
- prose meant for human reading (like this README)
- chart fixtures (experience from actually playing the game)
- commit and PR descriptions

Other areas can be considered implementation details and developed with whatever means.


## Engines

**TypeScript**
This is the reference engine due to quick iteration speed and it being the original implementation.
Support for SMEditor, ArrowCloud and other web-based projects.

**C++**
For ITGmania and ArrowVortex support.

**Rust**
For DeadSync support.


## Performance

The basic idea carried over from the SMEditor base is a shortest path graph search.
Each row of the chart has a set of possible foot placements, and every move from one placement to the next is scored with a weighted cost function.
The selected result is the cheapest path through all rows.
For correctness, it is fundamentally more algorithmically complex and thus slower than the original ITGmania and DeadSync implementations, which use a single forward pass.

To keep memory use linear during analysis of longer charts, there is a fixed lookback cap of 128 rows.
For analysis of marathon-length charts, the implementations can operate in a windowed fixed-memory mode, yielding only tech counts instead of per-row footing.


## Versioning

A cache version string is provided that is incremented any time there is a change that affects the reference corpus output.
Any implementation should invalidate caches when the version is changed.
Other changes (such as performance improvements) may be done without incrementing the cache version.


## Running

There is a single entrypoint script which uses the host's toolchains.
See its `deps` command for native dependency status.

```shell
./run.py --help
```

For ease of setup, a Containerfile and helper script are provided that install all required dependencies.
However, performance might be worse than running directly on the host machine.

```shell
./container/run.py --help
```


## Contributing

Example process:
1. Identify a chart where an incorrect result is produced
2. Create a fixture of the minimal reproduction and any alternate interpretations
3. Make sure the new fixture isn't internally inconsistent with other fixtures
4. Modify the reference engine to pass the fixture while not failing any other fixture
5. Review the effect on the corpus and whether the resulting changes seem correct
6. Modify the ported engines to match the reference engine
7. Bump the cache version
8. Commit and open a PR

Tips:
- After making any engine changes, check the fixtures first before running heavier corpus checks.
- When checking the corpus, start with a small sample.
  Running the full corpus takes too long for quick iteration loops.
- Try to make fixtures as generic as possible and include as little context as possible.
- If extracting fixtures from specific charts, mention the name, author and beats it is based on.


## Future

Help is needed to make the fixture set cover the modern meta properly.
If you encounter something that doesn't work, feel free to either submit an issue with a minimal sample SM / SSC and explain how it should work or open a PR directly.

Some aspects of analysis are subjective: how tech is named, what tech is detected,
and how the engine should be weighted for patterns that can be interpreted ambiguously (e.g. XO vs DS).
For these topics, it is preferred to have a community discussion and consensus before making changes in the repository.

The library currently only supports 4-panel singles, but it's not out of scope to add support for other game types.


## License

The engine is based on the parity engine of [SMEditor](https://github.com/tillvit/smeditor).
Parts derived from it remain available under the MIT license, see [LICENSE-smeditor](LICENSE-smeditor).

Many fixtures are short excerpts of published charts, adapted into the fixture format and annotated with interpretations.
These files credit the author in each fixture's header comment.
The excerpts are not covered by the licenses beyond what their authors permit.

Other contents are licensed under the [Mozilla Public License 2.0](LICENSE).

