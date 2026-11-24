import type { FixtureDef } from "../dsl"

// Phantasm (Medium) by Exschwasion, 68 - 78.5
export default {
  bpm: [115, 128, 141],
  subdivision: 8,
  pattern: `
    ...R
    L...
    .r..
    .<M. | FS
    .~.R
    L...
    .r..
    .<M. | FS
    .~.R
    L...
    ..r.
    .M<. | FS
    ..~R
    L...
    ..r.
    .M<. | FS
    ..~R
  `,
} satisfies FixtureDef
