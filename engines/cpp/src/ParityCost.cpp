#include "FloatSemantics.h"

#include "libparity/ParityCost.h"

#include <cmath>
#include <stdexcept>

#include "libparity/ParityUtils.h"

namespace parity {

ParityCostCalculator::ParityCostCalculator(const std::string& type,
                                           const Weights& weights)
    : layout(getStageLayout(type)), WEIGHTS(weights) {
  if (!layout) throw std::invalid_argument("Unsupported game type: " + type);
}

ActionCosts ParityCostCalculator::getActionCost(const ParityState& initialState,
                                                const ParityState& resultState,
                                                const Rows& rows,
                                                int rowIndex) const {
  const Row* lastRow = rowIndex > 0 ? &rows[rowIndex - 1] : nullptr;
  const Row& row = rows[rowIndex];
  double elapsedTime = resultState.second - initialState.second;
  if (rowIndex == 0) {
    elapsedTime = 1;
  }

  ActionCosts costs;

  // Calculate some data beforehand
  const PlacementData placementData =
      layout->getPlacementData(initialState, resultState, lastRow, row);

  // Mine weighting

  costs[COST_MINE] = calcMineCosts(placementData, row);

  costs[COST_HOLDSWITCH] = calcHoldSwitchCosts(placementData, row);
  costs[COST_HOLD_RELEASE] = calcHoldReleaseCost(placementData, row);

  costs[COST_BRACKETTAP] = calcBracketTapCost(placementData, elapsedTime);

  costs[COST_OTHER] = calcStartCrossover(placementData, rowIndex);

  costs[COST_BRACKETJACK] = calcBracketJackCost(placementData);

  costs[COST_XO_BR] = calcXOBRCost(placementData);

  costs[COST_XO_ENTRY] = calcXOTransitionCost(placementData);
  costs[COST_ROTATION_TWIST] = calcRotationTwistCost(placementData);
  costs[COST_XO_REVERSAL] = calcReversalCost(placementData);
  costs[COST_XO_STAY] = calcXOStayCost(placementData);

  costs[COST_DOUBLESTEP] =
      calcDoublestepCost(placementData, lastRow, row, elapsedTime);

  costs[COST_JUMP] = calcJumpCost(placementData, elapsedTime);

  costs[COST_TWISTED_FOOT] = calcTwistedFoot(placementData);

  costs[COST_SPIN] = calcSpinCost(placementData);

  costs[COST_HOLDPART_FOOTSWITCH] =
      calcHoldPartFootswitchCost(placementData, row, elapsedTime);
  costs[COST_FOOTSWITCH] = calcSlowFootswitchCost(placementData, row, elapsedTime);

  costs[COST_SIDESWITCH] = calcSideswitchCost(placementData, row);
  if (costs[COST_SIDESWITCH] > 0) {
    costs[COST_XO_STAY] = 0;
    costs[COST_XO_ENTRY] = 0;
  }
  costs[COST_XO_ROLL_RESOLVED] = calcXORollResolvedCost(placementData, row);

  costs[COST_MISSED_FOOTSWITCH] =
      calcMissedFootswitchCost(placementData, row, elapsedTime);

  costs[COST_JACK] =
      calcJackCost(placementData, row, elapsedTime, isStepjump(rows, rowIndex));

  costs[COST_DISTANCE] = calcDistanceCost(placementData, elapsedTime, &rows, rowIndex);

  costs[COST_CROWDED_BRACKET] = calcCrowdedBracketCost(placementData, elapsedTime);

  double totalCost = 0;
  for (int c = 0; c < COST_TOTAL; c++) {
    totalCost += costs.v[c];
  }
  costs[COST_TOTAL] = totalCost;
  return costs;
}

bool ParityCostCalculator::doesLeftFootOverlapRight(const PlacementData& data) const {
  const ParityState& r = *data.resultState;
  if (r.rightHeel() == -1) return false;
  if (r.rightHeel() == r.leftHeel() || r.rightHeel() == r.leftToe()) {
    return true;
  }
  if (r.rightToe() == -1) return false;
  if (r.rightToe() == r.leftHeel() || r.rightToe() == r.leftToe()) {
    return true;
  }

  return false;
}

bool ParityCostCalculator::doesRightFootOverlapLeft(const PlacementData& data) const {
  const ParityState& r = *data.resultState;
  if (r.leftHeel() == -1) return false;
  if (r.leftHeel() == r.rightHeel() || r.leftHeel() == r.rightToe()) {
    return true;
  }
  if (r.leftToe() == -1) return false;
  if (r.leftToe() == r.rightHeel() || r.leftToe() == r.rightToe()) {
    return true;
  }

  return false;
}

// A foot pressing a panel whose mine passed since the last row is MINE; a
// foot that stood on it and does not act lifts off to the center (MD, a
// ghost step) and pays MINE_DODGE.
double ParityCostCalculator::calcMineCosts(const PlacementData& data,
                                           const Row& row) const {
  double cost = 0;
  for (int i = 0; i < static_cast<int>(layout->layout.size()); i++) {
    if (!row.mines[i].has) continue;
    if (data.resultState->combinedAt(i) != Foot::NONE) return WEIGHTS.MINE;
    const int stood = data.initialState->combinedAt(i);
    if (stood == Foot::NONE || row.holds[i] != nullptr) continue;
    if (!data.resultState->movedFeet.has(stood) &&
        !data.resultState->movedFeet.has(OTHER_PART_OF_FOOT(stood)))
      cost = WEIGHTS.MINE_DODGE;
  }
  return cost;
}

double ParityCostCalculator::calcHoldSwitchCosts(const PlacementData& data,
                                                 const Row& row) const {
  double cost = 0;

  for (int c = 0; c < MAX_COLUMNS; c++) {
    if (row.holds[c] == nullptr) continue;
    // Skip holds not yet held at the previous row.
    if (row.holds[c]->beat > data.initialState->beat) continue;
    const int initialFoot = data.initialState->combinedAt(c);
    const int resultFoot = data.resultState->combinedAt(c);
    // a release and the step back on are priced by calcHoldReleaseCost
    if (initialFoot == Foot::NONE || resultFoot == Foot::NONE) continue;
    if (initialFoot != resultFoot && initialFoot != OTHER_PART_OF_FOOT(resultFoot)) {
      // a roll is re-tapped anyway: the other foot taking the re-tap is cheap
      if (row.holds[c]->type == NoteType::Roll) {
        cost += WEIGHTS.ROLLSWITCH;
        continue;
      }
      const int footCol = data.resultState->footColumn(initialFoot);
      if (footCol == UNDEF) {
        // JS: layout[undefined].y throws
        throw std::runtime_error("calcHoldSwitchCosts: undefined foot column");
      }
      const double tempcost =
          WEIGHTS.HOLDSWITCH *
          (footCol == -1 ? 1 : std::sqrt(layout->getDistanceSq(c, footCol)));
      cost += tempcost;
    }
  }

  return cost;
}

// A foot leaving a hold or roll it covered, so no foot is on it for a while.
double ParityCostCalculator::calcHoldReleaseCost(const PlacementData& data,
                                                 const Row& row) const {
  double cost = 0;
  for (int c = 0; c < MAX_COLUMNS; c++) {
    if (row.holds[c] == nullptr) continue;
    if (data.resultState->combinedAt(c) != Foot::NONE || row.hasHoldTail(c)) continue;
    if (!data.initialState->isReleased(c)) cost += WEIGHTS.HOLD_RELEASE;
  }
  return cost;
}

double ParityCostCalculator::calcBracketTapCost(const PlacementData& data,
                                                double elapsedTime) const {
  double cost = 0;
  const ParityState& r = *data.resultState;
  static constexpr int pairs[2][2] = {{Foot::LEFT_HEEL, Foot::LEFT_TOE},
                                      {Foot::RIGHT_HEEL, Foot::RIGHT_TOE}};
  for (const auto& pair : pairs) {
    const int heel = pair[0];
    const int toe = pair[1];
    if (r.footColumns[heel] == -1 || r.footColumns[toe] == -1) continue;
    if (r.holdFeet.has(heel) == r.holdFeet.has(toe)) continue;
    const int free = r.holdFeet.has(heel) ? toe : heel;
    const int tapCol = r.footColumns[free];
    if (r.actionAt(tapCol) != free) continue;
    double jackPenalty = 1;
    const ParityState& init = *data.initialState;
    const FootSet& moved = init.movedFeet;
    const bool footMoved = moved.has(heel) || moved.has(toe);
    const bool rocking = init.footColumns[heel] != -1 &&
                         init.footColumns[toe] != -1 && !moved.has(free) &&
                         moved.has(OTHER_PART_OF_FOOT(free));
    if ((data.jumped && footMoved) || (!data.jumped && rocking))
      jackPenalty = BracketTapJackWindow > 0
                        ? jsMax(1, BracketTapJackWindow / elapsedTime)
                        : 1 / elapsedTime;
    const int holdCol = r.footColumns[OTHER_PART_OF_FOOT(free)];
    const int candidates[3] = {init.footColumns[heel], init.footColumns[toe],
                               PivotFromHover ? init.hover[heel] : -1};
    int oriented = 0;
    for (int c : candidates)
      if (c != -1 && c != holdCol && layout->bracketCheck(c, holdCol)) oriented++;
    const bool planted =
        init.footColumns[heel] == tapCol || init.footColumns[toe] == tapCol;
    const bool trailed = init.hover[heel] == tapCol && !init.hoverPivot[heel];
    // the other foot stands on the tapped panel: a footswitch done with a
    // free part, which can't have been primed over an occupied panel
    const int otherHeel = heel == Foot::LEFT_HEEL ? Foot::RIGHT_HEEL : Foot::LEFT_HEEL;
    const bool switched = init.footColumns[otherHeel] == tapCol ||
                          init.footColumns[OTHER_PART_OF_FOOT(otherHeel)] == tapCol;
    const double factor = switched  ? SwitchBracketTapFactor
                          : planted ? PrimedBracketTapFactor
                          : trailed ? TrailPrimedBracketTapFactor
                          : oriented ? PivotBracketTapFactor
                                     : 1;
    cost += WEIGHTS.BRACKETTAP * jackPenalty * factor;
  }
  return cost;
}

double ParityCostCalculator::calcStartCrossover(const PlacementData& data,
                                                int rowIndex) const {
  // Don't start the chart crossed over
  if (data.rightPos.x < data.leftPos.x && rowIndex == 0) {
    return WEIGHTS.START_XO;
  }
  return 0;
}

double ParityCostCalculator::calcBracketJackCost(const PlacementData& data) const {
  if (data.jumped) return 0;
  struct FootData {
    bool jack;
    bool bracket;
    int heel;
    int toe;
  };
  const FootData feet[2] = {
      {data.leftJack, data.leftBracket, Foot::LEFT_HEEL, Foot::LEFT_TOE},
      {data.rightJack, data.rightBracket, Foot::RIGHT_HEEL, Foot::RIGHT_TOE},
  };
  for (const FootData& f : feet) {
    if (!f.jack || !f.bracket) continue;
    const int oldCols[2] = {data.initialState->footColumns[f.heel],
                            data.initialState->footColumns[f.toe]};
    const int newCols[2] = {data.resultState->footColumns[f.heel],
                            data.resultState->footColumns[f.toe]};
    bool every = true;
    for (int c : newCols)
      if (!(c == -1 || c == oldCols[0] || c == oldCols[1])) every = false;
    if (every) {
      return WEIGHTS.BRACKETJACK;
    }
  }
  return 0;
}

double ParityCostCalculator::calcXOBRCost(const PlacementData& data) const {
  double cost = 0;
  const bool isCrossedOver = data.resultState->facing != Facing::Forward;
  // Only penalize brackets that establish a NEW crossed stance.
  const bool wasCrossedOver = data.initialState->facing != Facing::Forward;
  if (wasCrossedOver) return 0;
  if (data.leftBracket && isCrossedOver) {
    cost += WEIGHTS.XO_BR;
  }
  if (data.rightBracket && isCrossedOver) {
    cost += WEIGHTS.XO_BR;
  }
  return cost;
}

bool ParityCostCalculator::isFootLifted(const ParityState& state, int heel) const {
  return state.footColumns[heel] == -1 &&
         state.footColumns[OTHER_PART_OF_FOOT(heel)] == -1;
}

double ParityCostCalculator::calcXOTransitionCost(const PlacementData& data) const {
  const bool wasCrossedOver = data.initialState->facing != Facing::Forward;
  const bool isCrossedOver = data.resultState->facing != Facing::Forward;
  if (!wasCrossedOver && isCrossedOver) {
    return WEIGHTS.XO_ENTRY;
  }
  return 0;
}

double ParityCostCalculator::calcReversalCost(const PlacementData& data) const {
  const ParityState& init = *data.initialState;
  const ParityState& res = *data.resultState;
  if (!init.facingProvisional || res.facing == Facing::Forward) return 0;
  if (init.lastTurn == Facing::Forward || init.lastTurn == res.facing) return 0;
  if (init.second - init.lastTurnEnd >= REVERSAL_WINDOW) return 0;
  return WEIGHTS.TWISTED_FOOT;
}

// A crossover onto a roll head that the other foot takes over on the next
// row, uncrossing, gives back the entry paid on the row before.
double ParityCostCalculator::calcXORollResolvedCost(const PlacementData& data,
                                                    const Row& row) const {
  const int c = data.initialState->crossedOntoRoll;
  if (c == -1 || data.resultState->facing != Facing::Forward) return 0;
  // the same roll, not a new note on its panel
  if (row.notes[c] != nullptr || row.holds[c] == nullptr ||
      row.holds[c]->beat != data.initialState->beat)
    return 0;
  const int before = data.initialState->combinedAt(c);
  const int after = data.resultState->combinedAt(c);
  if (after == Foot::NONE || after == before || after == OTHER_PART_OF_FOOT(before)) return 0;
  return -WEIGHTS.XO_ENTRY;
}

double ParityCostCalculator::calcXOStayCost(const PlacementData& data) const {
  if (data.resultState->facing != Facing::Forward) {
    return WEIGHTS.XO_STAY;
  }
  return 0;
}

double ParityCostCalculator::calcDoublestepCost(const PlacementData& data,
                                                const Row* lastRow,
                                                const Row& row,
                                                double elapsedTime) const {
  if (data.leftDoubleStep || data.rightDoubleStep) {
    // Check if we are allowed to DS
    // (a doublestep needs a previous move, so lastRow is set)
    for (int i = 0; i < static_cast<int>(layout->layout.size()); i++) {
      const NotedataEntry* hold = lastRow->holds[i];
      if (hold && !lastRow->hasHoldTail(i) && elapsedTime >= HoldDoublestepFreeTime) {
        return 0;
      }
    }

    const ParityState& init = *data.initialState;
    if (data.leftDoubleStep) {
      const bool willHitMine =
          row.mineAt(init.footColumns[Foot::LEFT_HEEL]).truthy() ||
          row.fakeMineAt(init.footColumns[Foot::LEFT_HEEL]).truthy() ||
          row.mineAt(init.footColumns[Foot::LEFT_TOE]).truthy() ||
          row.fakeMineAt(init.footColumns[Foot::LEFT_TOE]).truthy();
      if (willHitMine) return 0;
    }
    if (data.rightDoubleStep) {
      const bool willHitMine =
          row.mineAt(init.footColumns[Foot::RIGHT_HEEL]).truthy() ||
          row.fakeMineAt(init.footColumns[Foot::RIGHT_HEEL]).truthy() ||
          row.mineAt(init.footColumns[Foot::RIGHT_TOE]).truthy() ||
          row.fakeMineAt(init.footColumns[Foot::RIGHT_TOE]).truthy();
      if (willHitMine) return 0;
    }

    const double crossed = data.resultState->facing != Facing::Forward
                               ? CrossedDoublestepFactor
                               : 1;
    const int heel = data.leftDoubleStep ? Foot::LEFT_HEEL : Foot::RIGHT_HEEL;
    const bool afterJack =
        !data.previousJumped &&
        (init.movedFeet.has(heel) || init.movedFeet.has(OTHER_PART_OF_FOOT(heel))) &&
        !init.traveledFeet.has(heel);
    return WEIGHTS.DOUBLESTEP * jsMax(1, DoublestepBaseTime / elapsedTime) *
           crossed * (afterJack ? JackDoublestepFactor : 1);
  }
  return 0;
}

double ParityCostCalculator::calcJumpCost(const PlacementData& data,
                                          double elapsedTime) const {
  if (!data.jumped) return 0;

  // don't apply this cost for stepjumps
  if (!data.resultState->traveledFeet.has(Foot::LEFT_HEEL) ||
      !data.resultState->traveledFeet.has(Foot::RIGHT_HEEL)) {
    return 0;
  }

  return WEIGHTS.JUMP * jsMax(1, DoublestepBaseTime / elapsedTime);
}

double ParityCostCalculator::calcSlowBracketCost(const PlacementData& data,
                                                 const Row& row,
                                                 double elapsedTime) const {
  const bool wasCrossedOver = data.initialState->facing != Facing::Forward;
  if (wasCrossedOver) return 0;
  if (elapsedTime > slowBracketThreshold &&
      (data.leftBracket || data.rightBracket) && !data.jumped) {
    const ParityState& result = *data.resultState;
    int bracketParts[4];
    int partCount = 0;
    if (data.leftBracket) {
      bracketParts[partCount++] = Foot::LEFT_HEEL;
      bracketParts[partCount++] = Foot::LEFT_TOE;
    }
    if (data.rightBracket) {
      bracketParts[partCount++] = Foot::RIGHT_HEEL;
      bracketParts[partCount++] = Foot::RIGHT_TOE;
    }
    for (int p = 0; p < partCount; p++) {
      const int col = result.footColumns[bracketParts[p]];
      if (col == -1) continue;
      const NotedataEntry* note = row.noteAt(col);
      if (row.holdAt(col) != nullptr || (note != nullptr && isHoldNote(*note))) {
        return 0;
      }
    }
    return jsMin(slowBracketCap, elapsedTime - slowBracketThreshold) *
           WEIGHTS.SLOW_BRACKET;
  }
  return 0;
}

double ParityCostCalculator::calcTwistedFoot(const PlacementData& data) const {
  const ParityState& init = *data.initialState;
  const ParityState& res = *data.resultState;
  const auto& L = *layout;
  const bool rightBackwards = res.rightHeel() != -1 && res.rightToe() != -1
                                  ? L.layout[res.rightToe()].y < L.layout[res.rightHeel()].y
                                  : false;

  const bool leftBackwards = res.leftHeel() != -1 && res.leftToe() != -1
                                 ? L.layout[res.leftToe()].y < L.layout[res.leftHeel()].y
                                 : false;

  // if left heel is or was D, R can't do LU bracket
  const bool leftDownAndRightLU =
      includes(L.downArrows, init.footColumns[Foot::LEFT_HEEL]) &&
      includes(L.upArrows, res.footColumns[Foot::RIGHT_TOE]) &&
      includes(L.leftArrows, res.footColumns[Foot::RIGHT_HEEL]);
  // if right heel is or was D, L can't do RU bracket
  const bool rightDownAndLeftRU =
      includes(L.downArrows, init.footColumns[Foot::RIGHT_HEEL]) &&
      includes(L.upArrows, res.footColumns[Foot::LEFT_TOE]) &&
      includes(L.rightArrows, res.footColumns[Foot::LEFT_HEEL]);
  // if left foot is or was U, R can't have toe on L
  const bool leftUpAndRightLeft =
      (includes(L.upArrows, init.footColumns[Foot::LEFT_HEEL]) ||
       includes(L.upArrows, init.footColumns[Foot::LEFT_TOE])) &&
      includes(L.leftArrows, res.footColumns[Foot::RIGHT_TOE]);
  // if right foot is or was U, L can't have toe on R
  const bool rightUpAndLeftRight =
      (includes(L.upArrows, init.footColumns[Foot::RIGHT_HEEL]) ||
       includes(L.upArrows, init.footColumns[Foot::RIGHT_TOE])) &&
      includes(L.rightArrows, res.footColumns[Foot::LEFT_TOE]);
  const bool twistedShin = leftDownAndRightLU || rightDownAndLeftRU ||
                           leftUpAndRightLeft || rightUpAndLeftRight;

  const bool unnaturalFacingRight =
      init.facing == Facing::Right &&
      ((includes(L.downArrows, res.footColumns[Foot::LEFT_HEEL]) &&
        includes(L.leftArrows, res.footColumns[Foot::LEFT_TOE])) ||
       (includes(L.rightArrows, res.footColumns[Foot::RIGHT_HEEL]) &&
        includes(L.upArrows, res.footColumns[Foot::RIGHT_TOE])) ||
       // would face backwards
       (includes(L.leftArrows, res.footColumns[Foot::RIGHT_HEEL]) &&
        includes(L.downArrows, res.footColumns[Foot::LEFT_HEEL])));
  const bool unnaturalFacingLeft =
      init.facing == Facing::Left &&
      ((includes(L.downArrows, res.footColumns[Foot::RIGHT_HEEL]) &&
        includes(L.rightArrows, res.footColumns[Foot::RIGHT_TOE])) ||
       (includes(L.leftArrows, res.footColumns[Foot::LEFT_HEEL]) &&
        includes(L.upArrows, res.footColumns[Foot::LEFT_TOE])) ||
       // would face backwards
       (includes(L.rightArrows, res.footColumns[Foot::LEFT_HEEL]) &&
        includes(L.downArrows, res.footColumns[Foot::RIGHT_HEEL])));
  // a provisional facing (chosen with a foot in the air) cannot be
  // contradicted: the landing foot decides it
  const bool facingTwistBracket =
      !init.facingProvisional && (unnaturalFacingRight || unnaturalFacingLeft);

  if (rightBackwards || leftBackwards || twistedShin || facingTwistBracket) {
    return WEIGHTS.TWISTED_FOOT;
  }
  return 0;
}

double ParityCostCalculator::calcSpinCost(const PlacementData& data) const {
  double cost = 0;

  if (isFootLifted(*data.initialState, Foot::LEFT_HEEL) ||
      isFootLifted(*data.initialState, Foot::RIGHT_HEEL) ||
      isFootLifted(*data.resultState, Foot::LEFT_HEEL) ||
      isFootLifted(*data.resultState, Foot::RIGHT_HEEL)) {
    return 0;
  }

  double prevAngle = getPlayerAngle(data.previousLeftPos, data.previousRightPos);

  double angle = getPlayerAngle(data.leftPos, data.rightPos);

  if (std::fabs(angle) < JS_PI / 2 || std::fabs(prevAngle) < JS_PI / 2) {
    return 0;
  }

  if (angle < 0) angle += JS_PI * 2;
  if (prevAngle < 0) prevAngle += JS_PI * 2;

  // prevent facing backwards but not turning causing a spin
  if (angle == prevAngle) return 0;

  // If we cross the 180 deg line, that's a spin
  if (((prevAngle <= JS_PI && angle >= JS_PI) ||
       (prevAngle >= JS_PI && angle <= JS_PI)) &&
      data.initialState->frontFoot != data.resultState->frontFoot) {
    cost += WEIGHTS.SPIN;
  }

  return cost;
}

namespace {
bool anyMine(const Row& row) {
  for (int c = 0; c < MAX_COLUMNS; c++)
    if (row.mines[c].has || row.fakeMines[c].has) return true;
  return false;
}
}  // namespace

double ParityCostCalculator::calcSlowFootswitchCost(const PlacementData& data,
                                                    const Row& row,
                                                    double elapsedTime) const {
  if (elapsedTime < SlowFootswitchThreshold) return 0;
  if (data.jumped) return 0;

  // footswitching has no penalty if there's a mine nearby
  if (anyMine(row)) {
    return 0;
  }

  double cost = 0;

  const ParityState& init = *data.initialState;
  for (int foot : data.resultState->movedFeet) {
    const int col = data.resultState->footColumn(foot);
    if (init.combinedAt(col) == Foot::NONE) continue;
    // A hold takeover is not a footswitch — HOLDSWITCH prices it.
    if (row.holdAt(col) != nullptr) continue;
    if (init.combinedAt(col) == foot ||
        init.combinedAt(col) == OTHER_PART_OF_FOOT(foot))
      continue;
    cost += jsMin(((elapsedTime - SlowFootswitchThreshold) / elapsedTime) *
                      WEIGHTS.FOOTSWITCH,
                  SlowFootswitchCap);
  }

  return cost;
}

double ParityCostCalculator::calcHoldPartFootswitchCost(const PlacementData& data,
                                                        const Row& row,
                                                        double elapsedTime) const {
  if (data.jumped || elapsedTime >= HoldPartFootswitchMaxTime) return 0;
  const ParityState& init = *data.initialState;
  double cost = 0;
  for (int foot : data.resultState->movedFeet) {
    const int col = data.resultState->footColumn(foot);
    if (row.holdAt(col) != nullptr) continue;
    const int was = init.combinedAt(col);
    if (was == Foot::NONE || was == foot || was == OTHER_PART_OF_FOOT(foot)) continue;
    const bool justTapped = init.movedFeet.has(was);
    const int partnerCol = init.footColumn(OTHER_PART_OF_FOOT(was));
    if (justTapped && partnerCol != -1 && partnerCol != col &&
        row.holdAt(partnerCol) != nullptr) {
      cost += WEIGHTS.FOOTSWITCH * HoldPartFootswitchFactor;
    }
  }
  return cost;
}

double ParityCostCalculator::calcSideswitchCost(const PlacementData& data,
                                                const Row& row) const {
  double cost = 0;
  if (data.jumped) return 0;

  const ParityState& init = *data.initialState;
  const ParityState& res = *data.resultState;
  const bool wasCrossedOver = init.facing != Facing::Forward;
  const bool minedRow = anyMine(row);
  const double switchScale = wasCrossedOver || minedRow ? 0.25 : 1;

  for (int col : layout->sideArrows) {
    if (res.actionAt(col) == Foot::NONE) continue;
    if (init.combinedAt(col) == Foot::NONE) continue;
    if (init.combinedAt(col) == res.actionAt(col) ||
        init.combinedAt(col) == OTHER_PART_OF_FOOT(res.actionAt(col)))
      continue;
    cost += WEIGHTS.SIDESWITCH * switchScale;
  }

  return cost;
}

double ParityCostCalculator::calcRotationTwistCost(const PlacementData& data) const {
  const ParityState& init = *data.initialState;
  const ParityState& res = *data.resultState;
  if (init.facing == Facing::Forward || res.facing != Facing::Forward) return 0;
  if (init.facingProvisional) return 0;
  if (isFootLifted(res, Foot::LEFT_HEEL) || isFootLifted(res, Foot::RIGHT_HEEL))
    return 0;
  auto lateral = [&](Pos p) { return init.facing == Facing::Right ? p.y : -p.y; };
  return lateral(data.leftPos) < lateral(data.rightPos) - 1e-6 ? WEIGHTS.TWISTED_FOOT
                                                              : 0;
}

double ParityCostCalculator::calcMissedFootswitchCost(const PlacementData& data,
                                                      const Row& row,
                                                      double elapsedTime) const {
  return mineForcesFootswitch(data, row, elapsedTime) ? WEIGHTS.MISSED_FOOTSWITCH : 0;
}

double ParityCostCalculator::calcJackCost(const PlacementData& data, const Row& row,
                                          double elapsedTime, bool stepjump) const {
  const double jackCost =
      WEIGHTS.JACK * 0.125 +
      (elapsedTime < JackMaxElapsedTime
           ? (1 / elapsedTime - 1 / JackMaxElapsedTime) * WEIGHTS.JACK * (4.0 / 15)
           : 0);
  double cost = 0;
  if (data.leftJack || data.rightJack) {
    cost += jackCost;
  }
  if (data.jumped) {
    const bool planted =
        stepjump ||
        isPlantedJump(row, *data.initialState, *data.resultState, elapsedTime);
    const double f = planted ? StepjumpJackFactor : 1;
    for (int heel : {Foot::LEFT_HEEL, Foot::RIGHT_HEEL}) {
      const JumpRepress kind = jumpRepress(*data.initialState, *data.resultState, heel);
      if (kind == JumpRepress::Same)
        cost += jackCost * f;
      else if (kind == JumpRepress::Subset)
        cost += jackCost * StepjumpJackFactor;
    }
  }
  return cost;
}

double ParityCostCalculator::calcDistanceCost(const PlacementData& data,
                                              double elapsedTime, const Rows* rows,
                                              int rowIndex) const {
  double cost = 0;
  const Row* lastRow = rows && rowIndex >= 1 ? &(*rows)[rowIndex - 1] : nullptr;
  const Row* rowBefore = rows && rowIndex >= 2 ? &(*rows)[rowIndex - 2] : nullptr;

  const ParityState& init = *data.initialState;
  const ParityState& res = *data.resultState;
  for (int foot : {Foot::LEFT_HEEL, Foot::RIGHT_HEEL}) {
    // either part: a bracket tap by the toe travels like one by the heel
    if (!res.movedFeet.has(foot) && !res.movedFeet.has(OTHER_PART_OF_FOOT(foot)))
      continue;

    const Pos initialPosition =
        foot == Foot::LEFT_HEEL ? data.previousLeftPos : data.previousRightPos;

    const Pos resultPosition = foot == Foot::LEFT_HEEL ? data.leftPos : data.rightPos;

    // DISTANCE prices required velocity over the time the foot had.
    double footTime = elapsedTime;
    if (!init.movedFeet.has(foot) && !init.movedFeet.has(OTHER_PART_OF_FOOT(foot))) {
      footTime *= 2;
    }
    // A foot that took over a roll re-tapped it halfway through the last
    // row gap, so it has been free to leave since then.
    else if (lastRow && rowBefore) {
      const int c = init.footColumns[foot];
      if (init.movedFeet.has(foot) && c != -1 && lastRow->holds[c] != nullptr &&
          lastRow->holds[c]->type == NoteType::Roll && lastRow->notes[c] == nullptr) {
        footTime += (lastRow->second - rowBefore->second) / 2;
      }
    }

    if (data.previousJumped && !data.jumped && elapsedTime < 0.25) {
      footTime = std::pow(footTime, 1.5);
    }

    const double travel =
        std::sqrt(layout->getDistanceSqPoints(initialPosition, resultPosition));
    const double dist =
        (travel * (travel >= 2 - 1e-6 ? CandleFactor : 1) * WEIGHTS.DISTANCE) /
        footTime;

    cost += dist;
  }
  return cost;
}

double ParityCostCalculator::calcCrowdedBracketCost(const PlacementData& data,
                                                    double elapsedTime) const {
  if (data.jumped || elapsedTime < CrowdedBracketMinTime) return 0;
  const ParityState& init = *data.initialState;
  const ParityState& res = *data.resultState;
  auto settledOn = [&](int heel, int toe, int c0, int c1) {
    for (int c : {init.footColumns[heel], init.footColumns[toe]})
      if (c != -1 && (c == c0 || c == c1)) return true;
    return false;
  };
  if (data.leftBracket && !data.previousMovedRight &&
      settledOn(Foot::RIGHT_HEEL, Foot::RIGHT_TOE, res.leftHeel(), res.leftToe())) {
    return WEIGHTS.CROWDED_BRACKET;
  }
  if (data.rightBracket && !data.previousMovedLeft &&
      settledOn(Foot::LEFT_HEEL, Foot::LEFT_TOE, res.rightHeel(), res.rightToe())) {
    return WEIGHTS.CROWDED_BRACKET;
  }
  return 0;
}

}  // namespace parity
