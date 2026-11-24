#include "FloatSemantics.h"

#include "libparity/StageLayouts.h"

#include <cmath>

#include "libparity/ParityUtils.h"

namespace parity {

namespace {
// relative slack when comparing a row gap with twice a roll's stream step
constexpr double STREAM_GAP_TOLERANCE = 0.05;
}  // namespace

StageLayout::StageLayout(std::string name, std::vector<StagePoint> layout,
                         std::vector<int> upArrows, std::vector<int> downArrows,
                         std::vector<int> sideArrows)
    : name(std::move(name)),
      layout(std::move(layout)),
      columnCount(static_cast<int>(this->layout.size())),
      upArrows(std::move(upArrows)),
      downArrows(std::move(downArrows)),
      sideArrows(std::move(sideArrows)) {
  for (int col : this->sideArrows)
    if (this->layout[col].x < 0) leftArrows.push_back(col);
  for (int col : this->sideArrows)
    if (this->layout[col].x > 0) rightArrows.push_back(col);
}

StageLayout::CrossedFeet StageLayout::crossedFeet(const ParityState& state) const {
  const bool leftOnRight =
      includes(rightArrows, state.footColumns[Foot::LEFT_HEEL]) ||
      includes(rightArrows, state.footColumns[Foot::LEFT_TOE]);
  const bool rightOnLeft =
      includes(leftArrows, state.footColumns[Foot::RIGHT_HEEL]) ||
      includes(leftArrows, state.footColumns[Foot::RIGHT_TOE]);
  return {leftOnRight, rightOnLeft};
}

Pos StageLayout::averagePoint(int leftIndex, int rightIndex) const {
  if (leftIndex == -1 && rightIndex == -1) return {0, 0};
  if (leftIndex == -1) return {layout[rightIndex].x, layout[rightIndex].y};
  if (rightIndex == -1) return {layout[leftIndex].x, layout[leftIndex].y};
  return {
      (layout[leftIndex].x + layout[rightIndex].x) / 2,
      (layout[leftIndex].y + layout[rightIndex].y) / 2,
  };
}

double StageLayout::getDistanceSq(int leftIndex, int rightIndex) const {
  const StagePoint& p1 = layout[leftIndex];
  const StagePoint& p2 = layout[rightIndex];
  return (p1.y - p2.y) * (p1.y - p2.y) + (p1.x - p2.x) * (p1.x - p2.x);
}

double StageLayout::getDistanceSqPoints(Pos p1, Pos p2) const {
  return (p1.y - p2.y) * (p1.y - p2.y) + (p1.x - p2.x) * (p1.x - p2.x);
}

bool StageLayout::bracketCheck(int column1, int column2) const {
  return getDistanceSq(column1, column2) <= 2;
}

PlacementData StageLayout::getPlacementData(const ParityState& initialState,
                                            const ParityState& resultState,
                                            const Row* lastRow,
                                            const Row& row) const {
  bool previousNonHeldFeet[5] = {};
  bool nonHeldFeet[5] = {};

  for (int i = 0; i < static_cast<int>(layout.size()); i++) {
    if (lastRow && lastRow->holds[i] == nullptr &&
        initialState.actionAt(i) != Foot::NONE) {
      // the start node has no action, but it is never paired with a lastRow
      previousNonHeldFeet[initialState.actionAt(i)] = true;
    }

    if (row.holds[i] == nullptr && resultState.actionAt(i) != Foot::NONE) {
      nonHeldFeet[resultState.actionAt(i)] = true;
    }
  }

  const bool previousMovedLeft =
      previousNonHeldFeet[Foot::LEFT_HEEL] || previousNonHeldFeet[Foot::LEFT_TOE];
  const bool previousMovedRight = previousNonHeldFeet[Foot::RIGHT_HEEL] ||
                                  previousNonHeldFeet[Foot::RIGHT_TOE];

  const bool movedLeft = nonHeldFeet[Foot::LEFT_HEEL] || nonHeldFeet[Foot::LEFT_TOE];
  const bool movedRight =
      nonHeldFeet[Foot::RIGHT_HEEL] || nonHeldFeet[Foot::RIGHT_TOE];

  const bool leftBracket = nonHeldFeet[Foot::LEFT_HEEL] && nonHeldFeet[Foot::LEFT_TOE];
  const bool rightBracket =
      nonHeldFeet[Foot::RIGHT_HEEL] && nonHeldFeet[Foot::RIGHT_TOE];

  // JUMP_EITHER_PART
  const bool previousJumped = previousMovedLeft && previousMovedRight;
  const bool jumped = movedLeft && movedRight;

  const bool leftTraveled = resultState.traveledFeet.has(Foot::LEFT_HEEL);
  const bool rightTraveled = resultState.traveledFeet.has(Foot::RIGHT_HEEL);

  const bool leftJack =
      !jumped &&
      doFeetOverlap(initialState.leftHeel(), initialState.leftToe(),
                    resultState.leftHeel(), resultState.leftToe()) &&
      previousMovedLeft && movedLeft && !leftTraveled;
  const bool rightJack =
      !jumped &&
      doFeetOverlap(initialState.rightHeel(), initialState.rightToe(),
                    resultState.rightHeel(), resultState.rightToe()) &&
      previousMovedRight && movedRight && !rightTraveled;

  const bool previousRealJump = previousJumped &&
                                initialState.traveledFeet.has(Foot::LEFT_HEEL) &&
                                initialState.traveledFeet.has(Foot::RIGHT_HEEL);

  // A roll re-tapped between rows acts like an arrow on its panel: the
  // re-tapping foot acted in between, so the other foot moving now
  // alternates with it. The foot that took the roll over re-tapped it; the
  // foot that stays on it only when the gap is a hole in the stream the
  // roll started in (twice its step).
  const double gap = lastRow ? row.second - lastRow->second : 0;
  auto streamGap = [&](OptNum step) {
    return step.has && std::fabs(gap - 2 * step.v) <= STREAM_GAP_TOLERANCE * gap;
  };
  bool leftRetapped = false;
  bool rightRetapped = false;
  PlacementData data;
  data.rollTapCount = 0;
  for (int i = 0; i < static_cast<int>(layout.size()); i++) {
    const NotedataEntry* hold = row.holdAt(i);
    if (hold == nullptr || hold->type != NoteType::Roll || hold->beat > initialState.beat) continue;
    const int before = initialState.combinedAt(i);
    if (before == Foot::NONE) continue;
    const int after = resultState.combinedAt(i);
    const bool stayed = after == Foot::NONE || after == before || after == OTHER_PART_OF_FOOT(before);
    if (stayed && !streamGap(row.rollSteps[i])) continue;
    const int tapper = stayed ? before : after;
    data.rollTaps[data.rollTapCount++] = {i, tapper};
    if (tapper == Foot::LEFT_HEEL || tapper == Foot::LEFT_TOE)
      leftRetapped = true;
    else
      rightRetapped = true;
  }

  const bool leftDoubleStep = !rightRetapped && previousMovedLeft && movedLeft && leftTraveled &&
                              !jumped && !leftJack && !previousRealJump;
  const bool rightDoubleStep = !leftRetapped && previousMovedRight && movedRight && rightTraveled &&
                               !jumped && !rightJack && !previousRealJump;
  const bool leftAfterStepjump = previousJumped &&
                                 initialState.traveledFeet.has(Foot::RIGHT_HEEL) &&
                                 !initialState.traveledFeet.has(Foot::LEFT_HEEL);
  const bool rightAfterStepjump = previousJumped &&
                                  initialState.traveledFeet.has(Foot::LEFT_HEEL) &&
                                  !initialState.traveledFeet.has(Foot::RIGHT_HEEL);

  data.previousLeftPos = footPosition(initialState, Foot::LEFT_HEEL);
  data.previousRightPos = footPosition(initialState, Foot::RIGHT_HEEL);
  data.leftPos = footPosition(resultState, Foot::LEFT_HEEL);
  data.rightPos = footPosition(resultState, Foot::RIGHT_HEEL);
  data.movedLeft = movedLeft;
  data.movedRight = movedRight;
  data.previousMovedLeft = previousMovedLeft;
  data.previousMovedRight = previousMovedRight;
  data.leftBracket = leftBracket;
  data.rightBracket = rightBracket;
  data.previousJumped = previousJumped;
  data.jumped = jumped;
  data.leftJack = leftJack;
  data.rightJack = rightJack;
  data.leftDoubleStep = leftDoubleStep;
  data.rightDoubleStep = rightDoubleStep;
  data.leftAfterStepjump = leftAfterStepjump;
  data.rightAfterStepjump = rightAfterStepjump;
  data.initialState = &initialState;
  data.resultState = &resultState;
  return data;
}

Pos StageLayout::footPosition(const ParityState& state, int heel) const {
  const int heelCol = state.footColumns[heel];
  const int toeCol = state.footColumns[OTHER_PART_OF_FOOT(heel)];
  if (heelCol != -1 || toeCol != -1) {
    return averagePoint(heelCol, toeCol);
  }
  if (state.frontFoot == FRONT_FOOT_NULL) {
    return {0, 0};
  }
  const double sign = state.frontFoot == heel ? 1 : -1;
  return {0, 0.5 * sign};
}

const StageLayout* getStageLayout(const std::string& id) {
  static const StageLayout single(
      "dance-single",
      {
          {-1, 0, 0},                 // Left
          {0, -1, (JS_PI / 2) * 3},    // Down
          {0, 1, JS_PI / 2},           // Up
          {1, 0, JS_PI},               // Right
      },
      {2}, {1}, {0, 3});
  static const StageLayout doubles(
      "dance-double",
      {
          {-2.5, 0, 0},               // P1 Left
          {-1.5, -1, (JS_PI / 2) * 3}, // P1 Down
          {-1.5, 1, JS_PI / 2},        // P1 Up
          {-0.5, 0, JS_PI},            // P1 Right

          {0.5, 0, 0},                // P2 Left
          {1.5, -1, (JS_PI / 2) * 3},  // P2 Down
          {1.5, 1, JS_PI / 2},         // P2 Up
          {2.5, 0, JS_PI},             // P2 Right
      },
      {2, 6}, {1, 5}, {0, 3, 4, 7});
  if (id == "dance-single") return &single;
  if (id == "dance-double") return &doubles;
  return nullptr;
}

}  // namespace parity
