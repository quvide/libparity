use crate::note_types::NotedataEntry;
use crate::parity_data_types::{
    Foot, FootOverride, ParityState, PlacementData, Point, Row, Rows, LEFT_HEEL, MAX_COLUMNS,
    OTHER_PART_OF_FOOT, RIGHT_HEEL,
};

/// two times closer than this are the same row
pub const SECOND_EPSILON: f64 = 0.0005;

// Beats within 1/96 are the same row for annotation purposes (charts are
// quantized to 1/48; half of that absorbs float drift).
pub const HOLD_OVERRIDE_EPSILON: f64 = 1.0 / 96.0;

/// The takeover annotation governing a hold's column at the given beat: the
/// latest holdOverrides entry at or before the beat. Entries at the hold head
/// are ignored (the head note's ordinary override covers that row).
pub fn hold_override_at(hold: &NotedataEntry, beat: f64) -> Option<FootOverride> {
    let list = hold.parity.as_ref()?.hold_overrides.as_ref()?;
    if list.is_empty() {
        return None;
    }
    let mut result = None;
    for entry in list {
        if entry.beat > beat + HOLD_OVERRIDE_EPSILON {
            break;
        }
        if entry.beat <= hold.beat + HOLD_OVERRIDE_EPSILON {
            continue;
        }
        result = Some(entry.foot);
    }
    result
}

// Stepjumps are played at 8th speed or thereabouts; a shared panel further
// apart than this is two separate events.
pub const STEPJUMP_MAX_GAP: f64 = 0.5;

pub fn note_columns(row: &Row) -> Vec<usize> {
    (0..MAX_COLUMNS).filter(|&c| row.notes[c].is_some()).collect()
}

// A two-arrow jump whose adjacent single (the row before or after) is on one
// of the jump's panels, so that foot stays planted across the jump.
pub fn is_stepjump(rows: &Rows, idx: usize) -> bool {
    let jump = &rows[idx];
    let panels = note_columns(jump);
    if panels.len() != 2 {
        return false;
    }
    let shares_panel = |row: Option<&Row>| {
        let Some(row) = row else { return false };
        if (row.second - jump.second).abs() > STEPJUMP_MAX_GAP {
            return false;
        }
        let cols = note_columns(row);
        cols.len() == 1 && panels.contains(&cols[0])
    };
    shares_panel(if idx > 0 { rows.get(idx - 1) } else { None }) || shares_panel(rows.get(idx + 1))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Repress {
    Same,
    Subset,
}

/// How a foot re-presses on a jump row right after it moved: Same when it
/// presses exactly the panels it pressed before, Subset when it presses one
/// panel of its previous bracket, None otherwise. Parts still holding are not presses.
pub fn jump_repress(initial_state: &ParityState, result_state: &ParityState, heel: Foot) -> Option<Repress> {
    let toe = OTHER_PART_OF_FOOT(heel);
    if !initial_state.moved_feet.has(heel) && !initial_state.moved_feet.has(toe) {
        return None;
    }
    let mut before: Vec<usize> = Vec::new();
    let mut now: Vec<usize> = Vec::new();
    // result_state.action.length: columns past it hold UNDEFINED_FOOT and match nothing
    for col in 0..MAX_COLUMNS {
        let a = initial_state.action[col];
        if (a == heel || a == toe) && !initial_state.hold_feet.has(a) {
            before.push(col);
        }
        let foot = result_state.action[col];
        if (foot == heel || foot == toe) && !result_state.hold_feet.has(foot) {
            now.push(col);
        }
    }
    if now.is_empty() || !now.iter().any(|c| before.contains(c)) {
        return None;
    }
    if now.len() == before.len() && now.iter().zip(before.iter()).all(|(a, b)| a == b) {
        return Some(Repress::Same);
    }
    Some(Repress::Subset)
}

// A two-arrow jump within StepjumpMaxGap of the previous row where exactly
// one foot re-presses a panel it stood on and the other foot moves to a new
// panel.
pub fn is_planted_jump(
    row: &Row,
    initial_state: &ParityState,
    result_state: &ParityState,
    elapsed_time: f64,
) -> bool {
    if elapsed_time > STEPJUMP_MAX_GAP || note_columns(row).len() != 2 {
        return false;
    }
    let l = jump_repress(initial_state, result_state, LEFT_HEEL).is_some();
    let r = jump_repress(initial_state, result_state, RIGHT_HEEL).is_some();
    l != r
}

pub fn do_feet_overlap(old_heel: i8, old_toe: i8, new_heel: i8, new_toe: i8) -> bool {
    if old_heel != -1 && (old_heel == new_heel || old_heel == new_toe) {
        return true;
    }
    if old_toe != -1 && (old_toe == new_heel || old_toe == new_toe) {
        return true;
    }
    false
}

pub fn get_player_angle(left: Point, right: Point) -> f64 {
    let x1 = right.x - left.x;
    let y1 = right.y - left.y;
    let x2 = 1.0;
    let y2 = 0.0;
    let dot = x1 * x2 + y1 * y2;
    let det = x1 * y2 - y1 * x2;
    det.atan2(dot)
}

// A mine right before a repeated note says "switch feet". The hint only
// applies inside a running pattern.
pub const MINE_FOOTSWITCH_MAX_GAP: f64 = 2.0;
// how long after a rotation ended a rotation the other way is a reversal
pub const REVERSAL_WINDOW: f64 = 0.5;

// How long a hold or roll survives with no foot on it (ITGmania with Simply
// Love's TimingWindowSecondsHold / TimingWindowSecondsRoll).
pub const HOLD_RELEASE_WINDOW: f64 = 0.32;
pub const ROLL_RELEASE_WINDOW: f64 = 0.35;
pub fn mine_forces_footswitch(data: &PlacementData, row: &Row, elapsed_time: f64) -> bool {
    if !data.left_jack && !data.right_jack {
        return false;
    }
    if elapsed_time >= MINE_FOOTSWITCH_MAX_GAP {
        return false;
    }
    row.mines.iter().any(|x| x.is_some()) || row.fake_mines.iter().any(|x| x.is_some())
}
