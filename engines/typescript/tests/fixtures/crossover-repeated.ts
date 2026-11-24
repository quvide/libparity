import type { FixtureDef } from "../dsl"

// Specific example from Egg Carton 3 Body Breathing (Edit) by Exschwasion, beats 177.75 - 184
export default {
  bpm: 150,
  subdivision: 16,
  pattern: `
    L...
    ...R
    ..L.
    R... | XO
    ...L | LX
    R... | XO
    ..L.
    .R..
    L...
    ...R
    ..L.
    R... | XO
    ...L | LX
    R... | XO
    ..L.
    .R..
    L...
    ...R
    ..L.
    R... | XO
    ...L | LX
    R... | XO
    ..L.
    .R..
    L...
    ...R
  `,
} satisfies FixtureDef
