import type { FixtureDef } from "../dsl"

// Phantasm (Edit) by Exschwasion, 86 - 88.5
export default {
  bpm: [128],
  subdivision: 16,
  pattern: `
    .L..
    ....
    ...R
    ..L.
    .R..
    ...l | XO
    M..> | SS
    ..L~
    .R..
    ....
    L...
  `,
} satisfies FixtureDef
