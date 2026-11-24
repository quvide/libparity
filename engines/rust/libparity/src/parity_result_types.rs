use crate::parity_data_types::{BitSet, Foot, ParityState, TECH_CATEGORY_COUNT, TECH_ERROR_COUNT};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HoldOwner {
    pub beat: f64,
    pub foot: Foot,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RowTimestamp {
    pub beat: f64,
    pub second: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MineRowStats {
    pub beat: f64,
    pub second: f64,
    pub techs: BitSet,
}

/// where the engine takes a roll as re-tapped between rows, and by which foot
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RollTapEvent {
    pub beat: f64,
    pub second: f64,
    pub col: usize,
    pub foot: Foot,
}

#[derive(Clone, Debug)]
pub struct ParityComputeData {
    /// keyed `beat.toFixed(3) + "-" + col`
    pub parity_labels: HashMap<String, Foot>,
    /// row index of each `parity_labels` entry
    pub label_rows: HashMap<String, usize>,
    /// hold-body ownership timelines keyed by head note "beat-col"; only
    /// present for holds whose covering foot changes mid-hold
    pub hold_ownership: HashMap<String, Vec<HoldOwner>>,
    pub states: Vec<ParityState>,
    pub row_timestamps: Vec<RowTimestamp>,
    pub tech_rows: Vec<Option<BitSet>>,
    /// mine-only beats that carry techs, by beat
    pub mine_rows: Vec<MineRowStats>,
    /// by beat
    pub roll_taps: Vec<RollTapEvent>,
    pub tech_errors: BTreeMap<usize, BitSet>,
    /// `techCounts[tech] || 0`
    pub tech_counts: [u32; TECH_CATEGORY_COUNT],
    pub tech_error_counts: [u32; TECH_ERROR_COUNT],
    pub facing_rows: Vec<f64>,
    pub candles: BTreeMap<usize, Foot>,
}
