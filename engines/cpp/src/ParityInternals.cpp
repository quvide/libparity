#include "FloatSemantics.h"

// Parity generation algorithm
// Original algorithm by Jewel, improved by tillvit, improved further by mjvotaw, improved furtherer by tillvit

#include "libparity/ParityInternals.h"

#include <algorithm>
#include <iterator>
#include <cmath>
#include <stdexcept>
#include <utility>

#include "libparity/ParityUtils.h"
#include "libparity/RowStatCalculator.h"

namespace parity {

namespace {

const int8_t NO_COLUMNS[5] = {-1, -1, -1, -1, -1};

constexpr int FOOT_PAIRS[2][2] = {{Foot::LEFT_HEEL, Foot::LEFT_TOE},
                                  {Foot::RIGHT_HEEL, Foot::RIGHT_TOE}};

template <typename C, typename F>
int bsearch(const C& arr, double value, F property) {
  const int length = static_cast<int>(arr.size());
  if (length == 0) return -1;
  if (value >= property(arr[length - 1])) {
    int mid = length - 1;
    while (mid > 0 && property(arr[mid - 1]) == value) mid--;
    return mid;
  }
  int low = 0, high = length;
  while (low <= high && low < length) {
    int mid = static_cast<int>((static_cast<unsigned>(low) + static_cast<unsigned>(high)) >> 1);
    if (property(arr[mid]) == value) {
      while (mid > 0 && property(arr[mid - 1]) == value) mid--;
      return mid;
    }
    if (property(arr[mid]) < value) low = mid + 1;
    if (property(arr[mid]) > value) high = mid - 1;
  }
  return high > 0 ? high : 0;
}

template <typename C, typename F>
std::pair<int, int> getRangeInSortedArray(const C& array, double start,
                                          double end, F index) {
  const int length = static_cast<int>(array.size());
  if (length == 0) return {0, 0};
  auto exists = [&](int i) { return i >= 0 && i < length; };
  int startIdx = bsearch(array, start, index);
  if (index(array[startIdx]) < start) startIdx++;
  while (exists(startIdx - 1) && index(array[startIdx - 1]) == start) {
    startIdx--;
  }

  int endIdx = bsearch(array, end, index);
  if (index(array[endIdx]) > end) endIdx--;
  while (exists(endIdx + 1) && index(array[endIdx + 1]) == end) {
    endIdx++;
  }

  return {startIdx, endIdx + 1};
}

}  // namespace

// Builds rows from the notes at notedata[noteStartIdx..] fed to add() in
// order: add() returns a row once the next row's first note arrives, and
// finish() the last one. Holds and mines before noteStartIdx carry in.
class ParityInternals::RowBuilder {
 public:
  RowBuilder(const ParityInternals& internals, const Notedata& notedata, int noteStartIdx);
  std::optional<Row> add(const NotedataEntry& note);
  std::optional<Row> finish() { return hasNotes ? std::optional<Row>(makeRow()) : std::nullopt; }

 private:
  using Mines = std::array<OptNum, MAX_COLUMNS>;
  const ParityInternals& internals;
  const Notedata& notedata;
  std::unordered_map<const NotedataEntry*, double> rollSteps;
  std::array<const NotedataEntry*, MAX_COLUMNS> activeHolds{};
  Mines nextMines{};
  Mines nextFakeMines{};
  Mines mines{};
  Mines fakeMines{};
  std::vector<MineRow> nextMineRows;
  std::vector<MineRow> mineRows;
  std::optional<double> lastColumnSecond;
  std::optional<double> lastColumnBeat;
  std::array<const NotedataEntry*, MAX_COLUMNS> notes{};
  bool hasNotes = false;
  std::array<FootOverride, MAX_COLUMNS> overrides;
  int emitted = 0;

  Row makeRow();
  double rollStep(const NotedataEntry& hold);
  static void pushMine(std::vector<MineRow>& list, const NotedataEntry& note);
};

ParityInternals::ParityInternals(const std::string& gameType)
    : layout(getStageLayout(gameType)), costCalc(gameType) {
  if (!layout) {
    throw std::invalid_argument("Unsupported game type: " + gameType);
  }
  const int8_t noFeet[MAX_COLUMNS] = {};
  initialState = ParityState(-1, -1, noFeet, layout->columnCount, NO_COLUMNS);
  endState = ParityState(-1, -1, nullptr, 0, NO_COLUMNS);
}

// Same result as compute() on a fresh instance (see batchSearch).
std::optional<ParityComputeData> ParityInternals::computeBatch(double startBeat,
                                                               double endBeat,
                                                               const Notedata& notedata) {
  reset();
  recalculateRows(startBeat, endBeat, notedata);
  const int rowCount = notedataRows.size();
  std::vector<ParityGraphNode> bestNodes;
  bestNodes.reserve(rowCount + 2);
  const auto cost = batchSearch([&](int i) { return i < rowCount; },
                                [&](ParityGraphNode&& node) { bestNodes.push_back(std::move(node)); });
  if (!cost) return std::nullopt;
  for (int i = 0; i < static_cast<int>(bestNodes.size()); i++) setPathChildren(bestNodes[i], i);
  bestNodes.emplace_back(endState);
  return buildResult(bestNodes);
}

std::optional<TechCounts> ParityInternals::computeBatchCounts(double startBeat, double endBeat,
                                                              const Notedata& notedata) {
  reset();
  const auto [noteStartIdx, noteEndIdx] = noteRange(notedata, startBeat, endBeat);
  RowBuilder builder = rowBuilder(notedata, noteStartIdx);
  int next = noteStartIdx;
  bool finished = false;
  auto hasRow = [&](int i) {
    while (notedataRows.size() <= i && !finished) {
      std::optional<Row> row;
      if (next < noteEndIdx) {
        row = builder.add(notedata[next++]);
      } else {
        row = builder.finish();
        finished = true;
      }
      if (row) notedataRows.push_back(std::move(*row));
    }
    return i < notedataRows.size();
  };
  RowStatAccumulator stats(notedataRows, *layout, false);
  // path index: the start node is 0, a row's node is its row + 1
  int index = 0;
  const auto cost = batchSearch(hasRow, [&](ParityGraphNode&& node) {
    setPathChildren(node, index);
    stats.push(std::move(node));
    // later pushes and setPathChildren read rows index - 1 on
    if (index >= 3) notedataRows.release(index - 2);
    index++;
  });
  if (!cost) return std::nullopt;
  return std::move(stats).counts();
}

// Ties break as in compute(): the later same-foot repeat (lastDs), then the
// path whose state is lower (compareStates) where the two paths split. The
// latter is a per-row rank: paths ordered by their parent's rank, then by
// their own state.
//
// Every TracebackRows rows, the path into the current best state is
// committed up to TracebackRows rows back and the states whose path disagrees
// there are dropped, so memory stays bounded by the window. This equals the
// unbounded search unless the best path changes more than TracebackRows rows
// after the fact.
std::optional<double> ParityInternals::batchSearch(
    const std::function<bool(int)>& hasRow,
    const std::function<void(ParityGraphNode&&)>& commit) {
  // A slot is referenced by its children and, while in the frontier, by the
  // frontier; it is freed (and its parent dereferenced) when none remain.
  struct Slot {
    ParityState state;
    StateKey key;
    int row = 0;
    bool reached = false;
    double cost = 0;
    int lastDs = -1;
    int rank = 0;
    int parent = -1;
    int refs = 0;
    int expandedBy = -1;
    bool pruned = false;
  };
  std::vector<Slot> pool;
  std::vector<int> freeSlots;
  auto alloc = [&](ParityState&& state, const StateKey& key, int row) {
    Slot s;
    s.state = std::move(state);
    s.key = key;
    s.row = row;
    if (freeSlots.empty()) {
      pool.push_back(std::move(s));
      return static_cast<int>(pool.size()) - 1;
    }
    const int i = freeSlots.back();
    freeSlots.pop_back();
    pool[i] = std::move(s);
    return i;
  };
  auto unref = [&](int i) {
    while (i != -1 && --pool[i].refs == 0) {
      freeSlots.push_back(i);
      i = pool[i].parent;
    }
  };

  auto relax = [&](Slot& to, const Slot& from, int fromIndex, const ActionCosts& costs,
                   int parentRow) {
    const double newCost = from.cost + costs[COST_TOTAL];
    const int lastDs = costs[COST_DOUBLESTEP] > 0 || costs[COST_JACK] > 0
                           ? parentRow
                           : from.lastDs;
    const bool tie = to.reached && std::fabs(newCost - to.cost) < TieEpsilon &&
                     (lastDs > to.lastDs ||
                      (lastDs == to.lastDs && from.rank < pool[to.parent].rank));
    if (!to.reached || newCost < to.cost - TieEpsilon || tie) {
      to.reached = true;
      to.cost = newCost;
      to.lastDs = lastDs;
      to.parent = fromIndex;
    }
  };
  std::vector<int> frontier;
  auto best = [&](int row) {
    Slot end;
    end.row = row + 1;
    const ActionCosts endCosts;  // { TOTAL: 0 }
    for (int f : frontier) relax(end, pool[f], f, endCosts, row);
    return end;
  };
  const int K = TracebackRows;
  // the first row not committed yet
  int committed = 0;
  std::vector<int> path;
  auto commitThrough = [&](int s) {
    path.clear();
    for (int x = s; x != -1 && pool[x].row >= committed; x = pool[x].parent) path.push_back(x);
    for (auto it = path.rbegin(); it != path.rend(); ++it)
      commit(ParityGraphNode(pool[*it].state, pool[*it].key));
    committed = pool[s].row + 1;
  };

  // Drops a slot when a slot of the same stance with weaker turn memory
  // (none, or the same turn ending no later) is cheaper by more than
  // TurnPruneMargin.
  std::vector<std::pair<StateKey, int>> byStance;
  auto pruneTurnMemory = [&](const std::vector<int>& slots) {
    bool anyTurn = false;
    for (int s : slots)
      if (pool[s].state.lastTurn != Facing::Forward) anyTurn = true;
    if (!anyTurn) return;
    byStance.clear();
    for (int i = 0; i < static_cast<int>(slots.size()); i++)
      byStance.emplace_back(pool[slots[i]].state.stanceKey(), i);
    std::sort(byStance.begin(), byStance.end(), [](const auto& x, const auto& y) {
      const StateKey& p = x.first;
      const StateKey& q = y.first;
      if (p.a != q.a) return p.a < q.a;
      if (p.b != q.b) return p.b < q.b;
      if (p.released != q.released) return p.released < q.released;
      return x.second < y.second;
    });
    auto weaker = [](const ParityState& a, const ParityState& b) {
      return a.lastTurn == Facing::Forward ||
             (a.lastTurn == b.lastTurn && a.lastTurnEnd <= b.lastTurnEnd);
    };
    for (size_t g = 0; g < byStance.size();) {
      size_t end = g + 1;
      while (end < byStance.size() && byStance[end].first == byStance[g].first) end++;
      for (size_t i = g; end - g > 1 && i < end; i++) {
        Slot& b = pool[slots[byStance[i].second]];
        for (size_t j = g; j < end; j++) {
          const Slot& a = pool[slots[byStance[j].second]];
          if (j != i && a.cost + TurnPruneMargin < b.cost && weaker(a.state, b.state)) {
            b.pruned = true;
            break;
          }
        }
      }
      g = end;
    }
  };

  // open addressing over the row's slots: table entry -> pool index, -1 when empty
  std::vector<int> table(64, -1);
  std::vector<int> rowSlots;
  auto findOrCreate = [&](ParityState& state, const StateKey& key, int row) -> int {
    if (rowSlots.size() * 2 >= table.size()) {
      table.assign(table.size() * 2, -1);
      const size_t mask = table.size() - 1;
      for (int s : rowSlots) {
        size_t h = StateKeyHash{}(pool[s].key) & mask;
        while (table[h] != -1) h = (h + 1) & mask;
        table[h] = s;
      }
    }
    const size_t mask = table.size() - 1;
    size_t h = StateKeyHash{}(key) & mask;
    while (table[h] != -1) {
      if (pool[table[h]].key == key) return table[h];
      h = (h + 1) & mask;
    }
    const int s = alloc(std::move(state), key, row);
    table[h] = s;
    rowSlots.push_back(s);
    return s;
  };

  {
    const int start = alloc(ParityState(initialState), initialState.toKey(), -1);
    pool[start].reached = true;
    pool[start].refs = 1;
    hasRow(1);
    commit(ParityGraphNode(initialState, initialState.toKey()));
    frontier.push_back(start);
  }
  std::vector<int> kept;
  std::vector<int> order;
  std::vector<ParityState> generated;
  int expansion = 0;
  int rowIndex = 0;
  for (; hasRow(rowIndex); rowIndex++) {
    // the cost model looks one row ahead (stepjumps)
    hasRow(rowIndex + 1);
    std::fill(table.begin(), table.end(), -1);
    rowSlots.clear();
    for (int f : frontier) {
      expansion++;
      childStates(pool[f].state, rowIndex, generated);
      for (ParityState& childState : generated) {
        const StateKey key = childState.toKey();
        Slot& to = pool[findOrCreate(childState, key, rowIndex)];
        if (to.expandedBy == expansion) continue;
        to.expandedBy = expansion;
        const Slot& from = pool[f];
        const ActionCosts costs =
            costCalc.getActionCost(from.state, to.state, notedataRows, rowIndex);
        relax(to, from, f, costs, rowIndex - 1);
      }
    }
    if (rowSlots.empty()) return std::nullopt;
    if (TurnPruning) pruneTurnMemory(rowSlots);
    kept.clear();
    for (int s : rowSlots) {
      if (pool[s].pruned) {
        freeSlots.push_back(s);
        continue;
      }
      pool[s].refs = 1;
      pool[pool[s].parent].refs++;
      kept.push_back(s);
    }
    for (int f : frontier) unref(f);
    frontier.swap(kept);
    order = frontier;
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) {
      const int ra = pool[pool[a].parent].rank;
      const int rb = pool[pool[b].parent].rank;
      if (ra != rb) return ra < rb;
      return compareStates(pool[a].state, pool[b].state) < 0;
    });
    for (int i = 0; i < static_cast<int>(order.size()); i++) pool[order[i]].rank = i;

    if (rowIndex - committed + 1 >= 2 * K) {
      const int target = rowIndex - K;
      int anchor = best(rowIndex).parent;
      while (pool[anchor].row > target) anchor = pool[anchor].parent;
      commitThrough(anchor);
      kept.clear();
      for (int s : frontier) {
        int x = s;
        while (pool[x].row > target) x = pool[x].parent;
        if (x == anchor)
          kept.push_back(s);
        else
          unref(s);
      }
      frontier.swap(kept);
      const int parent = pool[anchor].parent;
      pool[anchor].parent = -1;
      unref(parent);
    }
  }
  const Slot end = best(rowIndex - 1);
  commitThrough(end.parent);
  return end.cost;
}

void ParityInternals::setPathChildren(ParityGraphNode& node, int rowIndex) {
  node.children.clear();
  if (rowIndex >= notedataRows.size()) return;
  std::vector<ParityState> states;
  childStates(node.state, rowIndex, states);
  for (const ParityState& state : states) {
    const StateKey key = state.toKey();
    if (node.child(key)) continue;
    node.children.emplace_back(key,
                               costCalc.getActionCost(node.state, state, notedataRows, rowIndex));
  }
}

ParityComputeData ParityInternals::buildResult(
    const std::vector<ParityGraphNode>& bestNodes) const {
  ParityComputeData result;
  auto& parityLabels = result.parityLabels;
  auto& holdOwnership = result.holdOwnership;

  for (int idx = 0; idx < static_cast<int>(notedataRows.size()); idx++) {
    const Row& row = notedataRows[idx];
    const ParityGraphNode& bestOption = bestNodes[idx + 1];
    const ParityState& previous = bestNodes[idx].state;
    for (int col = 0; col < bestOption.state.length; col++) {
      const int foot = bestOption.state.combinedColumns[col];
      if (foot == Foot::NONE) continue;
      const NotedataEntry* hold = row.holds[col];
      const int before = previous.combinedAt(col);
      const bool rollTakeover = idx > 0 && hold != nullptr && hold->type == NoteType::Roll &&
                                before != Foot::NONE && before != foot &&
                                before != OTHER_PART_OF_FOOT(foot);
      // holdTails excluded: an "owner change" on the release row is the
      // foot leaving, not a takeover (a roll re-tapped before it ends is one).
      // A roll takeover's entry sits halfway between the rows.
      if (hold != nullptr && (!row.hasHoldTail(col) || rollTakeover)) {
        const double beat = rollTakeover ? (notedataRows[idx - 1].beat + row.beat) / 2 : row.beat;
        const std::string key = toFixed3(hold->beat) + "-" + std::to_string(col);
        auto timeline = holdOwnership.find(key);
        if (timeline == holdOwnership.end()) {
          holdOwnership[key] = {{hold->beat, foot}};
        } else if (timeline->second.back().foot != foot) {
          timeline->second.push_back({beat, foot});
        }
      }
      const NotedataEntry* note = row.notes[col];
      if (note == nullptr) continue;
      const std::string key = toFixed3(note->beat) + "-" + std::to_string(col);
      parityLabels[key] = foot;
      result.labelRows[key] = idx;
      if (isHoldNote(*note)) {
        holdOwnership[key] = {{row.beat, foot}};
      }
    }
  }

  // Keep only holds whose owner changes mid-hold
  for (auto it = holdOwnership.begin(); it != holdOwnership.end();) {
    if (it->second.size() < 2)
      it = holdOwnership.erase(it);
    else
      ++it;
  }

  RowStats rowStats = calculateRowStats(bestNodes, notedataRows, *layout);

  for (const Row& row : notedataRows) result.rowTimestamps.push_back({row.beat, row.second});
  for (int i = 0; i < notedataRows.size(); i++) {
    std::array<int8_t, 5> columns;
    std::copy(std::begin(bestNodes[i + 1].state.footColumns), std::end(bestNodes[i + 1].state.footColumns),
              columns.begin());
    result.footColumnRows.push_back(columns);
  }

  result.techRows = std::move(rowStats.techRows);
  result.mineRows = std::move(rowStats.mineRows);
  result.rollTaps = std::move(rowStats.rollTaps);
  result.techErrors = std::move(rowStats.techErrors);
  result.facingRows = std::move(rowStats.facingRows);
  result.candles = std::move(rowStats.candles);
  result.techCounts = std::move(rowStats.techCounts);
  result.techErrorCounts = std::move(rowStats.techErrorCounts);
  return result;
}

void ParityInternals::recalculateRows(double startBeat, double endBeat,
                                      const Notedata& notedata) {
  auto rowIndex = [](const Row& a) { return jsRound(a.beat * 48); };

  // Remove previous rows in the range
  const auto range = getRangeInSortedArray(notedataRows, jsRound(startBeat * 48),
                                           jsRound(endBeat * 48), rowIndex);
  const int startIdx = range.first;
  const int endIdx = range.second;

  const auto [noteStartIdx, noteEndIdx] = noteRange(notedata, startBeat, endBeat);
  RowBuilder builder = rowBuilder(notedata, noteStartIdx);
  std::vector<Row> rows;
  for (int i = noteStartIdx; i < noteEndIdx; i++) {
    if (auto row = builder.add(notedata[i])) rows.push_back(std::move(*row));
  }
  if (auto last = builder.finish()) rows.push_back(std::move(*last));

  // (The TS source re-keys the row after the range here, for incremental
  // updates; row keys are not kept by this port.)

  notedataRows.splice(startIdx, endIdx, rows);
}

std::pair<int, int> ParityInternals::noteRange(const Notedata& notedata, double startBeat,
                                               double endBeat) const {
  return getRangeInSortedArray(notedata, jsRound(startBeat * 48), jsRound(endBeat * 48),
                               [](const NotedataEntry& a) { return jsRound(a.beat * 48); });
}

ParityInternals::RowBuilder ParityInternals::rowBuilder(const Notedata& notedata,
                                                        int noteStartIdx) const {
  return RowBuilder(*this, notedata, noteStartIdx);
}

ParityInternals::RowBuilder::RowBuilder(const ParityInternals& internals,
                                        const Notedata& notedata, int noteStartIdx)
    : internals(internals), notedata(notedata) {
  overrides.fill(FOOT_OVERRIDE_UNDEFINED);
  // Search backwards to populate holds + mines
  int curIdx = noteStartIdx - 1;
  std::vector<int> columnStatus(internals.layout->columnCount, 0);
  int fulfilledColumns = 0;
  while (curIdx >= 0 && fulfilledColumns < static_cast<int>(columnStatus.size())) {
    const NotedataEntry& note = notedata[curIdx];
    if (note.warped) {
      curIdx--;
      continue;
    }
    if (columnStatus[note.col] == 1) {
      curIdx--;
      continue;
    }
    if (note.type == NoteType::Mine && fulfilledColumns == 0) {
      if (note.fake) {
        if (!nextFakeMines[note.col].has) fakeMines[note.col] = {true, note.second};
      } else {
        if (!nextMines[note.col].has) mines[note.col] = {true, note.second};
        if (!mineRows.empty() && isSameSecond(mineRows.front().second, note.second))
          mineRows.front().columns.insert(mineRows.front().columns.begin(), note.col);
        else
          mineRows.insert(mineRows.begin(), MineRow{note.beat, note.second, {note.col}});
      }
      curIdx--;
      continue;
    }

    if (note.fake) {
      curIdx--;
      continue;
    }

    columnStatus[note.col] = 1;
    fulfilledColumns++;

    if (isHoldNote(note)) {
      activeHolds[note.col] = &note;
    }

    curIdx--;
  }
}

Row ParityInternals::RowBuilder::makeRow() {
  Row row;
  row.notes = notes;
  for (int c = 0; c < MAX_COLUMNS; c++) {
    const NotedataEntry* hold = activeHolds[c];
    if (hold == nullptr || isSameSecond(hold->second, lastColumnSecond) ||
        hold->second > *lastColumnSecond)
      continue;
    row.holds[c] = hold;
  }
  for (int c = 0; c < MAX_COLUMNS; c++) {
    const NotedataEntry* hold = activeHolds[c];
    if (hold == nullptr) continue;
    if (std::fabs(hold->beat + hold->hold - *lastColumnBeat) > 0.0005) continue;
    row.holdTails |= 1u << hold->col;
  }
  row.mines = nextMines;
  row.fakeMines = nextFakeMines;
  row.mineRows = nextMineRows;
  row.second = *lastColumnSecond;
  row.beat = *lastColumnBeat;
  row.overrides = overrides;
  for (int c = 0; c < MAX_COLUMNS; c++) {
    if (row.holds[c] != nullptr && row.holds[c]->type == NoteType::Roll)
      row.rollSteps[c] = {true, rollStep(*row.holds[c])};
  }
  internals.applyHoldOverrides(row);
  emitted++;
  return row;
}

double ParityInternals::RowBuilder::rollStep(const NotedataEntry& hold) {
  const auto cached = rollSteps.find(&hold);
  if (cached != rollSteps.end()) return cached->second;
  auto isStep = [](const NotedataEntry& n) {
    return !n.warped && !n.fake && n.type != NoteType::Mine;
  };
  double step = INFINITY;
  const auto [start, end] = internals.noteRange(notedata, hold.beat, hold.beat);
  for (int i = start - 1; i >= 0; i--) {
    if (!isStep(notedata[i]) || isSameSecond(notedata[i].second, hold.second)) continue;
    step = hold.second - notedata[i].second;
    break;
  }
  for (int i = end; i < static_cast<int>(notedata.size()); i++) {
    if (!isStep(notedata[i]) || isSameSecond(notedata[i].second, hold.second)) continue;
    step = jsMin(step, notedata[i].second - hold.second);
    break;
  }
  rollSteps.emplace(&hold, step);
  return step;
}

void ParityInternals::RowBuilder::pushMine(std::vector<MineRow>& list, const NotedataEntry& note) {
  if (!list.empty() && isSameSecond(list.back().second, note.second))
    list.back().columns.push_back(note.col);
  else
    list.push_back({note.beat, note.second, {note.col}});
}

std::optional<Row> ParityInternals::RowBuilder::add(const NotedataEntry& note) {
  if (note.warped) return std::nullopt;
  if (note.type == NoteType::Mine) {
    if (isSameSecond(note.second, lastColumnSecond) && emitted > 0) {
      if (note.fake) {
        nextFakeMines[note.col] = {true, note.second};
      } else {
        nextMines[note.col] = {true, note.second};
        pushMine(nextMineRows, note);
      }
    } else {
      if (note.fake) {
        fakeMines[note.col] = {true, note.second};
      } else {
        mines[note.col] = {true, note.second};
        pushMine(mineRows, note);
      }
    }
    return std::nullopt;
  }
  if (note.fake) return std::nullopt;
  std::optional<Row> row;
  if (!isSameSecond(lastColumnSecond, note.second)) {
    if (lastColumnSecond && lastColumnBeat) {
      row = makeRow();
    }
    lastColumnSecond = note.second;
    lastColumnBeat = note.beat;
    notes = {};
    hasNotes = false;
    overrides.fill(FOOT_OVERRIDE_UNDEFINED);
    nextMines = mines;
    nextFakeMines = fakeMines;
    nextMineRows = std::move(mineRows);
    mines = {};
    fakeMines = {};
    mineRows.clear();
    for (auto& hold : activeHolds) {
      if (hold != nullptr &&
          jsRound(note.beat * 48) > jsRound((hold->beat + hold->hold) * 48))
        hold = nullptr;
    }
  }
  notes[note.col] = &note;
  hasNotes = true;
  if (isFootOverrideTruthy(note.override)) overrides[note.col] = note.override;
  if (isHoldNote(note)) {
    activeHolds[note.col] = &note;
  }
  return row;
}

// Successor states of `state` on row `rowIndex`, in generation order.
void ParityInternals::childStates(const ParityState& state, int rowIndex,
                                  std::vector<ParityState>& states) {
  const Row& row = notedataRows[rowIndex];
  const std::vector<Action>* permutations = &getPossibleActions(row);
  std::vector<Action> filtered;
  bool anyOverride = false;
  for (FootOverride o : row.overrides)
    if (o != FOOT_OVERRIDE_UNDEFINED) anyOverride = true;
  if (anyOverride) {
    filtered = filterActions(row, *permutations, row.overrides);
    permutations = &filtered;
  }
  states.clear();
  for (const Action& permutation : *permutations) {
    ParityState baseState = initResultState(state, row, permutation);
    if (!applyReleases(state, rowIndex > 0 ? &notedataRows[rowIndex - 1] : nullptr, row, baseState,
                       rowIndex == notedataRows.size() - 1))
      continue;
    stanceVariants(state, row, baseState, variantsBuffer);
    for (const ParityState& newState : variantsBuffer) {
      states.push_back(newState);
      const auto crosses = layout->crossedFeet(newState);
      if (newState.facing != Facing::Forward && !crosses.leftOnRight &&
          !crosses.rightOnLeft) {
        states.push_back(newState.cloneWithFacing(Facing::Forward));
      }
    }
  }
  if (state.facing == Facing::Forward) {
    for (ParityState& s : states) {
      if (s.facing == Facing::Forward) continue;
      for (int c : layout->sideArrows) {
        if (row.notes[c] == nullptr || row.notes[c]->type != NoteType::Roll ||
            s.action[c] == Foot::NONE)
          continue;
        const bool left = s.action[c] == Foot::LEFT_HEEL || s.action[c] == Foot::LEFT_TOE;
        if (left == includes(layout->rightArrows, c)) s.crossedOntoRoll = static_cast<int8_t>(c);
      }
    }
  }
}

uint32_t ParityInternals::calculatePermuteColumnKey(const Row& row) const {
  uint32_t s = 0;
  for (int i = 0; i < layout->columnCount; i++) {
    if (row.notes[i])
      s |= 1u << i;
    else if (row.holds[i])
      s |= 1u << (i + MAX_COLUMNS);
  }
  return s;
}

const std::vector<Action>& ParityInternals::getPossibleActions(const Row& row) {
  const uint32_t cacheKey = calculatePermuteColumnKey(row);
  auto it = permuteCache.find(cacheKey);
  if (it == permuteCache.end()) {
    Action columns;
    columns.fill(Foot::NONE);
    std::vector<Action> permuteColumns;
    generateActions(row, columns, 0, permuteColumns);
    it = permuteCache.emplace(cacheKey, std::move(permuteColumns)).first;
  }
  return it->second;
}

// Recursively generates all permutations of Foot positions given a Row
void ParityInternals::generateActions(const Row& row, Action columns, int column,
                                      std::vector<Action>& out) const {
  const int length = layout->columnCount;
  if (column >= length) {
    int leftHeelIndex = -1;
    int leftToeIndex = -1;
    int rightHeelIndex = -1;
    int rightToeIndex = -1;
    for (int i = 0; i < length; i++) {
      if (columns[i] == Foot::NONE) continue;
      if (columns[i] == Foot::LEFT_HEEL) leftHeelIndex = i;
      if (columns[i] == Foot::LEFT_TOE) leftToeIndex = i;
      if (columns[i] == Foot::RIGHT_HEEL) rightHeelIndex = i;
      if (columns[i] == Foot::RIGHT_TOE) rightToeIndex = i;
    }
    if ((leftHeelIndex == -1 && leftToeIndex != -1) ||
        (rightHeelIndex == -1 && rightToeIndex != -1)) {
      return;
    }
    if (leftHeelIndex != -1 && leftToeIndex != -1) {
      if (!layout->bracketCheck(leftHeelIndex, leftToeIndex)) return;
    }
    if (rightHeelIndex != -1 && rightToeIndex != -1) {
      if (!layout->bracketCheck(rightHeelIndex, rightToeIndex)) return;
    }
    out.push_back(columns);
    return;
  }
  if (row.notes[column] || row.holds[column]) {
    for (int foot : FEET) {
      bool used = false;
      for (int i = 0; i < length; i++)
        if (columns[i] == foot) used = true;
      if (used) continue;
      Action newColumns = columns;
      newColumns[column] = static_cast<int8_t>(foot);
      generateActions(row, newColumns, column + 1, out);
    }
    // a hold body may be released (childStates decides when)
    if (!row.notes[column]) generateActions(row, columns, column + 1, out);
    return;
  }
  generateActions(row, columns, column + 1, out);
}

// Apply overrides to the permuted columns (only use permutations that actually match the overrides)
std::vector<Action> ParityInternals::filterActions(
    const Row& row, const std::vector<Action>& permuteColumns,
    const std::array<FootOverride, MAX_COLUMNS>& overrides) const {
  (void)row;
  // Check for invalid overrides
  int counts[5] = {};
  int footCountsLeft = 0;
  int footCountsRight = 0;
  for (FootOverride foot : overrides) {
    if (isFootOverrideNumber(foot)) {
      counts[foot]++;
    } else if (foot == FOOT_OVERRIDE_LEFT) {
      footCountsLeft++;
    } else if (foot == FOOT_OVERRIDE_RIGHT) {
      footCountsRight++;
    }
  }
  // i < FEET.length: RIGHT_TOE is not checked
  for (int i = 1; i < 4; i++) {
    if (counts[i] > 1) {
      return permuteColumns;
    }
  }
  if (footCountsLeft + counts[Foot::LEFT_HEEL] + counts[Foot::LEFT_TOE] > 2 ||
      footCountsRight + counts[Foot::RIGHT_HEEL] + counts[Foot::RIGHT_TOE] > 2) {
    return permuteColumns;
  }
  std::vector<Action> updatedColumns;
  for (const Action& pc : permuteColumns) {
    bool keep = true;
    for (int c = 0; c < layout->columnCount && keep; c++) {
      const FootOverride noteOverride = overrides[c];
      if (noteOverride == FOOT_OVERRIDE_UNDEFINED) continue;
      // Check for exact heel/toe overrides
      if (isFootOverrideNumber(noteOverride) && pc[c] != noteOverride) {
        keep = false;
      } else if (noteOverride == FOOT_OVERRIDE_LEFT) {
        if (pc[c] != Foot::LEFT_HEEL && pc[c] != Foot::LEFT_TOE) keep = false;
      } else if (noteOverride == FOOT_OVERRIDE_RIGHT) {
        if (pc[c] != Foot::RIGHT_HEEL && pc[c] != Foot::RIGHT_TOE) keep = false;
      }
    }
    if (keep) updatedColumns.push_back(pc);
  }

  if (updatedColumns.empty()) {
    return permuteColumns;
  }

  return updatedColumns;
}

// a foot standing on a panel whose mine passed since the last row lifts off
// it (MD); a foot holding that panel is not affected
bool ParityInternals::dodgesMine(const ParityState& initialState, const Row& row, int heel) {
  for (int part : {heel, OTHER_PART_OF_FOOT(heel)}) {
    const int col = initialState.footColumns[part];
    if (col != -1 && row.mines[col].has && row.holds[col] == nullptr) return true;
  }
  return false;
}

// Creates the resulting state after applying the action to the initial state
ParityState ParityInternals::initResultState(const ParityState& initialState,
                                             const Row& row,
                                             const Action& action) const {
  const int columnCount = layout->columnCount;
  ParityState resultState(row.second, row.beat, action.data(), columnCount, NO_COLUMNS);

  // Merge initial + result position
  for (int i = 0; i < columnCount; i++) {
    resultState.combinedColumns[i] = Foot::NONE;
    if (action[i] == Foot::NONE) {
      continue;
    }
    resultState.footColumns[action[i]] = static_cast<int8_t>(i);
    resultState.combinedColumns[i] = action[i];
    if (row.holds[i] == nullptr) {
      resultState.movedFeet.add(action[i]);
    } else if (initialState.combinedAt(i) != action[i] &&
               initialState.combinedAt(i) != OTHER_PART_OF_FOOT(action[i])) {
      resultState.movedFeet.add(action[i]);
    }
    if (row.holds[i] != nullptr) {
      resultState.holdFeet.add(action[i]);
    }
  }
  // A foot holding with one part keeps its other part where the stance
  // left it, in the orientation it had. Dropped once the panel is taken.
  for (const auto& pair : FOOT_PAIRS) {
    const int heel = pair[0];
    const int toe = pair[1];
    const int hc = resultState.footColumns[heel];
    if (hc == -1 || resultState.footColumns[toe] != -1) continue;
    if (row.holds[hc] == nullptr) continue;
    const int ih = initialState.footColumns[heel];
    const int it = initialState.footColumns[toe];
    // the free part's panel, if it had one, and whether the other foot took it
    const int freeCol = ih == hc ? it : it == hc ? ih : -1;
    const bool taken = freeCol != -1 && resultState.combinedColumns[freeCol] != Foot::NONE;
    if (ih == hc && it != -1 && it != hc && !taken) {
      resultState.footColumns[toe] = static_cast<int8_t>(it);
      resultState.combinedColumns[it] = static_cast<int8_t>(toe);
    } else if (it == hc && ih != -1 && ih != hc && !taken) {
      resultState.footColumns[toe] = static_cast<int8_t>(hc);
      resultState.footColumns[heel] = static_cast<int8_t>(ih);
      resultState.combinedColumns[hc] = static_cast<int8_t>(toe);
      resultState.combinedColumns[ih] = static_cast<int8_t>(heel);
      resultState.action[hc] = static_cast<int8_t>(toe);
      resultState.holdFeet.remove(heel);
      resultState.holdFeet.add(toe);
    }
  }
  // Fill in previous position, unless another foot took the column, except
  // for a foot a mine passed under: it lifted off to the center (a ghost
  // step) and is planted nowhere.
  if (resultState.footColumns[Foot::LEFT_HEEL] == -1 && !dodgesMine(initialState, row, Foot::LEFT_HEEL)) {
    for (int part : {Foot::LEFT_HEEL, Foot::LEFT_TOE}) {
      const int prevCol = initialState.footColumns[part];
      if (prevCol == -1) continue;
      if (resultState.combinedColumns[prevCol] == Foot::NONE) {
        resultState.footColumns[part] = static_cast<int8_t>(prevCol);
        resultState.combinedColumns[prevCol] = static_cast<int8_t>(part);
      }
    }
  }
  if (resultState.footColumns[Foot::RIGHT_HEEL] == -1 && !dodgesMine(initialState, row, Foot::RIGHT_HEEL)) {
    for (int part : {Foot::RIGHT_HEEL, Foot::RIGHT_TOE}) {
      const int prevCol = initialState.footColumns[part];
      if (prevCol == -1) continue;
      if (resultState.combinedColumns[prevCol] == Foot::NONE) {
        resultState.footColumns[part] = static_cast<int8_t>(prevCol);
        resultState.combinedColumns[prevCol] = static_cast<int8_t>(part);
      }
    }
  }
  // Travel bookkeeping: a foot traveled if it pressed a column it wasn't
  // already occupying (re-presses move without traveling).
  for (const auto& pair : FOOT_PAIRS) {
    const int heel = pair[0];
    const int toe = pair[1];
    const int oldCols[2] = {initialState.footColumns[heel], initialState.footColumns[toe]};
    for (int c = 0; c < columnCount; c++) {
      if (action[c] != heel && action[c] != toe) continue;
      if (oldCols[0] != c && oldCols[1] != c) {
        resultState.traveledFeet.add(heel);
        break;
      }
    }
  }

  // Hover (ParityState.hover): a foot standing on one panel remembers the
  // adjacent panel its free part trails over.
  for (const auto& pair : FOOT_PAIRS) {
    const int heel = pair[0];
    const int toe = pair[1];
    resultState.hover[heel] = -1;
    resultState.hoverPivot[heel] = false;
    if (!HoverEnabled) continue;
    const int hc = resultState.footColumns[heel];
    const int tc = resultState.footColumns[toe];
    if ((hc == -1) == (tc == -1)) continue;
    const int b = hc != -1 ? hc : tc;
    auto free = [&](int c) {
      return c != -1 && c != b && resultState.combinedColumns[c] == Foot::NONE;
    };
    const int ih = initialState.footColumns[heel];
    const int it = initialState.footColumns[toe];
    if (resultState.traveledFeet.has(heel)) {
      for (int a : {ih, it}) {
        if (free(a) && layout->bracketCheck(a, b)) {
          resultState.hover[heel] = static_cast<int8_t>(a);
          break;
        }
      }
    } else if (free(initialState.hover[heel])) {
      resultState.hover[heel] = initialState.hover[heel];
      resultState.hoverPivot[heel] = initialState.hoverPivot[heel];
    } else if (ih != -1 && it != -1 && row.holds[b] != nullptr) {
      // the planted free part was taken this row: the foot re-orients on
      // the hold towards its other neighbour
      for (int c = 0; c < columnCount; c++) {
        if (free(c) && layout->bracketCheck(c, b)) {
          resultState.hover[heel] = static_cast<int8_t>(c);
          resultState.hoverPivot[heel] = true;
          break;
        }
      }
    }
  }

  orient(initialState, resultState);
  return resultState;
}

// Alternative result states for a row in a bracket phrase (both feet on two
// panels each).
void ParityInternals::stanceVariants(const ParityState& initialState, const Row& row,
                                     const ParityState& base,
                                     std::vector<ParityState>& variants) const {
  variants.clear();
  variants.push_back(base);
  bool anyLifted = false;
  for (int i = 1; i < 5; i++)
    if (initialState.footColumns[i] == -1) anyLifted = true;
  int pressed = 0;
  for (int c = 0; c < layout->columnCount; c++)
    if (row.notes[c] != nullptr || (row.holds[c] != nullptr && !row.hasHoldTail(c))) pressed++;
  if (!KeepStanceAllCovered || anyLifted || pressed < 3) return;
  for (const auto& pair : FOOT_PAIRS) {
    const int heel = pair[0];
    const int toe = pair[1];
    const int bh = base.footColumns[heel];
    const int bt = base.footColumns[toe];
    if ((bh == -1) == (bt == -1)) continue;
    const int c = bh != -1 ? bh : bt;
    if (row.holds[c] != nullptr) continue;
    const int ih = initialState.footColumns[heel];
    const int it = initialState.footColumns[toe];
    if (c != ih && c != it) continue;
    const int d = c == ih ? it : ih;
    const int partAtC = c == ih ? heel : toe;
    const int partAtD = c == ih ? toe : heel;
    const size_t snapshot = variants.size();
    for (size_t vi = 0; vi < snapshot; vi++) {
      if (variants[vi].combinedColumns[d] != Foot::NONE || variants[vi].isReleased(d)) continue;
      ParityState v = variants[vi].cloneWithFacing(variants[vi].facing);
      const int pressed = v.action[c];
      v.action[c] = static_cast<int8_t>(partAtC);
      v.combinedColumns[c] = static_cast<int8_t>(partAtC);
      v.combinedColumns[d] = static_cast<int8_t>(partAtD);
      v.footColumns[partAtC] = static_cast<int8_t>(c);
      v.footColumns[partAtD] = static_cast<int8_t>(d);
      if (pressed != partAtC) {
        v.movedFeet.remove(pressed);
        v.movedFeet.add(partAtC);
      }
      v.hover[heel] = -1;
      v.hoverPivot[heel] = false;
      orient(initialState, v);
      variants.push_back(v);
    }
  }
}

namespace {
double releaseWindow(const NotedataEntry& hold) {
  return hold.type == NoteType::Roll ? ROLL_RELEASE_WINDOW : HOLD_RELEASE_WINDOW;
}
}  // namespace

// A hold or roll with no foot on it after this row is released. A new
// release needs a foot that covered it on the previous row to leave it (a
// hold not on its tail row; leaving a roll on its tail row is free); a
// release lasts while its window does. Returns false for a state that is
// invalid or the duplicate of a covered one.
bool ParityInternals::applyReleases(const ParityState& initialState, const Row* lastRow,
                                    const Row& row, ParityState& resultState,
                                    bool lastOfChart) const {
  // a hold that ends before this row with no foot on it must end within its window
  for (int c = 0; c < MAX_COLUMNS; c++) {
    if (!initialState.isReleased(c) || lastRow == nullptr) continue;
    const double since = initialState.released[c];
    const NotedataEntry* hold = lastRow->holds[c];
    if (hold == nullptr || row.holds[c] == hold) continue;
    const double end = hold->beat + hold->hold;
    const double endSecond = lastRow->second + ((end - lastRow->beat) / (row.beat - lastRow->beat)) *
                                                   (row.second - lastRow->second);
    if (endSecond - since > releaseWindow(*hold) + SECOND_EPSILON) return false;
  }
  for (int c = 0; c < MAX_COLUMNS; c++) {
    const NotedataEntry* hold = row.holds[c];
    if (hold == nullptr) continue;
    if (resultState.combinedAt(c) != Foot::NONE) {
      if (resultState.actionAt(c) == Foot::NONE) return false;
      continue;
    }
    const bool continued = lastRow != nullptr && lastRow->holds[c] == hold && initialState.isReleased(c);
    if (continued) {
      const double since = initialState.released[c];
      if (row.second - since > releaseWindow(*hold) + SECOND_EPSILON) return false;
      resultState.released[c] = since;
    } else if (initialState.combinedAt(c) != Foot::NONE &&
               (hold->type == NoteType::Roll || !row.hasHoldTail(c)) &&
               hold->second < initialState.second + SECOND_EPSILON) {
      resultState.released[c] = row.second;
    } else {
      return false;
    }
    // after the last row nobody steps back on: the hold must end within the window (tempo of the last gap)
    if (lastOfChart && lastRow != nullptr) {
      const double end = hold->beat + hold->hold;
      const double endSecond = row.second + ((end - row.beat) / (row.beat - lastRow->beat)) *
                                                (row.second - lastRow->second);
      if (endSecond - resultState.released[c] > releaseWindow(*hold) + SECOND_EPSILON) return false;
    }
  }
  return true;
}

// Front foot and facing of a result state from its foot positions.
void ParityInternals::orient(const ParityState& initialState,
                             ParityState& resultState) const {
  const Pos leftPos = layout->averagePoint(resultState.leftHeel(), resultState.leftToe());
  const Pos rightPos =
      layout->averagePoint(resultState.rightHeel(), resultState.rightToe());

  if (leftPos.y > rightPos.y) {
    resultState.frontFoot = Foot::LEFT_HEEL;
  } else if (rightPos.y > leftPos.y) {
    resultState.frontFoot = Foot::RIGHT_HEEL;
  } else {
    resultState.frontFoot = initialState.frontFoot;
  }

  auto lifted = [](const ParityState& s, int heel) {
    return s.footColumns[heel] == -1 && s.footColumns[OTHER_PART_OF_FOOT(heel)] == -1;
  };
  const bool oneLifted =
      lifted(resultState, Foot::LEFT_HEEL) || lifted(resultState, Foot::RIGHT_HEEL);
  auto direction = [&]() {
    return resultState.frontFoot == Foot::LEFT_HEEL ? Facing::Right : Facing::Left;
  };

  resultState.facing = initialState.facing;
  resultState.facingProvisional = false;
  if (resultState.facing == Facing::Forward) {
    const auto crossed = layout->crossedFeet(resultState);

    if (crossed.leftOnRight || crossed.rightOnLeft) {
      resultState.facing = static_cast<int8_t>(direction());
      // with a foot in the air the front foot is the previous row's: the
      // direction is a guess until that foot lands
      resultState.facingProvisional = oneLifted;
    }
  } else if (initialState.facingProvisional && !oneLifted) {
    // the lifted foot has landed: read the direction from the feet
    const auto crossed = layout->crossedFeet(resultState);
    resultState.facing = static_cast<int8_t>(
        crossed.leftOnRight || crossed.rightOnLeft ? direction() : Facing::Forward);
  } else {
    if (initialState.facingProvisional) resultState.facingProvisional = true;
    // force uncross
    const bool facingRight = resultState.facing == Facing::Right;
    const bool facingLeft = resultState.facing == Facing::Left;

    const bool leftHeelDown =
        includes(layout->downArrows, resultState.footColumns[Foot::LEFT_HEEL]);
    const bool leftHeelUp =
        includes(layout->upArrows, resultState.footColumns[Foot::LEFT_HEEL]);

    const bool rightHeelDown =
        includes(layout->downArrows, resultState.footColumns[Foot::RIGHT_HEEL]);
    const bool rightHeelUp =
        includes(layout->upArrows, resultState.footColumns[Foot::RIGHT_HEEL]);

    const bool leftCrossImpossible = facingLeft && (rightHeelDown || leftHeelUp);
    const bool rightCrossImpossible = facingRight && (leftHeelDown || rightHeelUp);

    if (rightCrossImpossible || leftCrossImpossible) {
      resultState.facing = Facing::Forward;
    }
  }
  resultState.lastTurn = initialState.lastTurn;
  resultState.lastTurnEnd = initialState.lastTurnEnd;
  if (initialState.facing != Facing::Forward && resultState.facing == Facing::Forward) {
    resultState.lastTurn = initialState.facing;
    resultState.lastTurnEnd = resultState.second;
  }
  // forgotten once out of the window, so it does not split graph states
  if (resultState.second - resultState.lastTurnEnd >= REVERSAL_WINDOW) {
    resultState.lastTurn = Facing::Forward;
    resultState.lastTurnEnd = -INFINITY;
  }
}

// Takeover annotations on a hold body (parity.holdOverrides) become row
// overrides; a note override on the same column wins.
void ParityInternals::applyHoldOverrides(Row& row) const {
  for (int col = 0; col < MAX_COLUMNS; col++) {
    const NotedataEntry* hold = row.holds[col];
    if (hold == nullptr || row.overrides[col] != FOOT_OVERRIDE_UNDEFINED) continue;
    const FootOverride override = holdOverrideAt(*hold, row.beat);
    if (override != FOOT_OVERRIDE_UNDEFINED) row.overrides[col] = override;
  }
}

bool ParityInternals::isSameSecond(std::optional<double> second1,
                                   std::optional<double> second2) {
  if (!second1 || !second2) {
    return false;
  }
  return std::fabs(*second1 - *second2) < SECOND_EPSILON;
}

void ParityInternals::reset() {
  notedataRows.clear();
  permuteCache.clear();
}

}  // namespace parity
