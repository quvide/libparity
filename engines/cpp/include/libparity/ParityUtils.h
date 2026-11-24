#pragma once

#include <vector>

#include "NoteTypes.h"
#include "ParityDataTypes.h"

namespace parity {

// two times closer than this are the same row
constexpr double SECOND_EPSILON = 0.0005;

// Beats within 1/96 are the same row for annotation purposes.
constexpr double HOLD_OVERRIDE_EPSILON = 1.0 / 96;

// The latest holdOverrides entry at or before the beat, ignoring entries at
// the hold head; FOOT_OVERRIDE_UNDEFINED when there is none.
FootOverride holdOverrideAt(const NotedataEntry& hold, double beat);

constexpr double StepjumpMaxGap = 0.5;

bool isStepjump(const Rows& rows, int idx);

enum class JumpRepress { None, Same, Subset };

JumpRepress jumpRepress(const ParityState& initialState,
                        const ParityState& resultState, int heel);

bool isPlantedJump(const Row& row, const ParityState& initialState,
                   const ParityState& resultState, double elapsedTime);

bool doFeetOverlap(int oldHeel, int oldToe, int newHeel, int newToe);

double getPlayerAngle(Pos left, Pos right);

constexpr double MINE_FOOTSWITCH_MAX_GAP = 2.0;
// how long after a rotation ended a rotation the other way is a reversal
constexpr double REVERSAL_WINDOW = 0.5;

// How long a hold or roll survives with no foot on it (ITGmania with Simply
// Love's TimingWindowSecondsHold / TimingWindowSecondsRoll).
constexpr double HOLD_RELEASE_WINDOW = 0.32;
constexpr double ROLL_RELEASE_WINDOW = 0.35;

bool mineForcesFootswitch(const PlacementData& data, const Row& row,
                          double elapsedTime);

}  // namespace parity
