#pragma once

#include <string>
#include <vector>

#include "ParityDataTypes.h"
#include "StageLayouts.h"

namespace parity {

// The keys of the TS cost dictionary, in its insertion order: TOTAL sums
// them in this order.
enum CostName {
  COST_MINE,
  COST_HOLDSWITCH,
  COST_HOLD_RELEASE,
  COST_BRACKETTAP,
  COST_OTHER,
  COST_BRACKETJACK,
  COST_XO_BR,
  COST_XO_ENTRY,
  COST_ROTATION_TWIST,
  COST_XO_REVERSAL,
  COST_XO_STAY,
  COST_DOUBLESTEP,
  COST_JUMP,
  COST_TWISTED_FOOT,
  COST_SPIN,
  COST_HOLDPART_FOOTSWITCH,
  COST_FOOTSWITCH,
  COST_SIDESWITCH,
  COST_XO_ROLL_RESOLVED,
  COST_MISSED_FOOTSWITCH,
  COST_JACK,
  COST_DISTANCE,
  COST_CROWDED_BRACKET,
  COST_TOTAL,
  CostNameCount,
};

struct ActionCosts {
  double v[CostNameCount] = {};
  double operator[](CostName name) const { return v[name]; }
  double& operator[](CostName name) { return v[name]; }
};

class ParityCostCalculator {
 public:
  explicit ParityCostCalculator(const std::string& type,
                                const Weights& weights = DEFAULT_WEIGHTS);

  ActionCosts getActionCost(const ParityState& initialState,
                            const ParityState& resultState,
                            const Rows& rows, int rowIndex) const;

  bool doesLeftFootOverlapRight(const PlacementData& data) const;
  bool doesRightFootOverlapLeft(const PlacementData& data) const;

  double calcMineCosts(const PlacementData& data, const Row& row) const;
  double calcHoldSwitchCosts(const PlacementData& data, const Row& row) const;
  double calcHoldReleaseCost(const PlacementData& data, const Row& row) const;
  double calcBracketTapCost(const PlacementData& data, double elapsedTime) const;
  double calcStartCrossover(const PlacementData& data, int rowIndex) const;
  double calcBracketJackCost(const PlacementData& data) const;
  double calcXOBRCost(const PlacementData& data) const;
  double calcXOTransitionCost(const PlacementData& data) const;
  double calcReversalCost(const PlacementData& data) const;
  double calcXORollResolvedCost(const PlacementData& data, const Row& row) const;
  double calcXOStayCost(const PlacementData& data) const;
  double calcDoublestepCost(const PlacementData& data, const Row* lastRow,
                            const Row& row, double elapsedTime) const;
  double calcJumpCost(const PlacementData& data, double elapsedTime) const;
  double calcSlowBracketCost(const PlacementData& data, const Row& row,
                             double elapsedTime) const;
  double calcTwistedFoot(const PlacementData& data) const;
  double calcSpinCost(const PlacementData& data) const;
  double calcSlowFootswitchCost(const PlacementData& data, const Row& row,
                                double elapsedTime) const;
  double calcHoldPartFootswitchCost(const PlacementData& data, const Row& row,
                                    double elapsedTime) const;
  double calcSideswitchCost(const PlacementData& data, const Row& row) const;
  double calcRotationTwistCost(const PlacementData& data) const;
  double calcMissedFootswitchCost(const PlacementData& data, const Row& row,
                                  double elapsedTime) const;
  double calcJackCost(const PlacementData& data, const Row& row,
                      double elapsedTime, bool stepjump = false) const;
  double calcDistanceCost(const PlacementData& data, double elapsedTime,
                          const Rows* rows = nullptr, int rowIndex = 0) const;
  double calcCrowdedBracketCost(const PlacementData& data,
                                double elapsedTime) const;

 private:
  const StageLayout* layout;
  Weights WEIGHTS;

  bool isFootLifted(const ParityState& state, int heel) const;

  double PrimedBracketTapFactor = 0.2;
  double TrailPrimedBracketTapFactor = 0.28;
  double PivotBracketTapFactor = 0.35;
  double SwitchBracketTapFactor = 1;
  bool PivotFromHover = true;
  double BracketTapJackWindow = 0;

  double DoublestepBaseTime = 0.25;
  double CrossedDoublestepFactor = 2;
  double JackDoublestepFactor = 2;
  double HoldDoublestepFreeTime = 0.15;

  double slowBracketThreshold = 0.15;
  double slowBracketCap = 0.5;

  double SlowFootswitchThreshold = 0.18;
  double SlowFootswitchCap = 162.5;

  double HoldPartFootswitchFactor = 0.4;
  double HoldPartFootswitchMaxTime = 0.3;

  double JackMaxElapsedTime = 0.4;
  double StepjumpJackFactor = 0.75;

  double CandleFactor = 1.0;

  double CrowdedBracketMinTime = 0.3;
};

}  // namespace parity
