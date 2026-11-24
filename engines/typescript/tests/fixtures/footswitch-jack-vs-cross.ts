import type { FixtureVariantDef } from "../dsl"

// From a #jesusclub u cant dance out by Exschwasion, beats 145.75 - 149.25
export default [
  {
    // fast reading: footswitch into crossover
    variant: "fs-xo",
    bpm: [175, 220],
    subdivision: 16,
    pattern: `
      ...R
      L...
      ..R.
      ..L. | FS
      .R..
      ...L | XO
      .R..
      ..L.
      .R..
      ...L | XO
      .R..
      ..L.
      .R..
      .L.. | FS
      ...R
    `,
  },

  {
    // slow reading: jack, no crossover
    variant: "jack",
    bpm: [120, 170],
    subdivision: 16,
    pattern: `
      ...R
      L...
      ..R.
      ..R. | JA
      .L..
      ...R
      .L..
      ..R.
      .L..
      ...R
      .L..
      ..R.
      .L..
      .L.. | JA
      ...R
    `,
  },
] satisfies FixtureVariantDef[]
