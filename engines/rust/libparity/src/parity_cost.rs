use crate::js::{math_max, math_min, truthy};
use crate::note_types::{is_hold_note, NoteType};
use crate::parity_data_types::{
    facing, Foot, ParityState, PlacementData, Point, Row, Rows, Weights, DEFAULT_WEIGHTS, LEFT_HEEL,
    LEFT_TOE, NONE, OTHER_PART_OF_FOOT, RIGHT_HEEL, RIGHT_TOE,
};
use crate::parity_utils::{
    get_player_angle, is_planted_jump, is_stepjump, jump_repress, mine_forces_footswitch, Repress,
    REVERSAL_WINDOW,
};
use crate::stage_layouts::StageLayout;
use std::f64::consts::PI;

/// Cost names in the order getActionCost inserts them; TOTAL sums them in this order.
pub mod cost {
    pub const MINE: usize = 0;
    pub const HOLDSWITCH: usize = 1;
    pub const HOLD_RELEASE: usize = 2;
    pub const BRACKETTAP: usize = 3;
    pub const OTHER: usize = 4;
    pub const BRACKETJACK: usize = 5;
    pub const XO_BR: usize = 6;
    pub const XO_ENTRY: usize = 7;
    pub const ROTATION_TWIST: usize = 8;
    pub const XO_REVERSAL: usize = 9;
    pub const XO_STAY: usize = 10;
    pub const DOUBLESTEP: usize = 11;
    pub const JUMP: usize = 12;
    pub const TWISTED_FOOT: usize = 13;
    pub const SPIN: usize = 14;
    pub const HOLDPART_FOOTSWITCH: usize = 15;
    pub const FOOTSWITCH: usize = 16;
    pub const SIDESWITCH: usize = 17;
    pub const XO_ROLL_RESOLVED: usize = 18;
    pub const MISSED_FOOTSWITCH: usize = 19;
    pub const JACK: usize = 20;
    pub const DISTANCE: usize = 21;
    pub const CROWDED_BRACKET: usize = 22;
    pub const TOTAL: usize = 23;
    pub const COUNT: usize = 24;
}

/// `{ [id: string]: number }`; a name the reference never set reads as 0
/// (`costs["DOUBLESTEP"] ?? 0`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Costs(pub [f64; cost::COUNT]);

impl Costs {
    pub fn total_only(total: f64) -> Costs {
        let mut c = Costs([0.0; cost::COUNT]);
        c.0[cost::TOTAL] = total;
        c
    }
    pub fn get(&self, id: usize) -> f64 {
        self.0[id]
    }
}

pub struct ParityCostCalculator {
    layout: StageLayout,
    weights: Weights,
}

// Bracket-tap price factors by how the foot was oriented before the tap.
const PRIMED_BRACKET_TAP_FACTOR: f64 = 0.2;
const TRAIL_PRIMED_BRACKET_TAP_FACTOR: f64 = 0.28;
const PIVOT_BRACKET_TAP_FACTOR: f64 = 0.35;
const SWITCH_BRACKET_TAP_FACTOR: f64 = 1.0;
const PIVOT_FROM_HOVER: bool = true;
const BRACKET_TAP_JACK_WINDOW: f64 = 0.0;

const DOUBLESTEP_BASE_TIME: f64 = 0.25;
const CROSSED_DOUBLESTEP_FACTOR: f64 = 2.0;
const JACK_DOUBLESTEP_FACTOR: f64 = 2.0;
const HOLD_DOUBLESTEP_FREE_TIME: f64 = 0.15;

const SLOW_BRACKET_THRESHOLD: f64 = 0.15;
const SLOW_BRACKET_CAP: f64 = 0.5;

const SLOW_FOOTSWITCH_THRESHOLD: f64 = 0.18;
const SLOW_FOOTSWITCH_CAP: f64 = 162.5;

const HOLD_PART_FOOTSWITCH_FACTOR: f64 = 0.4;
const HOLD_PART_FOOTSWITCH_MAX_TIME: f64 = 0.3;

const JACK_MAX_ELAPSED_TIME: f64 = 0.4;
const STEPJUMP_JACK_FACTOR: f64 = 0.75;

const CANDLE_FACTOR: f64 = 1.0;

const CROWDED_BRACKET_MIN_TIME: f64 = 0.3;

impl ParityCostCalculator {
    pub fn new(layout: StageLayout) -> ParityCostCalculator {
        ParityCostCalculator { layout, weights: DEFAULT_WEIGHTS }
    }

    pub fn get_action_cost(
        &self,
        initial_state: &ParityState,
        result_state: &ParityState,
        rows: &Rows,
        row_index: usize,
    ) -> Costs {
        let last_row = if row_index > 0 { rows.get(row_index - 1) } else { None };
        let row = &rows[row_index];
        let mut elapsed_time = result_state.second - initial_state.second;
        if row_index == 0 {
            elapsed_time = 1.0;
        }

        let mut costs = Costs([0.0; cost::COUNT]);

        let placement_data = self.layout.get_placement_data(initial_state, result_state, last_row, row);
        let d = &placement_data;

        costs.0[cost::MINE] = self.calc_mine_costs(d, row);
        costs.0[cost::HOLDSWITCH] = self.calc_hold_switch_costs(d, row);
        costs.0[cost::HOLD_RELEASE] = self.calc_hold_release_cost(d, row);
        costs.0[cost::BRACKETTAP] = self.calc_bracket_tap_cost(d, elapsed_time);
        costs.0[cost::OTHER] = self.calc_start_crossover(d, row_index);
        costs.0[cost::BRACKETJACK] = self.calc_bracket_jack_cost(d);
        costs.0[cost::XO_BR] = self.calc_xobr_cost(d);
        costs.0[cost::XO_ENTRY] = self.calc_xo_transition_cost(d);
        costs.0[cost::ROTATION_TWIST] = self.calc_rotation_twist_cost(d);
        costs.0[cost::XO_REVERSAL] = self.calc_reversal_cost(d);
        costs.0[cost::XO_STAY] = self.calc_xo_stay_cost(d);
        costs.0[cost::DOUBLESTEP] = self.calc_doublestep_cost(d, last_row, row, elapsed_time);
        costs.0[cost::JUMP] = self.calc_jump_cost(d, elapsed_time);
        costs.0[cost::TWISTED_FOOT] = self.calc_twisted_foot(d);
        costs.0[cost::SPIN] = self.calc_spin_cost(d);
        costs.0[cost::HOLDPART_FOOTSWITCH] = self.calc_hold_part_footswitch_cost(d, row, elapsed_time);
        costs.0[cost::FOOTSWITCH] = self.calc_slow_footswitch_cost(d, row, elapsed_time);
        costs.0[cost::SIDESWITCH] = self.calc_sideswitch_cost(d, row);
        if costs.0[cost::SIDESWITCH] > 0.0 {
            costs.0[cost::XO_STAY] = 0.0;
            costs.0[cost::XO_ENTRY] = 0.0;
        }
        costs.0[cost::XO_ROLL_RESOLVED] = self.calc_xo_roll_resolved_cost(d, row);
        costs.0[cost::MISSED_FOOTSWITCH] = self.calc_missed_footswitch_cost(d, row, elapsed_time);
        costs.0[cost::JACK] = self.calc_jack_cost(d, row, elapsed_time, is_stepjump(rows, row_index));
        costs.0[cost::DISTANCE] = self.calc_distance_cost(d, elapsed_time, rows, row_index);
        costs.0[cost::CROWDED_BRACKET] = self.calc_crowded_bracket_cost(d, elapsed_time);

        let mut total_cost = 0.0;
        for c in 0..cost::TOTAL {
            total_cost += costs.0[c];
        }
        costs.0[cost::TOTAL] = total_cost;
        costs
    }

    // A foot pressing a panel whose mine passed since the last row is MINE; a
    // foot that stood on it and does not act lifts off to the center (MD, a
    // ghost step) and pays MINE_DODGE.
    pub fn calc_mine_costs(&self, data: &PlacementData, row: &Row) -> f64 {
        let mut cost = 0.0;
        for i in 0..self.layout.layout.len() {
            if row.mines[i].is_none() {
                continue;
            }
            if data.result_state.combined_columns[i] != NONE {
                return self.weights.mine;
            }
            let stood = data.initial_state.combined_columns[i];
            if stood == NONE || row.holds[i].is_some() {
                continue;
            }
            let parts = [stood, OTHER_PART_OF_FOOT(stood)];
            if !parts.iter().any(|&p| data.result_state.moved_feet.has(p)) {
                cost = self.weights.mine_dodge;
            }
        }
        cost
    }

    // A foot leaving a hold or roll it covered, so no foot is on it for a while.
    pub fn calc_hold_release_cost(&self, data: &PlacementData, row: &Row) -> f64 {
        let mut cost = 0.0;
        for c in 0..row.holds.len() {
            if row.holds[c].is_none() {
                continue;
            }
            if data.result_state.combined_columns[c] != NONE || row.has_hold_tail(c) {
                continue;
            }
            if data.initial_state.released[c].is_none() {
                cost += self.weights.hold_release;
            }
        }
        cost
    }

    pub fn calc_hold_switch_costs(&self, data: &PlacementData, row: &Row) -> f64 {
        let mut cost = 0.0;
        for c in 0..row.holds.len() {
            let Some(hold) = row.holds[c] else { continue };
            // Skip holds not yet held at the previous row.
            if hold.beat > data.initial_state.beat {
                continue;
            }
            let initial_foot = data.initial_state.combined_columns[c];
            let result_foot = data.result_state.combined_columns[c];
            // a release and the step back on are priced by calc_hold_release_cost
            if initial_foot == NONE || result_foot == NONE {
                continue;
            }
            if initial_foot != result_foot && initial_foot != OTHER_PART_OF_FOOT(result_foot) {
                if hold.note_type == NoteType::Roll {
                    cost += self.weights.rollswitch;
                    continue;
                }
                // footColumns[undefined] would throw in the reference
                assert!((initial_foot as usize) < 5, "hold switch from an undefined foot");
                let from = data.result_state.foot_columns[initial_foot as usize];
                let tempcost = self.weights.holdswitch
                    * (if from == -1 { 1.0 } else { self.layout.get_distance_sq(c as i8, from).sqrt() });
                cost += tempcost;
            }
        }
        cost
    }

    pub fn calc_bracket_tap_cost(&self, data: &PlacementData, elapsed_time: f64) -> f64 {
        let mut cost = 0.0;
        let r = data.result_state;
        for (heel, toe) in [(LEFT_HEEL, LEFT_TOE), (RIGHT_HEEL, RIGHT_TOE)] {
            if r.foot_columns[heel as usize] == -1 || r.foot_columns[toe as usize] == -1 {
                continue;
            }
            if r.hold_feet.has(heel) == r.hold_feet.has(toe) {
                continue;
            }
            let free = if r.hold_feet.has(heel) { toe } else { heel };
            let tap_col = r.foot_columns[free as usize];
            if r.action[tap_col as usize] != free {
                continue;
            }
            let mut jack_penalty = 1.0;
            let init = data.initial_state;
            let moved = &init.moved_feet;
            let foot_moved = moved.has(heel) || moved.has(toe);
            let rocking = init.foot_columns[heel as usize] != -1
                && init.foot_columns[toe as usize] != -1
                && !moved.has(free)
                && moved.has(OTHER_PART_OF_FOOT(free));
            if (data.jumped && foot_moved) || (!data.jumped && rocking) {
                jack_penalty = if BRACKET_TAP_JACK_WINDOW > 0.0 {
                    math_max(1.0, BRACKET_TAP_JACK_WINDOW / elapsed_time)
                } else {
                    1.0 / elapsed_time
                };
            }
            let hold_col = r.foot_columns[OTHER_PART_OF_FOOT(free) as usize];
            let oriented = [
                init.foot_columns[heel as usize],
                init.foot_columns[toe as usize],
                if PIVOT_FROM_HOVER { init.hover[heel as usize] } else { -1 },
            ]
            .into_iter()
            .filter(|&c| c != -1 && c != hold_col && self.layout.bracket_check(c, hold_col))
            .count();
            let planted = init.foot_columns[heel as usize] == tap_col || init.foot_columns[toe as usize] == tap_col;
            let trailed = init.hover[heel as usize] == tap_col && !init.hover_pivot[heel as usize];
            let other_heel = if heel == LEFT_HEEL { RIGHT_HEEL } else { LEFT_HEEL };
            let switched = [other_heel, OTHER_PART_OF_FOOT(other_heel)]
                .iter()
                .any(|&f| init.foot_columns[f as usize] == tap_col);
            let factor = if switched {
                SWITCH_BRACKET_TAP_FACTOR
            } else if planted {
                PRIMED_BRACKET_TAP_FACTOR
            } else if trailed {
                TRAIL_PRIMED_BRACKET_TAP_FACTOR
            } else if oriented > 0 {
                PIVOT_BRACKET_TAP_FACTOR
            } else {
                1.0
            };
            cost += self.weights.brackettap * jack_penalty * factor;
        }
        cost
    }

    pub fn calc_start_crossover(&self, data: &PlacementData, row_index: usize) -> f64 {
        // Don't start the chart crossed over
        if data.right_pos.x < data.left_pos.x && row_index == 0 {
            return self.weights.start_xo;
        }
        0.0
    }

    pub fn calc_bracket_jack_cost(&self, data: &PlacementData) -> f64 {
        if data.jumped {
            return 0.0;
        }
        let feet = [
            (data.left_jack, data.left_bracket, LEFT_HEEL, LEFT_TOE),
            (data.right_jack, data.right_bracket, RIGHT_HEEL, RIGHT_TOE),
        ];
        for (jack, bracket, heel, toe) in feet {
            if !jack || !bracket {
                continue;
            }
            let old_cols = [
                data.initial_state.foot_columns[heel as usize],
                data.initial_state.foot_columns[toe as usize],
            ];
            let new_cols = [
                data.result_state.foot_columns[heel as usize],
                data.result_state.foot_columns[toe as usize],
            ];
            if new_cols.iter().all(|&c| c == -1 || old_cols.contains(&c)) {
                return self.weights.bracketjack;
            }
        }
        0.0
    }

    pub fn calc_xobr_cost(&self, data: &PlacementData) -> f64 {
        let mut cost = 0.0;
        let is_crossed_over = data.result_state.facing != facing::FORWARD;
        let was_crossed_over = data.initial_state.facing != facing::FORWARD;
        if was_crossed_over {
            return 0.0;
        }
        if data.left_bracket && is_crossed_over {
            cost += self.weights.xo_br;
        }
        if data.right_bracket && is_crossed_over {
            cost += self.weights.xo_br;
        }
        cost
    }

    fn is_foot_lifted(&self, state: &ParityState, heel: Foot) -> bool {
        state.foot_columns[heel as usize] == -1 && state.foot_columns[OTHER_PART_OF_FOOT(heel) as usize] == -1
    }

    pub fn calc_xo_transition_cost(&self, data: &PlacementData) -> f64 {
        let was_crossed_over = data.initial_state.facing != facing::FORWARD;
        let is_crossed_over = data.result_state.facing != facing::FORWARD;
        if !was_crossed_over && is_crossed_over {
            return self.weights.xo_entry;
        }
        0.0
    }

    pub fn calc_reversal_cost(&self, data: &PlacementData) -> f64 {
        let init = data.initial_state;
        let res = data.result_state;
        if !init.facing_provisional || res.facing == facing::FORWARD {
            return 0.0;
        }
        if init.last_turn == facing::FORWARD || init.last_turn == res.facing {
            return 0.0;
        }
        if init.second - init.last_turn_end >= REVERSAL_WINDOW {
            return 0.0;
        }
        self.weights.twisted_foot
    }

    // A crossover onto a roll head that the other foot takes over on the next
    // row, uncrossing, gives back the entry paid on the row before.
    pub fn calc_xo_roll_resolved_cost(&self, data: &PlacementData, row: &Row) -> f64 {
        let c = data.initial_state.crossed_onto_roll;
        if c == -1 || data.result_state.facing != facing::FORWARD {
            return 0.0;
        }
        let c = c as usize;
        if row.notes[c].is_some() || row.holds[c].is_none_or(|h| h.beat != data.initial_state.beat) {
            return 0.0;
        }
        let before = data.initial_state.combined_columns[c];
        let after = data.result_state.combined_columns[c];
        if after == NONE || after == before || after == OTHER_PART_OF_FOOT(before) {
            return 0.0;
        }
        -self.weights.xo_entry
    }

    pub fn calc_xo_stay_cost(&self, data: &PlacementData) -> f64 {
        if data.result_state.facing != facing::FORWARD {
            return self.weights.xo_stay;
        }
        0.0
    }

    pub fn calc_doublestep_cost(
        &self,
        data: &PlacementData,
        last_row: Option<&Row>,
        row: &Row,
        elapsed_time: f64,
    ) -> f64 {
        if data.left_double_step || data.right_double_step {
            // a doublestep needs a previous row: lastRow is defined here
            let last_row = last_row.expect("doublestep without a previous row");
            for i in 0..self.layout.layout.len() {
                let hold = last_row.holds[i];
                if hold.is_some() && !last_row.has_hold_tail(i) && elapsed_time >= HOLD_DOUBLESTEP_FREE_TIME {
                    return 0.0;
                }
            }

            let init = data.initial_state;
            if data.left_double_step {
                let will_hit_mine = truthy(row.mine_at(init.foot_columns[LEFT_HEEL as usize]))
                    || truthy(row.fake_mine_at(init.foot_columns[LEFT_HEEL as usize]))
                    || truthy(row.mine_at(init.foot_columns[LEFT_TOE as usize]))
                    || truthy(row.fake_mine_at(init.foot_columns[LEFT_TOE as usize]));
                if will_hit_mine {
                    return 0.0;
                }
            }
            if data.right_double_step {
                let will_hit_mine = truthy(row.mine_at(init.foot_columns[RIGHT_HEEL as usize]))
                    || truthy(row.fake_mine_at(init.foot_columns[RIGHT_HEEL as usize]))
                    || truthy(row.mine_at(init.foot_columns[RIGHT_TOE as usize]))
                    || truthy(row.fake_mine_at(init.foot_columns[RIGHT_TOE as usize]));
                if will_hit_mine {
                    return 0.0;
                }
            }

            let crossed = if data.result_state.facing != facing::FORWARD { CROSSED_DOUBLESTEP_FACTOR } else { 1.0 };
            let heel = if data.left_double_step { LEFT_HEEL } else { RIGHT_HEEL };
            let after_jack = !data.previous_jumped
                && (init.moved_feet.has(heel) || init.moved_feet.has(OTHER_PART_OF_FOOT(heel)))
                && !init.traveled_feet.has(heel);
            return self.weights.doublestep
                * math_max(1.0, DOUBLESTEP_BASE_TIME / elapsed_time)
                * crossed
                * (if after_jack { JACK_DOUBLESTEP_FACTOR } else { 1.0 });
        }
        0.0
    }

    pub fn calc_jump_cost(&self, data: &PlacementData, elapsed_time: f64) -> f64 {
        if !data.jumped {
            return 0.0;
        }
        // don't apply this cost for stepjumps
        if !data.result_state.traveled_feet.has(LEFT_HEEL) || !data.result_state.traveled_feet.has(RIGHT_HEEL) {
            return 0.0;
        }
        self.weights.jump * math_max(1.0, DOUBLESTEP_BASE_TIME / elapsed_time)
    }

    #[allow(dead_code)]
    pub fn calc_slow_bracket_cost(&self, data: &PlacementData, row: &Row, elapsed_time: f64) -> f64 {
        let was_crossed_over = data.initial_state.facing != facing::FORWARD;
        if was_crossed_over {
            return 0.0;
        }
        if elapsed_time > SLOW_BRACKET_THRESHOLD && (data.left_bracket || data.right_bracket) && !data.jumped {
            let result = data.result_state;
            let mut bracket_parts: Vec<Foot> = Vec::new();
            if data.left_bracket {
                bracket_parts.extend([LEFT_HEEL, LEFT_TOE]);
            }
            if data.right_bracket {
                bracket_parts.extend([RIGHT_HEEL, RIGHT_TOE]);
            }
            for part in bracket_parts {
                let col = result.foot_columns[part as usize];
                if col == -1 {
                    continue;
                }
                let note = row.note_at(col);
                if row.hold_at(col).is_some() || note.is_some_and(is_hold_note) {
                    return 0.0;
                }
            }
            return math_min(SLOW_BRACKET_CAP, elapsed_time - SLOW_BRACKET_THRESHOLD) * self.weights.slow_bracket;
        }
        0.0
    }

    fn y(&self, col: i8) -> f64 {
        self.layout.layout[col as usize].y
    }

    fn includes(list: &[i8], col: i8) -> bool {
        list.contains(&col)
    }

    pub fn calc_twisted_foot(&self, data: &PlacementData) -> f64 {
        let l = &self.layout;
        let res = data.result_state;
        let init = data.initial_state;
        let right_backwards = if res.right_heel() != -1 && res.right_toe() != -1 {
            self.y(res.right_toe()) < self.y(res.right_heel())
        } else {
            false
        };
        let left_backwards = if res.left_heel() != -1 && res.left_toe() != -1 {
            self.y(res.left_toe()) < self.y(res.left_heel())
        } else {
            false
        };

        let fc = |s: &ParityState, f: Foot| s.foot_columns[f as usize];
        let inc = Self::includes;

        let left_down_and_right_lu = inc(&l.down_arrows, fc(init, LEFT_HEEL))
            && inc(&l.up_arrows, fc(res, RIGHT_TOE))
            && inc(&l.left_arrows, fc(res, RIGHT_HEEL));
        let right_down_and_left_ru = inc(&l.down_arrows, fc(init, RIGHT_HEEL))
            && inc(&l.up_arrows, fc(res, LEFT_TOE))
            && inc(&l.right_arrows, fc(res, LEFT_HEEL));
        let left_up_and_right_left = (inc(&l.up_arrows, fc(init, LEFT_HEEL)) || inc(&l.up_arrows, fc(init, LEFT_TOE)))
            && inc(&l.left_arrows, fc(res, RIGHT_TOE));
        let right_up_and_left_right = (inc(&l.up_arrows, fc(init, RIGHT_HEEL))
            || inc(&l.up_arrows, fc(init, RIGHT_TOE)))
            && inc(&l.right_arrows, fc(res, LEFT_TOE));
        let twisted_shin =
            left_down_and_right_lu || right_down_and_left_ru || left_up_and_right_left || right_up_and_left_right;

        let unnatural_facing_right = init.facing == facing::RIGHT
            && ((inc(&l.down_arrows, fc(res, LEFT_HEEL)) && inc(&l.left_arrows, fc(res, LEFT_TOE)))
                || (inc(&l.right_arrows, fc(res, RIGHT_HEEL)) && inc(&l.up_arrows, fc(res, RIGHT_TOE)))
                // would face backwards
                || (inc(&l.left_arrows, fc(res, RIGHT_HEEL)) && inc(&l.down_arrows, fc(res, LEFT_HEEL))));
        let unnatural_facing_left = init.facing == facing::LEFT
            && ((inc(&l.down_arrows, fc(res, RIGHT_HEEL)) && inc(&l.right_arrows, fc(res, RIGHT_TOE)))
                || (inc(&l.left_arrows, fc(res, LEFT_HEEL)) && inc(&l.up_arrows, fc(res, LEFT_TOE)))
                // would face backwards
                || (inc(&l.right_arrows, fc(res, LEFT_HEEL)) && inc(&l.down_arrows, fc(res, RIGHT_HEEL))));
        let facing_twist_bracket = !init.facing_provisional && (unnatural_facing_right || unnatural_facing_left);

        if right_backwards || left_backwards || twisted_shin || facing_twist_bracket {
            return self.weights.twisted_foot;
        }
        0.0
    }

    pub fn calc_spin_cost(&self, data: &PlacementData) -> f64 {
        let mut cost = 0.0;
        if self.is_foot_lifted(data.initial_state, LEFT_HEEL)
            || self.is_foot_lifted(data.initial_state, RIGHT_HEEL)
            || self.is_foot_lifted(data.result_state, LEFT_HEEL)
            || self.is_foot_lifted(data.result_state, RIGHT_HEEL)
        {
            return 0.0;
        }

        let mut prev_angle = get_player_angle(data.previous_left_pos, data.previous_right_pos);
        let mut angle = get_player_angle(data.left_pos, data.right_pos);

        if angle.abs() < PI / 2.0 || prev_angle.abs() < PI / 2.0 {
            return 0.0;
        }

        if angle < 0.0 {
            angle += PI * 2.0;
        }
        if prev_angle < 0.0 {
            prev_angle += PI * 2.0;
        }

        // prevent facing backwards but not turning causing a spin
        if angle == prev_angle {
            return 0.0;
        }

        // If we cross the 180 deg line, that's a spin
        if ((prev_angle <= PI && angle >= PI) || (prev_angle >= PI && angle <= PI))
            && data.initial_state.front_foot != data.result_state.front_foot
        {
            cost += self.weights.spin;
        }
        cost
    }

    pub fn calc_slow_footswitch_cost(&self, data: &PlacementData, row: &Row, elapsed_time: f64) -> f64 {
        if elapsed_time < SLOW_FOOTSWITCH_THRESHOLD {
            return 0.0;
        }
        if data.jumped {
            return 0.0;
        }
        // footswitching has no penalty if there's a mine nearby
        if row.mines.iter().any(|x| x.is_some()) || row.fake_mines.iter().any(|x| x.is_some()) {
            return 0.0;
        }
        let mut cost = 0.0;
        for foot in data.result_state.moved_feet.iter() {
            let col = data.result_state.foot_columns[foot as usize];
            let was = data.initial_state.combined_at(col);
            if was == NONE {
                continue;
            }
            // A hold takeover is not a footswitch — HOLDSWITCH prices it.
            if row.hold_at(col).is_some() {
                continue;
            }
            if was == foot || was == OTHER_PART_OF_FOOT(foot) {
                continue;
            }
            cost += math_min(
                ((elapsed_time - SLOW_FOOTSWITCH_THRESHOLD) / elapsed_time) * self.weights.footswitch,
                SLOW_FOOTSWITCH_CAP,
            );
        }
        cost
    }

    pub fn calc_hold_part_footswitch_cost(&self, data: &PlacementData, row: &Row, elapsed_time: f64) -> f64 {
        if data.jumped || elapsed_time >= HOLD_PART_FOOTSWITCH_MAX_TIME {
            return 0.0;
        }
        let init = data.initial_state;
        let mut cost = 0.0;
        for foot in data.result_state.moved_feet.iter() {
            let col = data.result_state.foot_columns[foot as usize];
            if row.hold_at(col).is_some() {
                continue;
            }
            let was = init.combined_at(col);
            if was == NONE || was == foot || was == OTHER_PART_OF_FOOT(foot) {
                continue;
            }
            let just_tapped = init.moved_feet.has(was);
            // footColumns[OTHER_PART_OF_FOOT[undefined]] is undefined, never -1
            let partner_col = if (was as usize) < 5 { Some(init.foot_columns[OTHER_PART_OF_FOOT(was) as usize]) } else { None };
            if just_tapped {
                if let Some(partner_col) = partner_col {
                    if partner_col != -1 && partner_col != col && row.hold_at(partner_col).is_some() {
                        cost += self.weights.footswitch * HOLD_PART_FOOTSWITCH_FACTOR;
                    }
                }
            }
        }
        cost
    }

    pub fn calc_sideswitch_cost(&self, data: &PlacementData, row: &Row) -> f64 {
        let mut cost = 0.0;
        if data.jumped {
            return 0.0;
        }
        let was_crossed_over = data.initial_state.facing != facing::FORWARD;
        let mined_row = row.mines.iter().any(|x| x.is_some()) || row.fake_mines.iter().any(|x| x.is_some());
        let switch_scale = if was_crossed_over || mined_row { 0.25 } else { 1.0 };

        for &col in &self.layout.side_arrows {
            let col = col as usize;
            let action = data.result_state.action[col];
            let was = data.initial_state.combined_columns[col];
            if action == NONE {
                continue;
            }
            if was == NONE {
                continue;
            }
            if was == action || was == OTHER_PART_OF_FOOT(action) {
                continue;
            }
            cost += self.weights.sideswitch * switch_scale;
        }
        cost
    }

    pub fn calc_rotation_twist_cost(&self, data: &PlacementData) -> f64 {
        let init = data.initial_state;
        let res = data.result_state;
        if init.facing == facing::FORWARD || res.facing != facing::FORWARD {
            return 0.0;
        }
        if init.facing_provisional {
            return 0.0;
        }
        if self.is_foot_lifted(res, LEFT_HEEL) || self.is_foot_lifted(res, RIGHT_HEEL) {
            return 0.0;
        }
        let lateral = |p: Point| if init.facing == facing::RIGHT { p.y } else { -p.y };
        if lateral(data.left_pos) < lateral(data.right_pos) - 1e-6 {
            self.weights.twisted_foot
        } else {
            0.0
        }
    }

    pub fn calc_missed_footswitch_cost(&self, data: &PlacementData, row: &Row, elapsed_time: f64) -> f64 {
        if mine_forces_footswitch(data, row, elapsed_time) {
            self.weights.missed_footswitch
        } else {
            0.0
        }
    }

    pub fn calc_jack_cost(&self, data: &PlacementData, row: &Row, elapsed_time: f64, stepjump: bool) -> f64 {
        let jack_cost = self.weights.jack * 0.125
            + (if elapsed_time < JACK_MAX_ELAPSED_TIME {
                (1.0 / elapsed_time - 1.0 / JACK_MAX_ELAPSED_TIME) * self.weights.jack * (4.0 / 15.0)
            } else {
                0.0
            });
        let mut cost = 0.0;
        if data.left_jack || data.right_jack {
            cost += jack_cost;
        }
        if data.jumped {
            let planted = stepjump || is_planted_jump(row, data.initial_state, data.result_state, elapsed_time);
            let f = if planted { STEPJUMP_JACK_FACTOR } else { 1.0 };
            for heel in [LEFT_HEEL, RIGHT_HEEL] {
                match jump_repress(data.initial_state, data.result_state, heel) {
                    Some(Repress::Same) => cost += jack_cost * f,
                    Some(Repress::Subset) => cost += jack_cost * STEPJUMP_JACK_FACTOR,
                    None => {}
                }
            }
        }
        cost
    }

    pub fn calc_distance_cost(&self, data: &PlacementData, elapsed_time: f64, rows: &Rows, row_index: usize) -> f64 {
        let mut cost = 0.0;
        let last_row = if row_index >= 1 { rows.get(row_index - 1) } else { None };
        let row_before = if row_index >= 2 { rows.get(row_index - 2) } else { None };
        for foot in [LEFT_HEEL, RIGHT_HEEL] {
            // either part: a bracket tap by the toe travels like one by the heel
            if !data.result_state.moved_feet.has(foot) && !data.result_state.moved_feet.has(OTHER_PART_OF_FOOT(foot)) {
                continue;
            }
            let initial_position = if foot == LEFT_HEEL { data.previous_left_pos } else { data.previous_right_pos };
            let result_position = if foot == LEFT_HEEL { data.left_pos } else { data.right_pos };

            let mut foot_time = elapsed_time;
            if !data.initial_state.moved_feet.has(foot) && !data.initial_state.moved_feet.has(OTHER_PART_OF_FOOT(foot)) {
                foot_time *= 2.0;
            }
            // A foot that took over a roll re-tapped it halfway through the
            // last row gap, so it has been free to leave since then.
            else if let (Some(last_row), Some(row_before)) = (last_row, row_before) {
                let c = data.initial_state.foot_columns[foot as usize];
                if data.initial_state.moved_feet.has(foot)
                    && c != -1
                    && last_row.holds[c as usize].is_some_and(|h| h.note_type == NoteType::Roll)
                    && last_row.notes[c as usize].is_none()
                {
                    foot_time += (last_row.second - row_before.second) / 2.0;
                }
            }

            if data.previous_jumped && !data.jumped && elapsed_time < 0.25 {
                foot_time = foot_time.powf(1.5);
            }

            let travel = self.layout.get_distance_sq_points(initial_position, result_position).sqrt();
            let dist = (travel * (if travel >= 2.0 - 1e-6 { CANDLE_FACTOR } else { 1.0 }) * self.weights.distance)
                / foot_time;
            cost += dist;
        }
        cost
    }

    pub fn calc_crowded_bracket_cost(&self, data: &PlacementData, elapsed_time: f64) -> f64 {
        if data.jumped || elapsed_time < CROWDED_BRACKET_MIN_TIME {
            return 0.0;
        }
        let init = data.initial_state;
        let res = data.result_state;
        let settled_on = |heel: Foot, toe: Foot, cols: [i8; 2]| {
            [init.foot_columns[heel as usize], init.foot_columns[toe as usize]]
                .iter()
                .any(|&c| c != -1 && cols.contains(&c))
        };
        if data.left_bracket
            && !data.previous_moved_right
            && settled_on(RIGHT_HEEL, RIGHT_TOE, [res.left_heel(), res.left_toe()])
        {
            return self.weights.crowded_bracket;
        }
        if data.right_bracket
            && !data.previous_moved_left
            && settled_on(LEFT_HEEL, LEFT_TOE, [res.right_heel(), res.right_toe()])
        {
            return self.weights.crowded_bracket;
        }
        0.0
    }
}
