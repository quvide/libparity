import type { FixtureDef } from "../dsl"

// Lateral crossover. Below ~155 BPM the engine doublesteps onto L instead.
export default {
  bpm: [175, 200, 225],
  subdivision: 16,
  pattern: `
    ...R
    ..L.
    R... | XO
    ...L | LX
    .R..
  `,
} satisfies FixtureDef
