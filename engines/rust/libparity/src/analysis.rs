//! Analysis.ts

use crate::js::{math_max, to_fixed};
use crate::note_types::{is_hold_note, NotedataEntry};
use crate::parity_data_types::{BitSet, Foot, NONE, TECH_CATEGORY_COUNT, TECH_ERROR_COUNT};
use crate::parity_internals::ParityInternals;
use crate::parity_result_types::{HoldOwner, ParityComputeData, RollTapEvent};
use crate::stage_layouts::{self, StageLayout};

/// Bumped whenever the engine's output on the conformance corpus changes.
/// Every port declares the same value; consumers store it next to derived data.
pub const ENGINE_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq)]
pub struct AnalysisRow {
    pub beat: f64,
    pub second: f64,
    pub techs: BitSet,
    pub errors: BitSet,
    /// `NONE` unless the row is a candle
    pub candle: Foot,
    /// indexed by `Foot`: the column each part is planted on after this row, -1 when lifted; `[NONE]` is -1
    pub foot_columns: [i8; 5],
    /// atan2(-dy, dx) of left foot -> right foot in stage coordinates; 0 on the first row
    pub angle: f64,
}

/// a beat with only mines that carries techs
#[derive(Clone, Debug, PartialEq)]
pub struct AnalysisMineRow {
    pub beat: f64,
    pub second: f64,
    pub techs: BitSet,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnalysisHoldOwnership {
    /// index into the input notes
    pub note: usize,
    pub timeline: Vec<HoldOwner>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParityAnalysis {
    /// one per input note, in input order; `NONE` for mines, fakes and unassigned notes
    pub feet: Vec<Foot>,
    /// one per input note: index into `rows`, `None` when the note has no foot
    pub note_rows: Vec<Option<usize>>,
    pub rows: Vec<AnalysisRow>,
    /// mine-only beats that carry techs (MD), by beat; not part of `rows` or `note_rows`
    pub mine_rows: Vec<AnalysisMineRow>,
    /// where a roll is taken as re-tapped between rows (by the foot taking it
    /// over, or the foot staying on it in a stream gap), by beat
    pub roll_taps: Vec<RollTapEvent>,
    pub hold_ownership: Vec<AnalysisHoldOwnership>,
    /// indexed by `TechCategory`
    pub tech_counts: [u32; TECH_CATEGORY_COUNT],
    /// indexed by `TechErrors`
    pub tech_error_counts: [u32; TECH_ERROR_COUNT],
}

/// dance-double has a stage layout but is untested, so it is not supported
pub const SUPPORTED_STEPS_TYPES: [&str; 1] = ["dance-single"];

pub fn is_supported_steps_type(steps_type: &str) -> bool {
    SUPPORTED_STEPS_TYPES.contains(&steps_type)
}

/// Panel geometry of a supported steps type.
pub fn stage_layout(steps_type: &str) -> Option<StageLayout> {
    if is_supported_steps_type(steps_type) { stage_layouts::stage_layout(steps_type) } else { None }
}

/// Whole-chart analysis; `None` when the steps type is unsupported or no foot
/// path exists. `notes` are sorted by beat, then column.
pub fn analyze(steps_type: &str, notes: &[NotedataEntry]) -> Option<ParityAnalysis> {
    if !is_supported_steps_type(steps_type) {
        return None;
    }
    let mut internals = ParityInternals::new(steps_type).ok()?;
    let (start, end) = analysis_range(notes);
    let data = internals.compute_batch(start, end, notes)?;
    Some(to_analysis(notes, &data))
}

#[derive(Clone, Debug, PartialEq)]
pub struct TechCounts {
    /// indexed by `TechCategory`
    pub tech_counts: [u32; TECH_CATEGORY_COUNT],
    /// indexed by `TechErrors`
    pub tech_error_counts: [u32; TECH_ERROR_COUNT],
}

/// `analyze`'s tech_counts and tech_error_counts alone, in memory bounded by
/// the search window instead of chart length; `None` as for `analyze`.
pub fn analyze_counts(steps_type: &str, notes: &[NotedataEntry]) -> Option<TechCounts> {
    if !is_supported_steps_type(steps_type) {
        return None;
    }
    let mut internals = ParityInternals::new(steps_type).ok()?;
    let (start, end) = analysis_range(notes);
    let (tech_counts, tech_error_counts) = internals.compute_batch_counts(start, end, notes)?;
    Some(TechCounts { tech_counts, tech_error_counts })
}

/// The beat range `analyze` computes.
pub fn analysis_range(notes: &[NotedataEntry]) -> (f64, f64) {
    let last_beat =
        notes.iter().fold(0.0, |m, n| math_max(m, n.beat + if is_hold_note(n) { n.hold } else { 0.0 }));
    (-1.0, last_beat + 4.0)
}

pub fn to_analysis(notes: &[NotedataEntry], data: &ParityComputeData) -> ParityAnalysis {
    let mut feet = Vec::with_capacity(notes.len());
    let mut note_rows = Vec::with_capacity(notes.len());
    let mut hold_ownership = Vec::new();
    for (i, n) in notes.iter().enumerate() {
        let key = format!("{}-{}", to_fixed(n.beat, 3), n.col);
        let foot = data.parity_labels.get(&key).copied().unwrap_or(NONE);
        feet.push(foot);
        note_rows.push(if foot == NONE { None } else { data.label_rows.get(&key).copied() });
        if let Some(timeline) = data.hold_ownership.get(&key) {
            hold_ownership.push(AnalysisHoldOwnership { note: i, timeline: timeline.clone() });
        }
    }
    let rows = data
        .row_timestamps
        .iter()
        .enumerate()
        .map(|(i, t)| AnalysisRow {
            beat: t.beat,
            second: t.second,
            techs: data.tech_rows.get(i).copied().flatten().unwrap_or(BitSet(0)),
            errors: data.tech_errors.get(&i).copied().unwrap_or(BitSet(0)),
            candle: data.candles.get(&i).copied().unwrap_or(NONE),
            // states has the start node in front of the rows
            foot_columns: {
                let mut c = data.states[i + 1].foot_columns;
                c[0] = -1;
                c
            },
            angle: data.facing_rows.get(i).copied().unwrap_or(0.0),
        })
        .collect();
    let mine_rows =
        data.mine_rows.iter().map(|m| AnalysisMineRow { beat: m.beat, second: m.second, techs: m.techs }).collect();
    ParityAnalysis {
        feet,
        note_rows,
        rows,
        mine_rows,
        roll_taps: data.roll_taps.clone(),
        hold_ownership,
        tech_counts: data.tech_counts,
        tech_error_counts: data.tech_error_counts,
    }
}
