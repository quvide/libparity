use crate::note_types::NoteType;
use crate::parity_data_types::{
    ParityState, PlacementData, Point, RollTap, Row, Foot, LEFT_HEEL, LEFT_TOE, NONE, OTHER_PART_OF_FOOT,
    RIGHT_HEEL, RIGHT_TOE,
};
use crate::parity_utils::do_feet_overlap;
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub struct StagePoint {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

const JUMP_EITHER_PART: bool = true;

// relative slack when comparing a row gap with twice a roll's stream step
const STREAM_GAP_TOLERANCE: f64 = 0.05;

#[derive(Clone, Debug)]
pub struct StageLayout {
    pub name: &'static str,
    pub layout: Vec<StagePoint>,
    pub column_count: usize,
    pub up_arrows: Vec<i8>,
    pub down_arrows: Vec<i8>,
    pub side_arrows: Vec<i8>,
    pub left_arrows: Vec<i8>,
    pub right_arrows: Vec<i8>,
}

pub struct CrossedFeet {
    pub left_on_right: bool,
    pub right_on_left: bool,
}

impl StageLayout {
    pub fn new(
        name: &'static str,
        layout: Vec<StagePoint>,
        up_arrows: Vec<i8>,
        down_arrows: Vec<i8>,
        side_arrows: Vec<i8>,
    ) -> StageLayout {
        let left_arrows = side_arrows.iter().copied().filter(|&c| layout[c as usize].x < 0.0).collect();
        let right_arrows = side_arrows.iter().copied().filter(|&c| layout[c as usize].x > 0.0).collect();
        StageLayout {
            name,
            column_count: layout.len(),
            layout,
            up_arrows,
            down_arrows,
            side_arrows,
            left_arrows,
            right_arrows,
        }
    }

    fn point(&self, col: i8) -> Point {
        let p = &self.layout[col as usize];
        Point { x: p.x, y: p.y }
    }

    pub fn crossed_feet(&self, state: &ParityState) -> CrossedFeet {
        let left_on_right = [LEFT_HEEL, LEFT_TOE]
            .iter()
            .any(|&foot| self.right_arrows.contains(&state.foot_columns[foot as usize]));
        let right_on_left = [RIGHT_HEEL, RIGHT_TOE]
            .iter()
            .any(|&foot| self.left_arrows.contains(&state.foot_columns[foot as usize]));
        CrossedFeet { left_on_right, right_on_left }
    }

    pub fn average_point(&self, left_index: i8, right_index: i8) -> Point {
        if left_index == -1 && right_index == -1 {
            return Point { x: 0.0, y: 0.0 };
        }
        if left_index == -1 {
            return self.point(right_index);
        }
        if right_index == -1 {
            return self.point(left_index);
        }
        let l = self.point(left_index);
        let r = self.point(right_index);
        Point { x: (l.x + r.x) / 2.0, y: (l.y + r.y) / 2.0 }
    }

    pub fn get_distance_sq(&self, left_index: i8, right_index: i8) -> f64 {
        let p1 = self.point(left_index);
        let p2 = self.point(right_index);
        (p1.y - p2.y) * (p1.y - p2.y) + (p1.x - p2.x) * (p1.x - p2.x)
    }

    pub fn get_distance_sq_points(&self, p1: Point, p2: Point) -> f64 {
        (p1.y - p2.y) * (p1.y - p2.y) + (p1.x - p2.x) * (p1.x - p2.x)
    }

    pub fn bracket_check(&self, column1: i8, column2: i8) -> bool {
        self.get_distance_sq(column1, column2) <= 2.0
    }

    /// `lastRow` is undefined for the first row.
    pub fn get_placement_data<'s>(
        &self,
        initial_state: &'s ParityState,
        result_state: &'s ParityState,
        last_row: Option<&Row>,
        row: &Row,
    ) -> PlacementData<'s> {
        // indexed by foot; an undefined action (initial state) sets a property no one reads
        let mut previous_non_held_feet = [false; 5];
        let mut non_held_feet = [false; 5];

        for i in 0..self.layout.len() {
            if let Some(last_row) = last_row {
                let a = initial_state.action[i];
                if last_row.holds[i].is_none() && a != NONE && (a as usize) < 5 {
                    previous_non_held_feet[a as usize] = true;
                }
            }
            let a = result_state.action[i];
            if row.holds[i].is_none() && a != NONE && (a as usize) < 5 {
                non_held_feet[a as usize] = true;
            }
        }

        let previous_moved_left =
            previous_non_held_feet[LEFT_HEEL as usize] || previous_non_held_feet[LEFT_TOE as usize];
        let previous_moved_right =
            previous_non_held_feet[RIGHT_HEEL as usize] || previous_non_held_feet[RIGHT_TOE as usize];

        let moved_left = non_held_feet[LEFT_HEEL as usize] || non_held_feet[LEFT_TOE as usize];
        let moved_right = non_held_feet[RIGHT_HEEL as usize] || non_held_feet[RIGHT_TOE as usize];

        let left_bracket = non_held_feet[LEFT_HEEL as usize] && non_held_feet[LEFT_TOE as usize];
        let right_bracket = non_held_feet[RIGHT_HEEL as usize] && non_held_feet[RIGHT_TOE as usize];

        let previous_jumped = if JUMP_EITHER_PART {
            previous_moved_left && previous_moved_right
        } else {
            previous_non_held_feet[LEFT_HEEL as usize] && previous_non_held_feet[RIGHT_HEEL as usize]
        };

        let jumped = if JUMP_EITHER_PART {
            moved_left && moved_right
        } else {
            non_held_feet[LEFT_HEEL as usize] && non_held_feet[RIGHT_HEEL as usize]
        };

        let left_traveled = result_state.traveled_feet.has(LEFT_HEEL);
        let right_traveled = result_state.traveled_feet.has(RIGHT_HEEL);

        let left_jack = !jumped
            && do_feet_overlap(
                initial_state.left_heel(),
                initial_state.left_toe(),
                result_state.left_heel(),
                result_state.left_toe(),
            )
            && previous_moved_left
            && moved_left
            && !left_traveled;
        let right_jack = !jumped
            && do_feet_overlap(
                initial_state.right_heel(),
                initial_state.right_toe(),
                result_state.right_heel(),
                result_state.right_toe(),
            )
            && previous_moved_right
            && moved_right
            && !right_traveled;

        let previous_real_jump = previous_jumped
            && initial_state.traveled_feet.has(LEFT_HEEL)
            && initial_state.traveled_feet.has(RIGHT_HEEL);

        // A roll re-tapped between rows acts like an arrow on its panel: the
        // foot that took the roll over re-tapped it; the foot that stays on it
        // only when the gap is a hole in the stream the roll started in (twice
        // its step).
        let gap = if let Some(last_row) = last_row { row.second - last_row.second } else { 0.0 };
        let stream_gap = |step: Option<f64>| step.is_some_and(|step| (gap - 2.0 * step).abs() <= STREAM_GAP_TOLERANCE * gap);
        let mut left_retapped = false;
        let mut right_retapped = false;
        let mut roll_taps: Vec<RollTap> = Vec::new();
        for i in 0..self.layout.len() {
            let Some(hold) = row.holds[i] else { continue };
            if hold.note_type != NoteType::Roll || hold.beat > initial_state.beat {
                continue;
            }
            let before = initial_state.combined_columns[i];
            if before == NONE {
                continue;
            }
            let after = result_state.combined_columns[i];
            let stayed = after == NONE || after == before || after == OTHER_PART_OF_FOOT(before);
            if stayed && !stream_gap(row.roll_steps[i]) {
                continue;
            }
            let tapper = if stayed { before } else { after };
            roll_taps.push(RollTap { col: i, foot: tapper });
            if tapper == LEFT_HEEL || tapper == LEFT_TOE {
                left_retapped = true;
            } else {
                right_retapped = true;
            }
        }

        let left_double_step = !right_retapped
            && previous_moved_left
            && moved_left
            && left_traveled
            && !jumped
            && !left_jack
            && !previous_real_jump;
        let right_double_step = !left_retapped
            && previous_moved_right
            && moved_right
            && right_traveled
            && !jumped
            && !right_jack
            && !previous_real_jump;
        let left_after_stepjump = previous_jumped
            && initial_state.traveled_feet.has(RIGHT_HEEL)
            && !initial_state.traveled_feet.has(LEFT_HEEL);
        let right_after_stepjump = previous_jumped
            && initial_state.traveled_feet.has(LEFT_HEEL)
            && !initial_state.traveled_feet.has(RIGHT_HEEL);

        let previous_left_pos = self.foot_position(initial_state, LEFT_HEEL);
        let previous_right_pos = self.foot_position(initial_state, RIGHT_HEEL);

        let left_pos = self.foot_position(result_state, LEFT_HEEL);
        let right_pos = self.foot_position(result_state, RIGHT_HEEL);

        PlacementData {
            previous_left_pos,
            previous_right_pos,
            left_pos,
            right_pos,
            moved_left,
            moved_right,
            previous_moved_left,
            previous_moved_right,
            left_bracket,
            right_bracket,
            previous_jumped,
            jumped,
            left_jack,
            right_jack,
            left_double_step,
            right_double_step,
            roll_taps,
            left_after_stepjump,
            right_after_stepjump,
            initial_state,
            result_state,
        }
    }

    // offset hovering (-1) y by 0.5 depending on frontFoot
    pub fn foot_position(&self, state: &ParityState, heel: Foot) -> Point {
        let heel_col = state.foot_columns[heel as usize];
        let toe_col = state.foot_columns[OTHER_PART_OF_FOOT(heel) as usize];
        if heel_col != -1 || toe_col != -1 {
            return self.average_point(heel_col, toe_col);
        }
        match state.front_foot {
            None => Point { x: 0.0, y: 0.0 },
            Some(front) => {
                let sign = if front == heel { 1.0 } else { -1.0 };
                Point { x: 0.0, y: 0.5 * sign }
            }
        }
    }
}

pub fn stage_layout(name: &str) -> Option<StageLayout> {
    let p = |x: f64, y: f64, rotation: f64| StagePoint { x, y, rotation };
    match name {
        "dance-single" => Some(StageLayout::new(
            "dance-single",
            vec![
                p(-1.0, 0.0, 0.0),              // Left
                p(0.0, -1.0, (PI / 2.0) * 3.0), // Down
                p(0.0, 1.0, PI / 2.0),          // Up
                p(1.0, 0.0, PI),                // Right
            ],
            vec![2],
            vec![1],
            vec![0, 3],
        )),
        "dance-double" => Some(StageLayout::new(
            "dance-double",
            vec![
                p(-2.5, 0.0, 0.0),              // P1 Left
                p(-1.5, -1.0, (PI / 2.0) * 3.0), // P1 Down
                p(-1.5, 1.0, PI / 2.0),          // P1 Up
                p(-0.5, 0.0, PI),                // P1 Right
                p(0.5, 0.0, 0.0),                // P2 Left
                p(1.5, -1.0, (PI / 2.0) * 3.0),  // P2 Down
                p(1.5, 1.0, PI / 2.0),           // P2 Up
                p(2.5, 0.0, PI),                 // P2 Right
            ],
            vec![2, 6],
            vec![1, 5],
            vec![0, 3, 4, 7],
        )),
        _ => None,
    }
}
