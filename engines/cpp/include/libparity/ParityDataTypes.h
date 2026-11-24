#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

#include "JsCompat.h"
#include "NoteTypes.h"

namespace parity {

constexpr int MAX_COLUMNS = 8;

namespace Foot {
constexpr int NONE = 0;
constexpr int LEFT_HEEL = 1;
constexpr int LEFT_TOE = 2;
constexpr int RIGHT_HEEL = 3;
constexpr int RIGHT_TOE = 4;
}  // namespace Foot

constexpr int FEET[4] = {Foot::LEFT_HEEL, Foot::LEFT_TOE, Foot::RIGHT_HEEL,
                         Foot::RIGHT_TOE};

// OTHER_PART_OF_FOOT[foot]; undefined (UNDEF) for anything but a foot
inline int OTHER_PART_OF_FOOT(int foot) {
  static constexpr int table[5] = {Foot::NONE, Foot::LEFT_TOE, Foot::LEFT_HEEL,
                                   Foot::RIGHT_TOE, Foot::RIGHT_HEEL};
  return foot >= 0 && foot <= 4 ? table[foot] : UNDEF;
}

// English defaults for an enumeration value; `code` is the stable identifier
struct CodeInfo {
  const char* code;
  const char* name;
  const char* description;
};

template <std::size_t N>
std::optional<int> fromCode(const CodeInfo (&table)[N], std::string_view code) {
  for (std::size_t i = 0; i < N; i++)
    if (code == table[i].code) return static_cast<int>(i);
  return std::nullopt;
}

// indexed by Foot
inline constexpr CodeInfo FOOT_INFO[5] = {
    {".", "None",
     "No foot: mines, fakes and notes without an assigned foot."},
    {"L", "Left Heel",
     "The heel of the left foot. A foot on a single panel is labeled by its heel."},
    {"l", "Left Toe",
     "The toe of the left foot, on a second panel (brackets and bracket-taps)."},
    {"R", "Right Heel",
     "The heel of the right foot. A foot on a single panel is labeled by its heel."},
    {"r", "Right Toe",
     "The toe of the right foot, on a second panel (brackets and bracket-taps)."},
};

inline std::optional<int> footFromCode(std::string_view code) { return fromCode(FOOT_INFO, code); }

struct Weights {
  double DOUBLESTEP = 100;
  double BRACKETJACK = 60;
  double JACK = 80;
  double JUMP = 100;
  double SLOW_BRACKET = 300;
  double TWISTED_FOOT = 100000;
  double BRACKETTAP = 400;
  double XO_BR = 200;
  double HOLDSWITCH = 500;
  double HOLD_RELEASE = 500;
  double ROLLSWITCH = 50;
  double MINE = 10000;
  double MINE_DODGE = 200;
  double FOOTSWITCH = 325;
  double MISSED_FOOTSWITCH = 500;
  double FACING = 3;
  double DISTANCE = 6;
  double SPIN = 3000;
  double SIDESWITCH = 150;
  double CROWDED_BRACKET = 100;
  double OTHER = 0;
  double START_XO = 10000;
  double XO_JUMP = 600;
  double XO_ENTRY = 150;
  double XO_STAY = 30;
  double LIFTED_DS = 1500;
  double DS_JUMP = 100;
};

const Weights DEFAULT_WEIGHTS{};

enum TechCategory {
  Crossovers = 0,
  Footswitches,
  Sideswitches,
  Jacks,
  Brackets,
  Doublesteps,
  Holdswitch,
  Jumps,
  Brackettaps,
  Stepjumps,
  Kickswitches,
  LateralCrossovers,
  MineDodges,
  TechCategoryCount,
};

// indexed by TechCategory
inline constexpr CodeInfo TECH_INFO[TechCategoryCount] = {
    {"XO", "Crossover",
     "One of the player's feet crosses over the other foot."},
    {"FS", "Footswitch",
     "The player uses alternating feet to hit the same arrow."},
    {"SS", "Sideswitch",
     "The player uses alternating feet to hit the same arrow. The arrow appears on the left or right side of the stage."},
    {"JA", "Jack",
     "The player uses the same foot to hit the same arrow."},
    {"BR", "Bracket",
     "The player uses one foot to diagonally hit two arrows at once."},
    {"DS", "Doublestep",
     "The player uses the same foot twice in a row to hit two different arrows."},
    {"HS", "Holdswitch",
     "The player swaps which foot is holding a hold."},
    {"JU", "Jump",
     "The player hits multiple arrows with both feet at the same time."},
    {"BT", "Bracket-tap",
     "One part of a foot taps an adjacent arrow while the other part stays on a hold."},
    {"SJ", "Stepjump",
     "A single sandwiched between jumps, or a jump sandwiched between singles (single-jump-single / jump-single-jump)."},
    {"KS", "Kickswitch",
     "Nickname for a combined FS DS"},
    {"LX", "Lateral crossover",
     "A foot crosses over onto the far side panel while the other foot is already on the opposite side panel, so both feet are crossed."},
    {"MD", "Mine dodge",
     "A mine lands on a panel a foot is standing on, and the next step does not lift that foot anyway: the player lifts it just to avoid the mine."},
};

inline std::optional<int> techFromCode(std::string_view code) { return fromCode(TECH_INFO, code); }

enum TechErrors {
  UnmarkedDoublestep = 0,
  MissedFootswitch,
  Ambiguous,
  TechErrorCount,
};

// indexed by TechErrors
inline constexpr CodeInfo TECH_ERROR_INFO[TechErrorCount] = {
    {"DS", "Unmarked Doublestep",
     "A doublestep is present but there is no marking for it. You can mark a doublestep with a mine following it or having a hold on the other foot."},
    {"FS", "Mismarked Footswitch",
     "A mine that indicates a footswitch was placed for a jack. Either there is a doublestep or the mine is unnecessary."},
    {"AM", "Ambiguous Step",
     "The player does not know which foot to use for this step (usually after a jump)."},
};

inline std::optional<int> techErrorFromCode(std::string_view code) { return fromCode(TECH_ERROR_INFO, code); }

namespace Facing {
constexpr int Left = -1;
constexpr int Forward = 0;
constexpr int Right = 1;
}  // namespace Facing

// JS Set<Foot>: iterates in insertion order.
struct FootSet {
  int8_t items[5] = {};
  int8_t size = 0;

  bool has(int foot) const {
    for (int i = 0; i < size; i++)
      if (items[i] == foot) return true;
    return false;
  }
  void add(int foot) {
    if (!has(foot)) items[size++] = static_cast<int8_t>(foot);
  }
  void remove(int foot) {
    for (int i = 0; i < size; i++) {
      if (items[i] != foot) continue;
      for (int j = i + 1; j < size; j++) items[j - 1] = items[j];
      size--;
      return;
    }
  }
  const int8_t* begin() const { return items; }
  const int8_t* end() const { return items + size; }
};

// ParityState.toKey(), as a value. The row key prefix is left out: keys are
// only ever compared between states of the same row.
struct StateKey {
  uint64_t a = 0;
  uint64_t b = 0;
  double lastTurnEnd = 0;
  // ParityState.released, 0 where unset (b has the mask)
  std::array<double, MAX_COLUMNS> released{};
  bool operator==(const StateKey& o) const {
    return a == o.a && b == o.b && lastTurnEnd == o.lastTurnEnd && released == o.released;
  }
  bool operator!=(const StateKey& o) const { return !(*this == o); }
};

struct StateKeyHash {
  size_t operator()(const StateKey& k) const;
};

constexpr int FRONT_FOOT_NULL = -1;

class ParityState {
 public:
  // action and combinedColumns hold `length` entries (the column count, or 0
  // for the start node); reads past them are undefined
  int8_t length = 0;
  int8_t action[MAX_COLUMNS] = {};
  int8_t combinedColumns[MAX_COLUMNS] = {};
  FootSet movedFeet;
  FootSet holdFeet;
  int8_t frontFoot = FRONT_FOOT_NULL;
  int8_t facing = Facing::Forward;
  // the crossed facing was chosen while a foot was lifted (a sideswitch into
  // a cross): its direction is settled when that foot lands
  bool facingProvisional = false;
  // the last rotation (Left/Right) the body held and the second it ended
  int8_t lastTurn = Facing::Forward;
  double lastTurnEnd = -INFINITY;
  double second = 0;
  double beat = 0;

  int8_t footColumns[5] = {-1, -1, -1, -1, -1};

  // heels of feet that traveled this row (see the TS source)
  FootSet traveledFeet;

  int8_t hover[5] = {-1, -1, -1, -1, -1};
  bool hoverPivot[5] = {false, false, false, false, false};

  // per column: the second the hold or roll there was released (no foot on
  // it), while it stays released; NaN (undefined) otherwise
  double released[MAX_COLUMNS] = {NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN};
  bool isReleased(int col) const {
    return col >= 0 && col < MAX_COLUMNS && !std::isnan(released[col]);
  }

  // the side column of a roll head a crossed-over foot pressed on this row,
  // where the crossover began; -1 otherwise
  int8_t crossedOntoRoll = -1;

  ParityState() = default;
  ParityState(double second, double beat, const int8_t* action, int length,
              const int8_t* columns);

  ParityState cloneWithFacing(int facing) const;

  int actionAt(int col) const {
    return col >= 0 && col < length ? action[col] : UNDEF;
  }
  int combinedAt(int col) const {
    return col >= 0 && col < length ? combinedColumns[col] : UNDEF;
  }
  int footColumn(int foot) const {
    return foot >= 0 && foot < 5 ? footColumns[foot] : UNDEF;
  }

  int leftHeel() const { return footColumns[Foot::LEFT_HEEL]; }
  int leftToe() const { return footColumns[Foot::LEFT_TOE]; }
  int rightHeel() const { return footColumns[Foot::RIGHT_HEEL]; }
  int rightToe() const { return footColumns[Foot::RIGHT_TOE]; }

  StateKey toKey() const;
  // toKey() without the turn memory
  StateKey stanceKey() const;
};

// A total order on the states of one row, the same in every port (see the TS
// source); zero exactly when the two states have the same key.
int compareStates(const ParityState& a, const ParityState& b);

struct Pos {
  double x;
  double y;
};

struct PlacementData {
  Pos previousLeftPos;
  Pos previousRightPos;
  Pos leftPos;
  Pos rightPos;
  bool movedLeft;
  bool movedRight;
  bool previousMovedLeft;
  bool previousMovedRight;
  bool leftBracket;
  bool rightBracket;
  bool previousJumped;
  bool jumped;
  bool leftJack;
  bool rightJack;
  bool leftDoubleStep;
  bool rightDoubleStep;
  // roll columns taken as re-tapped between the rows, and by which foot
  struct RollTap {
    int col;
    int foot;
  };
  RollTap rollTaps[MAX_COLUMNS];
  int rollTapCount;
  bool leftAfterStepjump;
  bool rightAfterStepjump;

  const ParityState* initialState;
  const ParityState* resultState;
};

// the real (not fake) mines of one beat, in column order
struct MineRow {
  double beat;
  double second;
  std::vector<int> columns;
};

// Sparse JS arrays become fixed arrays with null / empty slots. The row id
// is not kept: in the batch path it only ever prefixes state keys.
struct Row {
  std::array<const NotedataEntry*, MAX_COLUMNS> notes{};
  std::array<const NotedataEntry*, MAX_COLUMNS> holds{};
  uint32_t holdTails = 0;
  // per column with an active roll: the stream step around its head (the
  // shortest gap from the head to the notes before and after it), seconds
  std::array<OptNum, MAX_COLUMNS> rollSteps{};
  std::array<OptNum, MAX_COLUMNS> mines{};
  std::array<OptNum, MAX_COLUMNS> fakeMines{};
  // real mines since the previous row, up to and including this row's beat, by beat
  std::vector<MineRow> mineRows;
  double second = 0;
  double beat = 0;
  std::array<FootOverride, MAX_COLUMNS> overrides;

  Row() { overrides.fill(FOOT_OVERRIDE_UNDEFINED); }

  bool hasHoldTail(int col) const {
    return col >= 0 && col < MAX_COLUMNS && (holdTails >> col & 1);
  }
  const NotedataEntry* noteAt(int col) const {
    return col >= 0 && col < MAX_COLUMNS ? notes[col] : nullptr;
  }
  const NotedataEntry* holdAt(int col) const {
    return col >= 0 && col < MAX_COLUMNS ? holds[col] : nullptr;
  }
  OptNum mineAt(int col) const {
    return col >= 0 && col < MAX_COLUMNS ? mines[col] : OptNum{};
  }
  OptNum fakeMineAt(int col) const {
    return col >= 0 && col < MAX_COLUMNS ? fakeMines[col] : OptNum{};
  }
};

// Rows by index. release(end) drops the rows before `end`; they must not be
// read again.
class Rows {
 public:
  const Row& operator[](int i) const { return rows[i - first]; }
  Row& operator[](int i) { return rows[i - first]; }
  int size() const { return first + static_cast<int>(rows.size()); }
  bool empty() const { return size() == 0; }
  std::deque<Row>::const_iterator begin() const { return rows.begin(); }
  std::deque<Row>::const_iterator end() const { return rows.end(); }
  void push_back(Row row) { rows.push_back(std::move(row)); }
  void clear() {
    rows.clear();
    first = 0;
  }
  void release(int end) {
    for (; first < end && !rows.empty(); first++) rows.pop_front();
  }
  // replaces rows [start, end), none released, with `with`
  void splice(int start, int end, const std::vector<Row>& with) {
    rows.erase(rows.begin() + (start - first), rows.begin() + (end - first));
    rows.insert(rows.begin() + (start - first), with.begin(), with.end());
  }

 private:
  std::deque<Row> rows;
  int first = 0;
};

}  // namespace parity
