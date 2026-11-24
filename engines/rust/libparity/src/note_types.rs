use crate::parity_data_types::FootOverride;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NoteType {
    Tap,
    Mine,
    Lift,
    Fake,
    Hold,
    Roll,
}

impl NoteType {
    pub fn parse(s: &str) -> Option<NoteType> {
        Some(match s {
            "Tap" => NoteType::Tap,
            "Mine" => NoteType::Mine,
            "Lift" => NoteType::Lift,
            "Fake" => NoteType::Fake,
            "Hold" => NoteType::Hold,
            "Roll" => NoteType::Roll,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HoldOverride {
    pub beat: f64,
    pub foot: FootOverride,
}

#[derive(Clone, Debug, Default)]
pub struct NoteParity {
    pub override_: Option<FootOverride>,
    /// hold notes only: the foot covering the hold from each beat onward, sorted by beat
    pub hold_overrides: Option<Vec<HoldOverride>>,
}

#[derive(Clone, Debug)]
pub struct NotedataEntry {
    pub beat: f64,
    pub col: usize,
    pub second: f64,
    pub warped: bool,
    pub fake: bool,
    pub parity: Option<NoteParity>,
    pub note_type: NoteType,
    /// length in beats (holds and rolls)
    pub hold: f64,
}

/// sorted by beat, then column
pub type Notedata = [NotedataEntry];

pub fn is_hold_note(note: &NotedataEntry) -> bool {
    matches!(note.note_type, NoteType::Hold | NoteType::Roll)
}
