#pragma once

#include <cstdint>
#include <vector>

namespace parity {

// FootOverride ("Left" | "Right" | Foot) lives here instead of in
// ParityDataTypes to avoid an include cycle. FOOT_OVERRIDE_UNDEFINED is
// `undefined`; 0-4 are a Foot.
using FootOverride = int8_t;
constexpr FootOverride FOOT_OVERRIDE_UNDEFINED = -1;
constexpr FootOverride FOOT_OVERRIDE_LEFT = 5;
constexpr FootOverride FOOT_OVERRIDE_RIGHT = 6;

inline bool isFootOverrideNumber(FootOverride o) { return o >= 0 && o <= 4; }
// JS truthiness: undefined and Foot.NONE (0) are falsy
inline bool isFootOverrideTruthy(FootOverride o) {
  return o != FOOT_OVERRIDE_UNDEFINED && o != 0;
}

enum class NoteType : uint8_t { Tap, Mine, Lift, Fake, Hold, Roll };

struct HoldOverride {
  double beat;
  FootOverride foot;
};

struct NotedataEntry {
  double beat = 0;
  int col = 0;
  NoteType type = NoteType::Tap;
  double second = 0;
  bool warped = false;
  bool fake = false;
  // parity?.override
  FootOverride override = FOOT_OVERRIDE_UNDEFINED;
  // parity?.holdOverrides; hold notes only, sorted by beat
  std::vector<HoldOverride> holdOverrides;
  // length in beats, hold notes only
  double hold = 0;
};

// sorted by beat, then column
using Notedata = std::vector<NotedataEntry>;

inline bool isHoldNote(const NotedataEntry& note) {
  return note.type == NoteType::Hold || note.type == NoteType::Roll;
}

}  // namespace parity
