use crate::parity_cost::cost;
use crate::note_types::{NoteType, NotedataEntry};
use crate::parity_data_types::{
    tech_category as tc, tech_errors as te, BitSet, Foot, ParityState, PlacementData, Row, Rows, LEFT_HEEL, LEFT_TOE, MAX_COLUMNS,
    NONE, OTHER_PART_OF_FOOT, RIGHT_HEEL, RIGHT_TOE, TECH_CATEGORY_COUNT, TECH_ERROR_COUNT, TechCategory,
};
use crate::parity_internals::ParityGraphNode;
use crate::parity_result_types::{MineRowStats, RollTapEvent};
use crate::parity_utils::{SECOND_EPSILON, get_player_angle, is_planted_jump, is_stepjump, mine_forces_footswitch};
use crate::stage_layouts::StageLayout;
use crate::js::truthy;
use std::borrow::Borrow;
use std::collections::BTreeMap;

pub struct RowStats {
    pub tech_rows: Vec<Option<BitSet>>,
    pub mine_rows: Vec<MineRowStats>,
    pub roll_taps: Vec<RollTapEvent>,
    pub tech_errors: BTreeMap<usize, BitSet>,
    pub facing_rows: Vec<f64>,
    pub candles: BTreeMap<usize, Foot>,
    pub tech_counts: [u32; TECH_CATEGORY_COUNT],
    pub tech_error_counts: [u32; TECH_ERROR_COUNT],
}

// a hold or roll no foot is on: its note, the row it was released on and the foot that left it
#[derive(Clone, Copy)]
struct Release {
    hold: *const NotedataEntry,
    row: usize,
    foot: Foot,
}

fn is_left(foot: Foot) -> bool {
    foot == LEFT_HEEL || foot == LEFT_TOE
}

fn note_count(row: &Row) -> usize {
    row.notes.iter().filter(|n| n.is_some()).count()
}

/// `children.get(key)!["TOTAL"] - [...]["DISTANCE"]` against every other child.
fn cheaper_sibling(parent: &ParityGraphNode, chosen: &ParityGraphNode) -> bool {
    let costs = &parent
        .children
        .iter()
        .find(|(k, _)| *k == chosen.key)
        .expect("best child missing from its parent's children")
        .1;
    let cost = costs.get(cost::TOTAL) - costs.get(cost::DISTANCE);
    parent.children.iter().any(|(child, costs)| {
        if *child == chosen.key {
            return false;
        }
        costs.get(cost::TOTAL) - costs.get(cost::DISTANCE) <= cost
    })
}

pub fn calculate_row_stats(nodes: &[&ParityGraphNode], rows: &Rows, layout: &StageLayout) -> RowStats {
    let mut stats = RowStatAccumulator::new(layout.clone(), true);
    for &node in &nodes[..nodes.len() - 1] {
        stats.push(rows, node);
    }
    stats.result()
}

/// Row stats of a best path fed one node at a time: the start node, then one
/// node per row. When a node is pushed, the previous node's children must be
/// set (the ambiguity checks read them) and the rows from the previous node's
/// row through the row after the pushed one must be present.
pub struct RowStatAccumulator<N> {
    layout: StageLayout,
    keep_rows: bool,
    tech_rows: Vec<Option<BitSet>>,
    mine_rows: Vec<MineRowStats>,
    roll_taps: Vec<RollTapEvent>,
    tech_errors: BTreeMap<usize, BitSet>,
    facing_rows: Vec<f64>,
    candles: BTreeMap<usize, Foot>,
    tech_counts: [u32; TECH_CATEGORY_COUNT],
    tech_error_counts: [u32; TECH_ERROR_COUNT],
    previous: Option<N>,
    pushed: usize,
    releases: [Option<Release>; MAX_COLUMNS],
}

impl<N: Borrow<ParityGraphNode>> RowStatAccumulator<N> {
    pub fn new(layout: StageLayout, keep_rows: bool) -> Self {
        RowStatAccumulator {
            layout,
            keep_rows,
            tech_rows: vec![None],
            mine_rows: Vec::new(),
            roll_taps: Vec::new(),
            tech_errors: BTreeMap::new(),
            facing_rows: vec![0.0],
            candles: BTreeMap::new(),
            tech_counts: [0; TECH_CATEGORY_COUNT],
            tech_error_counts: [0; TECH_ERROR_COUNT],
            previous: None,
            pushed: 0,
            releases: [None; MAX_COLUMNS],
        }
    }

    pub fn push(&mut self, rows: &Rows, node: N) {
        let previous = self.previous.take();
        if self.pushed == 1 {
            self.first_row(rows, previous.as_ref().unwrap().borrow(), node.borrow());
        } else if self.pushed > 1 {
            self.pair(rows, previous.as_ref().unwrap().borrow(), node.borrow(), self.pushed - 2);
        }
        self.previous = Some(node);
        self.pushed += 1;
    }

    pub fn counts(&self) -> ([u32; TECH_CATEGORY_COUNT], [u32; TECH_ERROR_COUNT]) {
        (self.tech_counts, self.tech_error_counts)
    }

    pub fn result(self) -> RowStats {
        RowStats {
            tech_rows: self.tech_rows,
            mine_rows: self.mine_rows,
            roll_taps: self.roll_taps,
            tech_errors: self.tech_errors,
            facing_rows: self.facing_rows,
            candles: self.candles,
            tech_counts: self.tech_counts,
            tech_error_counts: self.tech_error_counts,
        }
    }

    // XO on every row a crossed-over foot presses: a part of that foot presses
    // a panel on the far side. LX instead when the foot travelled there while
    // the other foot is already on its own far side (both feet crossed).
    fn crossed_press(&self, state: &ParityState) -> Option<TechCategory> {
        let crosses = self.layout.crossed_feet(state);
        let sides = [
            (LEFT_HEEL, &self.layout.right_arrows, crosses.right_on_left),
            (RIGHT_HEEL, &self.layout.left_arrows, crosses.left_on_right),
        ];
        let mut result = None;
        for (heel, far, other_crossed) in sides {
            let pressed_far = [heel, OTHER_PART_OF_FOOT(heel)]
                .iter()
                .any(|&part| state.moved_feet.has(part) && far.contains(&state.foot_columns[part as usize]));
            if !pressed_far {
                continue;
            }
            if other_crossed && state.traveled_feet.has(heel) {
                return Some(tc::LATERAL_CROSSOVERS);
            }
            result = Some(tc::CROSSOVERS);
        }
        result
    }

    // MD: a mine on a panel a foot stands on before the row, and the row does
    // not lift and press that foot anyway
    fn is_mine_dodge(columns: &[usize], before: &ParityState, after: &ParityState) -> bool {
        [LEFT_HEEL, RIGHT_HEEL].iter().any(|&heel| {
            let parts = [heel, OTHER_PART_OF_FOOT(heel)];
            parts.iter().any(|&part| {
                let col = before.foot_columns[part as usize];
                col != -1 && columns.contains(&(col as usize))
            }) && !parts.iter().any(|&part| after.moved_feet.has(part))
        })
    }

    // HS on an earlier row: the holding foot left there, and the other foot took the hold back now
    fn add_tech(&mut self, row: usize, tech: TechCategory) {
        self.tech_counts[tech as usize] += 1;
        if !self.keep_rows {
            return;
        }
        self.tech_rows[row].get_or_insert_with(BitSet::default).add(tech);
    }

    // a tech between two rows (a mine dodge, a roll re-tap), kept with the mine rows
    fn add_off_row_tech(&mut self, beat: f64, second: f64, tech: TechCategory) {
        self.tech_counts[tech as usize] += 1;
        if !self.keep_rows {
            return;
        }
        if let Some(existing) = self.mine_rows.iter_mut().find(|m| (m.second - second).abs() < SECOND_EPSILON) {
            existing.techs.add(tech);
            return;
        }
        let mut at = self.mine_rows.len();
        while at > 0 && self.mine_rows[at - 1].second > second {
            at -= 1;
        }
        let mut techs = BitSet::default();
        techs.add(tech);
        self.mine_rows.insert(at, MineRowStats { beat, second, techs });
    }

    fn record(&mut self, row: usize, techs: BitSet, errors: BitSet) {
        for tech in techs.values() {
            self.tech_counts[tech as usize] += 1;
        }
        for error in errors.values() {
            self.tech_error_counts[error as usize] += 1;
        }
        if !self.keep_rows {
            return;
        }
        if row == 0 {
            if techs.size() > 0 {
                self.tech_rows[0] = Some(techs);
            }
        } else {
            self.tech_rows.push(if techs.size() == 0 { None } else { Some(techs) });
        }
        if errors.size() > 0 {
            self.tech_errors.insert(row, errors);
        }
    }

    fn first_row(&mut self, rows: &Rows, start: &ParityGraphNode, node: &ParityGraphNode) {
        let mut errors = BitSet::default();
        // Check first row for ambiguous
        if note_count(&rows[0]) == 1 && cheaper_sibling(start, node) {
            errors.add(te::AMBIGUOUS);
        }
        // The first row has no previous row, so only its row-local labels apply:
        // a bracket, a jump or a stepjump.
        let data = self.layout.get_placement_data(&start.state, &node.state, None, &rows[0]);
        let mut first = BitSet::default();
        if data.left_bracket || data.right_bracket {
            first.add(tc::BRACKETS);
        }
        if data.jumped {
            first.add(if is_stepjump(rows, 0) { tc::STEPJUMPS } else { tc::JUMPS });
        }
        self.record(0, first, errors);
    }

    // the stats of row i + 1, from the path nodes of rows i and i + 1
    fn pair(&mut self, rows: &Rows, initial: &ParityGraphNode, current: &ParityGraphNode, i: usize) {
        let layout = &self.layout;
        let initial_state = &initial.state;
        let initial_row = &rows[i];
        let current_state = &current.state;
        let current_row = &rows[i + 1];
        let data = layout.get_placement_data(initial_state, current_state, Some(initial_row), current_row);

        if self.keep_rows {
            self.facing_rows.push(get_player_angle(data.left_pos, data.right_pos));
            for tap in &data.roll_taps {
                self.roll_taps.push(RollTapEvent {
                    beat: (initial_row.beat + current_row.beat) / 2.0,
                    second: (initial_row.second + current_row.second) / 2.0,
                    col: tap.col,
                    foot: tap.foot,
                });
            }
        }

        let mut techs = BitSet::default();
        let mut errors = BitSet::default();

        for c in 0..current_row.holds.len() {
            let Some(hold) = current_row.holds[c] else { continue };
            // Skip holds that weren't yet held at the previous row.
            if hold.beat > data.initial_state.beat {
                continue;
            }
            let initial_foot = data.initial_state.combined_columns[c];
            let result_foot = data.result_state.combined_columns[c];
            if result_foot == NONE {
                if initial_foot != NONE && !current_row.has_hold_tail(c) {
                    self.releases[c] = Some(Release { hold, row: i + 1, foot: initial_foot });
                }
                continue;
            }
            if initial_foot == NONE {
                if let Some(release) = self.releases[c] {
                    if std::ptr::eq(release.hold, hold) && is_left(release.foot) != is_left(result_foot) {
                        self.add_tech(release.row, tc::HOLDSWITCH);
                    }
                }
                self.releases[c] = None;
                continue;
            }
            if initial_foot != result_foot && initial_foot != OTHER_PART_OF_FOOT(result_foot) {
                if hold.note_type == NoteType::Roll {
                    // labelled like the re-tap were an arrow (minus the jack)
                    let beat = (initial_row.beat + current_row.beat) / 2.0;
                    let second = (initial_row.second + current_row.second) / 2.0;
                    let ci = c as i8;
                    let sideswitch = self.layout.side_arrows.contains(&ci);
                    let far = if is_left(result_foot) { &self.layout.right_arrows } else { &self.layout.left_arrows };
                    let crossover = far.contains(&ci);
                    self.add_off_row_tech(beat, second, if sideswitch { tc::SIDESWITCHES } else { tc::FOOTSWITCHES });
                    if crossover {
                        self.add_off_row_tech(beat, second, tc::CROSSOVERS);
                    }
                } else {
                    techs.add(tc::HOLDSWITCH);
                }
            }
        }
        for c in 0..MAX_COLUMNS {
            if let Some(release) = self.releases[c] {
                if !current_row.holds[c].is_some_and(|h| std::ptr::eq(h, release.hold)) {
                    self.releases[c] = None;
                }
            }
        }
        let layout = &self.layout;

        if !techs.has(tc::HOLDSWITCH) && !data.jumped {
            if ((data.left_double_step && !data.left_after_stepjump)
                || (data.right_double_step && !data.right_after_stepjump))
                && !techs.has(tc::HOLDSWITCH)
            {
                techs.add(tc::DOUBLESTEPS);
                if !is_doublestep_marked(&data, initial_row, current_row, layout) {
                    errors.add(te::UNMARKED_DOUBLESTEP);
                }
            }

            // Footswitch (first moved foot in Set insertion order decides FS vs SS)
            for foot in current_state.moved_feet.iter() {
                let col = current_state.foot_columns[foot as usize];
                let was = initial_state.combined_at(col);
                if was == NONE {
                    continue;
                }
                // taking over a roll's re-tap is labelled between the rows
                if current_row.hold_at(col).is_some() {
                    continue;
                }
                if was == foot || was == OTHER_PART_OF_FOOT(foot) {
                    continue;
                }
                if layout.side_arrows.contains(&col) {
                    techs.add(tc::SIDESWITCHES);
                } else {
                    techs.add(tc::FOOTSWITCHES);
                }
                break;
            }
        }

        if techs.has(tc::FOOTSWITCHES) && techs.has(tc::DOUBLESTEPS) {
            techs.delete(tc::FOOTSWITCHES);
            techs.delete(tc::DOUBLESTEPS);
            techs.add(tc::KICKSWITCHES);
        }

        if data.left_bracket || data.right_bracket {
            techs.add(tc::BRACKETS);
        }

        if data.jumped {
            techs.add(tc::JUMPS);
        }

        // Bracket-tap
        for c in 0..current_row.holds.len() {
            if current_row.holds[c].is_none() {
                continue;
            }
            // a hold ending on this row is not tapped against
            if current_row.has_hold_tail(c) {
                continue;
            }
            let holder = current_state.combined_columns[c];
            if holder == NONE {
                continue;
            }
            let other = OTHER_PART_OF_FOOT(holder);
            let other_col = current_state.foot_columns[other as usize];
            if other_col != -1
                && other_col as usize != c
                && current_row.note_at(other_col).is_some()
                && current_state.action[other_col as usize] == other
            {
                techs.add(tc::BRACKETTAPS);
                break;
            }
        }

        // Stepjump
        if data.jumped
            && (is_stepjump(rows, i + 1)
                || is_planted_jump(current_row, initial_state, current_state, current_row.second - initial_row.second))
        {
            techs.delete(tc::JUMPS);
            techs.add(tc::STEPJUMPS);
        }

        let repeat_after_jump = |heel: Foot| {
            if initial_state.traveled_feet.has(heel) {
                return false;
            }
            current_state
                .moved_feet
                .iter()
                .filter(|&f| f == heel || f == OTHER_PART_OF_FOOT(heel))
                .any(|f| {
                    !initial_state
                        .hold_feet
                        .has(initial_state.combined_at(current_state.foot_columns[f as usize]))
                })
        };
        let jack_after_jump =
            (data.left_jack && repeat_after_jump(LEFT_HEEL)) || (data.right_jack && repeat_after_jump(RIGHT_HEEL));
        // A repeated jump is JU only; the jump-jack is priced, not labelled.
        if !techs.has(tc::BRACKETS) && (data.left_jack || data.right_jack) && (!data.previous_jumped || jack_after_jump)
        {
            techs.add(tc::JACKS);
            if mine_forces_footswitch(&data, current_row, current_row.second - initial_row.second) {
                errors.add(te::MISSED_FOOTSWITCH);
            }
        }

        if let Some(crossed) = self.crossed_press(current_state) {
            techs.add(crossed);
        }

        for mines in &current_row.mine_rows {
            if !Self::is_mine_dodge(&mines.columns, initial_state, current_state) {
                continue;
            }
            if (mines.second - current_row.second).abs() < SECOND_EPSILON {
                techs.add(tc::MINE_DODGES);
                continue;
            }
            self.add_off_row_tech(mines.beat, mines.second, tc::MINE_DODGES);
        }

        if is_ambiguous(&data, current_row, initial, current, i) {
            errors.add(te::AMBIGUOUS);
        }

        if self.keep_rows && data.moved_left && (data.previous_left_pos.y - data.left_pos.y).abs() > 1.3 {
            self.candles.insert(i + 1, LEFT_HEEL);
        }

        if self.keep_rows && data.moved_right && (data.previous_right_pos.y - data.right_pos.y).abs() > 1.3 {
            self.candles.insert(i + 1, RIGHT_HEEL);
        }

        self.record(i + 1, techs, errors);
    }
}

fn is_doublestep_marked(data: &PlacementData, initial_row: &Row, current_row: &Row, layout: &StageLayout) -> bool {
    for i in 0..layout.layout.len() {
        let hold = initial_row.holds[i];
        // If there is a hold that extends past the last row, we can DS
        if (hold.is_some() && !initial_row.has_hold_tail(i)) || current_row.holds[i].is_some() {
            return true;
        }
    }

    let init = data.initial_state;
    if data.left_double_step {
        let will_hit_mine = truthy(current_row.mine_at(init.foot_columns[LEFT_HEEL as usize]))
            || truthy(current_row.fake_mine_at(init.foot_columns[LEFT_HEEL as usize]))
            || truthy(current_row.mine_at(init.foot_columns[LEFT_TOE as usize]))
            || truthy(current_row.fake_mine_at(init.foot_columns[LEFT_TOE as usize]));
        if will_hit_mine {
            return true;
        }
    }
    if data.right_double_step {
        let will_hit_mine = truthy(current_row.mine_at(init.foot_columns[RIGHT_HEEL as usize]))
            || truthy(current_row.fake_mine_at(init.foot_columns[RIGHT_HEEL as usize]))
            || truthy(current_row.mine_at(init.foot_columns[RIGHT_TOE as usize]))
            || truthy(current_row.fake_mine_at(init.foot_columns[RIGHT_TOE as usize]));
        if will_hit_mine {
            return true;
        }
    }
    false
}

fn is_ambiguous(
    data: &PlacementData,
    current_row: &Row,
    initial: &ParityGraphNode,
    current: &ParityGraphNode,
    i: usize,
) -> bool {
    if (!data.previous_jumped && i != 0) || note_count(current_row) != 1 {
        return false;
    }
    let note_index = (0..current_row.notes.len()).find(|&c| current_row.notes[c].is_some()).unwrap();
    let init = data.initial_state.combined_columns[note_index];
    let res = data.result_state.combined_columns[note_index];
    if init == res || init == OTHER_PART_OF_FOOT(res) {
        return false;
    }
    cheaper_sibling(initial, current)
}
