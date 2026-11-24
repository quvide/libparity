#pragma once

#include <array>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "Analysis.h"
#include "NoteTypes.h"
#include "ParityCost.h"
#include "ParityDataTypes.h"
#include "ParityResultTypes.h"
#include "StageLayouts.h"

namespace parity {

class ParityGraphNode {
 public:
  // child key -> costs, in insertion order (filled for best-path nodes)
  std::vector<std::pair<StateKey, ActionCosts>> children;

  ParityState state;
  StateKey key;

  ParityGraphNode() = default;
  explicit ParityGraphNode(const ParityState& state)
      : state(state), key(state.toKey()) {}
  ParityGraphNode(const ParityState& state, const StateKey& key)
      : state(state), key(key) {}

  const ActionCosts* child(const StateKey& childKey) const {
    for (const auto& c : children)
      if (c.first == childKey) return &c.second;
    return nullptr;
  }
};

using Action = std::array<int8_t, MAX_COLUMNS>;

// Port of the batch path of the TS ParityInternals: computeBatch() and what it
// calls. The incremental compute(), its edge caches, debug data and
// setWeights are not ported.
class ParityInternals {
 public:
  explicit ParityInternals(const std::string& gameType);

  // Rows keep pointers into `notedata`; it must outlive the call.
  std::optional<ParityComputeData> computeBatch(double startBeat, double endBeat,
                                                const Notedata& notedata);

  // computeBatch's tech and error counts, holding only the rows and states of
  // the traceback window.
  std::optional<TechCounts> computeBatchCounts(double startBeat, double endBeat,
                                               const Notedata& notedata);

  // rows a committed path node trails the search front by, at least
  static constexpr int TracebackRows = 128;

  Rows notedataRows;

  // Regenerates the rows for the given range of beats.
  void recalculateRows(double startBeat, double endBeat, const Notedata& notedata);

  const std::vector<Action>& getPossibleActions(const Row& row);
  void generateActions(const Row& row, Action columns, int column,
                       std::vector<Action>& out) const;
  std::vector<Action> filterActions(const Row& row,
                                    const std::vector<Action>& permuteColumns,
                                    const std::array<FootOverride, MAX_COLUMNS>& overrides) const;
  ParityState initResultState(const ParityState& initialState, const Row& row,
                              const Action& action) const;
  static bool dodgesMine(const ParityState& initialState, const Row& row, int heel);
  // the variants replace the contents of `variants`
  void stanceVariants(const ParityState& initialState, const Row& row,
                      const ParityState& base, std::vector<ParityState>& variants) const;

  void reset();

 private:
  const StageLayout* layout;
  ParityCostCalculator costCalc;

  ParityState initialState;
  ParityState endState;

  static constexpr double TieEpsilon = 1e-6;
  static constexpr double TurnPruneMargin = 1e-3;
  bool TurnPruning = true;
  bool KeepStanceAllCovered = true;
  bool HoverEnabled = true;

  // keyed by the mask of columns with a note, and (shifted by MAX_COLUMNS)
  // the mask of columns with only a hold
  std::unordered_map<uint32_t, std::vector<Action>> permuteCache;

  // One forward pass over rows 0.. (while hasRow), keeping per row the best
  // path into each state. Passes the best path's nodes but the end node to
  // commit() in order and returns its cost, or nullopt when no path exists
  // (commit() may have been called by then). hasRow(i) must make rows 0..i
  // available; a node is committed once the two rows after it are.
  std::optional<double> batchSearch(const std::function<bool(int)>& hasRow,
                                    const std::function<void(ParityGraphNode&&)>& commit);
  // the children compute() leaves on a best-path node: the edges into row
  // `rowIndex` (the node's row + 1) with their costs
  void setPathChildren(ParityGraphNode& node, int rowIndex);
  ParityComputeData buildResult(const std::vector<ParityGraphNode>& bestNodes) const;
  std::pair<int, int> noteRange(const Notedata& notedata, double startBeat,
                                double endBeat) const;
  class RowBuilder;
  RowBuilder rowBuilder(const Notedata& notedata, int noteStartIdx) const;
  // the states replace the contents of `states`
  void childStates(const ParityState& state, int rowIndex, std::vector<ParityState>& states);
  std::vector<ParityState> variantsBuffer;
  void orient(const ParityState& initialState, ParityState& resultState) const;
  bool applyReleases(const ParityState& initialState, const Row* lastRow, const Row& row,
                     ParityState& resultState, bool lastOfChart) const;
  void applyHoldOverrides(Row& row) const;
  uint32_t calculatePermuteColumnKey(const Row& row) const;
  static bool isSameSecond(std::optional<double> second1,
                           std::optional<double> second2);
};

}  // namespace parity
