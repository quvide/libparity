import type { FixtureDef } from "../dsl"

// Phantasm (Challenge) by Exschwasion, 68 - 74
export default {
  bpm: [115, 128, 141],
  subdivision: 16,
  pattern: `
    L...
    ....
    .R..
    ..L.
    ...R
    .l..
    .>M. | FS
    L~..
    ...R
    ....
    .L..
    ..R.
    L...
    .r..
    .<M. | FS
    .~.R
    L...
    ....
    ..R.
    .L..
    ...R
    ..l.
    .M>. | FS
    L.~.
    ...R
  `,
} satisfies FixtureDef
