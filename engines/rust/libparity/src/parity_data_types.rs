use crate::note_types::NotedataEntry;

pub type Foot = i8;
pub const NONE: Foot = 0;
pub const LEFT_HEEL: Foot = 1;
pub const LEFT_TOE: Foot = 2;
pub const RIGHT_HEEL: Foot = 3;
pub const RIGHT_TOE: Foot = 4;
/// JS `undefined` read past the end of a short Foot array (the initial
/// state's empty `action` / `combinedColumns`). Equal only to itself.
pub const UNDEFINED_FOOT: Foot = 7;

pub const FEET: [Foot; 4] = [LEFT_HEEL, LEFT_TOE, RIGHT_HEEL, RIGHT_TOE];

#[allow(non_snake_case)]
pub fn OTHER_PART_OF_FOOT(foot: Foot) -> Foot {
    match foot {
        NONE => NONE,
        LEFT_HEEL => LEFT_TOE,
        LEFT_TOE => LEFT_HEEL,
        RIGHT_HEEL => RIGHT_TOE,
        RIGHT_TOE => RIGHT_HEEL,
        _ => UNDEFINED_FOOT,
    }
}

/// English defaults for an enumeration value; `code` is the stable identifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CodeInfo {
    pub code: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

fn from_code(table: &[CodeInfo], code: &str) -> Option<usize> {
    table.iter().position(|info| info.code == code)
}

/// Indexed by `Foot`.
pub const FOOT_INFO: [CodeInfo; 5] = [
    CodeInfo {
        code: ".",
        name: "None",
        description: "No foot: mines, fakes and notes without an assigned foot.",
    },
    CodeInfo {
        code: "L",
        name: "Left Heel",
        description: "The heel of the left foot. A foot on a single panel is labeled by its heel.",
    },
    CodeInfo {
        code: "l",
        name: "Left Toe",
        description: "The toe of the left foot, on a second panel (brackets and bracket-taps).",
    },
    CodeInfo {
        code: "R",
        name: "Right Heel",
        description: "The heel of the right foot. A foot on a single panel is labeled by its heel.",
    },
    CodeInfo {
        code: "r",
        name: "Right Toe",
        description: "The toe of the right foot, on a second panel (brackets and bracket-taps).",
    },
];

pub fn foot_from_code(code: &str) -> Option<Foot> {
    from_code(&FOOT_INFO, code).map(|i| i as Foot)
}

/// Columns per stage are at most this (dance-double).
pub const MAX_COLUMNS: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FootOverride {
    Left,
    Right,
    Foot(Foot),
}

impl FootOverride {
    /// JS truthiness (`if (note.parity?.override)`): a numeric 0 is falsy.
    pub fn truthy(&self) -> bool {
        !matches!(self, FootOverride::Foot(0))
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RollTap {
    pub col: usize,
    pub foot: Foot,
}

pub struct PlacementData<'s> {
    pub previous_left_pos: Point,
    pub previous_right_pos: Point,
    pub left_pos: Point,
    pub right_pos: Point,
    pub moved_left: bool,
    pub moved_right: bool,
    pub previous_moved_left: bool,
    pub previous_moved_right: bool,
    pub left_bracket: bool,
    pub right_bracket: bool,
    pub previous_jumped: bool,
    pub jumped: bool,
    pub left_jack: bool,
    pub right_jack: bool,
    pub left_double_step: bool,
    pub right_double_step: bool,
    /// roll columns the engine takes as re-tapped between the rows, and by which foot
    pub roll_taps: Vec<RollTap>,
    pub left_after_stepjump: bool,
    pub right_after_stepjump: bool,

    pub initial_state: &'s ParityState,
    pub result_state: &'s ParityState,
}

#[derive(Clone, Copy, Debug)]
pub struct Weights {
    pub doublestep: f64,
    pub bracketjack: f64,
    pub jack: f64,
    pub jump: f64,
    pub slow_bracket: f64,
    pub twisted_foot: f64,
    pub brackettap: f64,
    pub xo_br: f64,
    pub holdswitch: f64,
    pub hold_release: f64,
    pub rollswitch: f64,
    pub mine: f64,
    pub mine_dodge: f64,
    pub footswitch: f64,
    pub missed_footswitch: f64,
    pub facing: f64,
    pub distance: f64,
    pub spin: f64,
    pub sideswitch: f64,
    pub crowded_bracket: f64,
    pub other: f64,
    pub start_xo: f64,
    pub xo_jump: f64,
    pub xo_entry: f64,
    pub xo_stay: f64,
    pub lifted_ds: f64,
    pub ds_jump: f64,
}

pub const DEFAULT_WEIGHTS: Weights = Weights {
    doublestep: 100.0,
    bracketjack: 60.0,
    jack: 80.0,
    jump: 100.0,
    slow_bracket: 300.0,
    twisted_foot: 100000.0,
    brackettap: 400.0,
    xo_br: 200.0,
    holdswitch: 500.0,
    hold_release: 500.0,
    rollswitch: 50.0,
    mine: 10000.0,
    mine_dodge: 200.0,
    footswitch: 325.0,
    missed_footswitch: 500.0,
    facing: 3.0,
    distance: 6.0,
    spin: 3000.0,
    sideswitch: 150.0,
    crowded_bracket: 100.0,
    other: 0.0,
    start_xo: 10000.0,
    xo_jump: 600.0,
    xo_entry: 150.0,
    xo_stay: 30.0,
    lifted_ds: 1500.0,
    ds_jump: 100.0,
};

pub type TechCategory = u8;
pub mod tech_category {
    use super::TechCategory;
    pub const CROSSOVERS: TechCategory = 0;
    pub const FOOTSWITCHES: TechCategory = 1;
    pub const SIDESWITCHES: TechCategory = 2;
    pub const JACKS: TechCategory = 3;
    pub const BRACKETS: TechCategory = 4;
    pub const DOUBLESTEPS: TechCategory = 5;
    pub const HOLDSWITCH: TechCategory = 6;
    pub const JUMPS: TechCategory = 7;
    pub const BRACKETTAPS: TechCategory = 8;
    pub const STEPJUMPS: TechCategory = 9;
    pub const KICKSWITCHES: TechCategory = 10;
    pub const LATERAL_CROSSOVERS: TechCategory = 11;
    pub const MINE_DODGES: TechCategory = 12;
}
pub const TECH_CATEGORY_COUNT: usize = 13;

/// Indexed by `TechCategory`.
pub const TECH_INFO: [CodeInfo; TECH_CATEGORY_COUNT] = [
    CodeInfo {
        code: "XO",
        name: "Crossover",
        description: "One of the player's feet crosses over the other foot.",
    },
    CodeInfo {
        code: "FS",
        name: "Footswitch",
        description: "The player uses alternating feet to hit the same arrow.",
    },
    CodeInfo {
        code: "SS",
        name: "Sideswitch",
        description: "The player uses alternating feet to hit the same arrow. The arrow appears on the left or right side of the stage.",
    },
    CodeInfo {
        code: "JA",
        name: "Jack",
        description: "The player uses the same foot to hit the same arrow.",
    },
    CodeInfo {
        code: "BR",
        name: "Bracket",
        description: "The player uses one foot to diagonally hit two arrows at once.",
    },
    CodeInfo {
        code: "DS",
        name: "Doublestep",
        description: "The player uses the same foot twice in a row to hit two different arrows.",
    },
    CodeInfo {
        code: "HS",
        name: "Holdswitch",
        description: "The player swaps which foot is holding a hold.",
    },
    CodeInfo {
        code: "JU",
        name: "Jump",
        description: "The player hits multiple arrows with both feet at the same time.",
    },
    CodeInfo {
        code: "BT",
        name: "Bracket-tap",
        description: "One part of a foot taps an adjacent arrow while the other part stays on a hold.",
    },
    CodeInfo {
        code: "SJ",
        name: "Stepjump",
        description: "A single sandwiched between jumps, or a jump sandwiched between singles (single-jump-single / jump-single-jump).",
    },
    CodeInfo {
        code: "KS",
        name: "Kickswitch",
        description: "Nickname for a combined FS DS",
    },
    CodeInfo {
        code: "LX",
        name: "Lateral crossover",
        description: "A foot crosses over onto the far side panel while the other foot is already on the opposite side panel, so both feet are crossed.",
    },
    CodeInfo {
        code: "MD",
        name: "Mine dodge",
        description: "A mine lands on a panel a foot is standing on, and the next step does not lift that foot anyway: the player lifts it just to avoid the mine.",
    },
];

pub fn tech_from_code(code: &str) -> Option<TechCategory> {
    from_code(&TECH_INFO, code).map(|i| i as TechCategory)
}

pub type TechErrors = u8;
pub mod tech_errors {
    use super::TechErrors;
    pub const UNMARKED_DOUBLESTEP: TechErrors = 0;
    pub const MISSED_FOOTSWITCH: TechErrors = 1;
    pub const AMBIGUOUS: TechErrors = 2;
}
pub const TECH_ERROR_COUNT: usize = 3;

/// Indexed by `TechErrors`.
pub const TECH_ERROR_INFO: [CodeInfo; TECH_ERROR_COUNT] = [
    CodeInfo {
        code: "DS",
        name: "Unmarked Doublestep",
        description: "A doublestep is present but there is no marking for it. You can mark a doublestep with a mine following it or having a hold on the other foot.",
    },
    CodeInfo {
        code: "FS",
        name: "Mismarked Footswitch",
        description: "A mine that indicates a footswitch was placed for a jack. Either there is a doublestep or the mine is unnecessary.",
    },
    CodeInfo {
        code: "AM",
        name: "Ambiguous Step",
        description: "The player does not know which foot to use for this step (usually after a jump).",
    },
];

pub fn tech_error_from_code(code: &str) -> Option<TechErrors> {
    from_code(&TECH_ERROR_INFO, code).map(|i| i as TechErrors)
}

/// A `Set` of small values (categories or errors) as a bitmask. Only used
/// where the reference never depends on the set's iteration order.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct BitSet(pub u16);

impl BitSet {
    pub fn has(&self, v: u8) -> bool {
        self.0 & (1 << v) != 0
    }
    pub fn add(&mut self, v: u8) {
        self.0 |= 1 << v
    }
    pub fn delete(&mut self, v: u8) {
        self.0 &= !(1 << v)
    }
    pub fn size(&self) -> u32 {
        self.0.count_ones()
    }
    /// ascending order
    pub fn values(&self) -> impl Iterator<Item = u8> + '_ {
        (0..16u8).filter(move |&v| self.has(v))
    }
}

pub type Facing = i8;
pub mod facing {
    use super::Facing;
    pub const LEFT: Facing = -1;
    pub const FORWARD: Facing = 0;
    pub const RIGHT: Facing = 1;
}

/// `Set<Foot>` with JS insertion order (delete then add moves a foot to the end).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct FootSet {
    items: [Foot; 4],
    len: u8,
}

impl FootSet {
    pub fn has(&self, foot: Foot) -> bool {
        self.items[..self.len as usize].contains(&foot)
    }
    pub fn add(&mut self, foot: Foot) {
        if !self.has(foot) {
            self.items[self.len as usize] = foot;
            self.len += 1;
        }
    }
    pub fn delete(&mut self, foot: Foot) {
        let n = self.len as usize;
        if let Some(i) = self.items[..n].iter().position(|&f| f == foot) {
            self.items.copy_within(i + 1..n, i);
            self.len -= 1;
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = Foot> + '_ {
        self.items[..self.len as usize].iter().copied()
    }
    pub fn mask(&self) -> u8 {
        self.iter().fold(0u8, |m, f| m | (1 << f))
    }
}

/// Equal exactly when the reference's `ParityState.toKey()` strings are equal
/// for two states of the same row (the row key is shared, so it is left out).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct StateKey(u128, u64, [u64; MAX_COLUMNS]);

#[derive(Clone, Debug)]
pub struct ParityState {
    pub action: [Foot; MAX_COLUMNS],
    pub combined_columns: [Foot; MAX_COLUMNS],
    pub moved_feet: FootSet,
    pub hold_feet: FootSet,
    pub front_foot: Option<Foot>,
    pub facing: Facing,
    // the crossed facing was chosen while a foot was lifted (a sideswitch into
    // a cross): its direction is settled when that foot lands
    pub facing_provisional: bool,
    // the last rotation (Left/Right) the body held and the second it ended:
    // a rotation the other way soon after is a reversal (calcXOTransitionCost)
    pub last_turn: Facing,
    pub last_turn_end: f64,
    pub second: f64,
    pub beat: f64,

    pub foot_columns: [i8; 5],

    // Heels of feet that TRAVELED this row: pressed at least one column they
    // were not already occupying.
    pub traveled_feet: FootSet,

    // Per foot, indexed by its heel: the panel its free part hovers over, or -1.
    pub hover: [i8; 5],
    pub hover_pivot: [bool; 5],

    // Per column: the second the hold or roll there was released (no foot on
    // it), while it stays released.
    pub released: [Option<f64>; MAX_COLUMNS],

    // The side column of a roll head a crossed-over foot pressed on this row,
    // where the crossover began; -1 otherwise.
    pub crossed_onto_roll: i8,
}

impl ParityState {
    /// `action` holds UNDEFINED_FOOT past the row's column count.
    pub fn new(second: f64, beat: f64, action: &[Foot; MAX_COLUMNS], columns: [i8; 5]) -> ParityState {
        ParityState {
            action: *action,
            combined_columns: [UNDEFINED_FOOT; MAX_COLUMNS],
            moved_feet: FootSet::default(),
            hold_feet: FootSet::default(),
            front_foot: None,
            facing: facing::FORWARD,
            facing_provisional: false,
            last_turn: facing::FORWARD,
            last_turn_end: f64::NEG_INFINITY,
            second,
            beat,
            foot_columns: columns,
            traveled_feet: FootSet::default(),
            hover: [-1; 5],
            hover_pivot: [false; 5],
            released: [None; MAX_COLUMNS],
            crossed_onto_roll: -1,
        }
    }

    /// to_key() without the turn memory
    pub fn stance_key(&self) -> StateKey {
        let mut s = self.clone();
        s.last_turn = facing::FORWARD;
        s.last_turn_end = f64::NEG_INFINITY;
        s.to_key()
    }

    pub fn clone_with_facing(&self, facing: Facing) -> ParityState {
        let mut clone = self.clone();
        clone.facing = facing;
        if self.facing != facing::FORWARD && facing == facing::FORWARD {
            clone.last_turn = self.facing;
            clone.last_turn_end = self.second;
        }
        clone
    }

    /// `combinedColumns[col]`, undefined outside the array
    pub fn combined_at(&self, col: i8) -> Foot {
        if col < 0 || col as usize >= MAX_COLUMNS {
            UNDEFINED_FOOT
        } else {
            self.combined_columns[col as usize]
        }
    }

    pub fn left_heel(&self) -> i8 {
        self.foot_columns[LEFT_HEEL as usize]
    }
    pub fn left_toe(&self) -> i8 {
        self.foot_columns[LEFT_TOE as usize]
    }
    pub fn right_heel(&self) -> i8 {
        self.foot_columns[RIGHT_HEEL as usize]
    }
    pub fn right_toe(&self) -> i8 {
        self.foot_columns[RIGHT_TOE as usize]
    }

    pub fn to_key(&self) -> StateKey {
        let mut k: u128 = 0;
        let mut push = |bits: u32, v: u128| {
            k = (k << bits) | v;
        };
        for &a in &self.action {
            push(3, a as u128);
        }
        for &c in &self.combined_columns {
            push(3, c as u128);
        }
        push(5, self.moved_feet.mask() as u128);
        push(5, self.hold_feet.mask() as u128);
        for i in 1..5 {
            push(4, (self.foot_columns[i] + 1) as u128);
        }
        push(3, self.front_foot.map_or(0, |f| f as u128 + 1));
        push(2, (self.facing + 1) as u128);
        push(1, self.facing_provisional as u128);
        push(2, (self.last_turn + 1) as u128);
        push(5, self.traveled_feet.mask() as u128);
        push(4, (self.hover[LEFT_HEEL as usize] + 1) as u128);
        push(1, self.hover_pivot[LEFT_HEEL as usize] as u128);
        push(4, (self.hover[RIGHT_HEEL as usize] + 1) as u128);
        push(1, self.hover_pivot[RIGHT_HEEL as usize] as u128);
        push(4, (self.crossed_onto_roll + 1) as u128);
        // `${second}` prints -0 as "0"
        let key_bits = |x: f64| if x == 0.0 { 0 } else { x.to_bits() };
        let mut released = [0u64; MAX_COLUMNS];
        for (i, r) in self.released.iter().enumerate() {
            push(1, r.is_some() as u128);
            if let Some(r) = r {
                released[i] = key_bits(*r);
            }
        }
        let end = if self.last_turn != facing::FORWARD { key_bits(self.last_turn_end) } else { 0 };
        StateKey(k, end, released)
    }
}

/// the real (not fake) mines of one beat, in column order
#[derive(Clone, Debug)]
pub struct MineRow {
    pub beat: f64,
    pub second: f64,
    pub columns: Vec<usize>,
}

/// Sparse JS arrays indexed by column become fixed arrays of Option.
#[derive(Clone, Debug)]
pub struct Row<'a> {
    pub notes: [Option<&'a NotedataEntry>; MAX_COLUMNS],
    pub holds: [Option<&'a NotedataEntry>; MAX_COLUMNS],
    pub hold_tails: u8,
    /// per column with an active roll: the stream step around its head (the
    /// shortest gap from the head to the notes before and after it), seconds
    pub roll_steps: [Option<f64>; MAX_COLUMNS],
    pub mines: [Option<f64>; MAX_COLUMNS],
    pub fake_mines: [Option<f64>; MAX_COLUMNS],
    /// real mines since the previous row, up to and including this row's beat, by beat
    pub mine_rows: Vec<MineRow>,
    pub second: f64,
    pub beat: f64,
    pub overrides: [Option<FootOverride>; MAX_COLUMNS],
}

impl<'a> Row<'a> {
    pub fn has_hold_tail(&self, col: usize) -> bool {
        col < MAX_COLUMNS && self.hold_tails & (1 << col) != 0
    }
    pub fn note_at(&self, col: i8) -> Option<&'a NotedataEntry> {
        if col < 0 { None } else { self.notes[col as usize] }
    }
    pub fn hold_at(&self, col: i8) -> Option<&'a NotedataEntry> {
        if col < 0 { None } else { self.holds[col as usize] }
    }
    pub fn mine_at(&self, col: i8) -> Option<f64> {
        if col < 0 { None } else { self.mines[col as usize] }
    }
    pub fn fake_mine_at(&self, col: i8) -> Option<f64> {
        if col < 0 { None } else { self.fake_mines[col as usize] }
    }
}

/// The rows of a chart, indexed from 0; rows before `release_before`'s bound
/// are dropped and must not be read again.
#[derive(Default)]
pub struct Rows<'a> {
    rows: std::collections::VecDeque<Row<'a>>,
    offset: usize,
}

impl<'a> Rows<'a> {
    pub fn len(&self) -> usize {
        self.offset + self.rows.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn get(&self, i: usize) -> Option<&Row<'a>> {
        assert!(i >= self.offset, "row {i} was released");
        self.rows.get(i - self.offset)
    }
    pub fn push(&mut self, row: Row<'a>) {
        self.rows.push_back(row);
    }
    pub fn release_before(&mut self, end: usize) {
        while self.offset < end && self.rows.pop_front().is_some() {
            self.offset += 1;
        }
    }
    /// all rows; none may have been released
    pub fn iter(&self) -> impl Iterator<Item = &Row<'a>> {
        assert_eq!(self.offset, 0, "rows were released");
        self.rows.iter()
    }
}

impl<'a> std::ops::Index<usize> for Rows<'a> {
    type Output = Row<'a>;
    fn index(&self, i: usize) -> &Row<'a> {
        self.get(i).expect("row index out of bounds")
    }
}

/// A total order on the states of one row, the same in every port (see the TS
/// source); Equal exactly when the two states have the same key.
pub fn compare_states(a: &ParityState, b: &ParityState) -> std::cmp::Ordering {
    let fields = |s: &ParityState| -> Vec<f64> {
        let foot = |f: Foot| if f == UNDEFINED_FOOT { NONE as f64 } else { f as f64 };
        let mut out: Vec<f64> = Vec::with_capacity(2 * MAX_COLUMNS + 16);
        out.extend(s.action.iter().map(|&f| foot(f)));
        out.extend(s.combined_columns.iter().map(|&f| foot(f)));
        out.extend(s.foot_columns[1..5].iter().map(|&c| c as f64));
        out.push(s.moved_feet.mask() as f64);
        out.push(s.hold_feet.mask() as f64);
        out.push(s.front_foot.map_or(-1.0, |f| f as f64));
        out.push(s.facing as f64);
        out.push(s.facing_provisional as u8 as f64);
        out.push(s.last_turn as f64);
        out.push(if s.last_turn != facing::FORWARD { s.last_turn_end } else { 0.0 });
        out.push(s.traveled_feet.mask() as f64);
        out.push(s.hover[LEFT_HEEL as usize] as f64);
        out.push(s.hover_pivot[LEFT_HEEL as usize] as u8 as f64);
        out.push(s.hover[RIGHT_HEEL as usize] as f64);
        out.push(s.hover_pivot[RIGHT_HEEL as usize] as u8 as f64);
        for (i, r) in s.released.iter().enumerate() {
            if let Some(r) = r {
                out.push(i as f64);
                out.push(*r);
            }
        }
        out.push(s.crossed_onto_roll as f64);
        out
    };
    let (x, y) = (fields(a), fields(b));
    for (p, q) in x.iter().zip(y.iter()) {
        if p != q {
            return if p < q { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
    }
    x.len().cmp(&y.len())
}
