// Mirrors engines/typescript/conformance/format.ts (computeReference).

use libparity::{
    analyze, analyze_counts, is_supported_steps_type, FootOverride, HoldOverride, NoteParity, NoteType, NotedataEntry, NONE,
    CodeInfo, FOOT_INFO, TECH_ERROR_INFO, TECH_INFO,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
pub struct CaseHoldOverride {
    pub beat: f64,
    pub foot: Value,
}

#[derive(Deserialize)]
pub struct CaseNote {
    pub beat: f64,
    pub col: usize,
    #[serde(rename = "type")]
    pub note_type: String,
    pub second: f64,
    pub hold: Option<f64>,
    pub warped: Option<bool>,
    pub fake: Option<bool>,
    #[serde(rename = "override")]
    pub override_: Option<Value>,
    #[serde(rename = "holdOverrides")]
    pub hold_overrides: Option<Vec<CaseHoldOverride>>,
}

#[derive(Deserialize)]
pub struct Case {
    pub id: String,
    #[serde(rename = "stepsType")]
    pub steps_type: String,
    pub notes: Vec<CaseNote>,
}


fn foot_override(v: &Value) -> Result<FootOverride, String> {
    match v {
        Value::String(s) if s == "Left" => Ok(FootOverride::Left),
        Value::String(s) if s == "Right" => Ok(FootOverride::Right),
        Value::Number(n) => match n.as_i64() {
            Some(f @ 0..=4) => Ok(FootOverride::Foot(f as i8)),
            _ => Err(format!("unsupported foot override {n}")),
        },
        _ => Err(format!("unsupported foot override {v}")),
    }
}

fn to_notedata(notes: &[CaseNote]) -> Result<Vec<NotedataEntry>, String> {
    notes
        .iter()
        .map(|n| {
            let parity = if n.override_.is_some() || n.hold_overrides.is_some() {
                Some(NoteParity {
                    override_: n.override_.as_ref().map(foot_override).transpose()?,
                    hold_overrides: n
                        .hold_overrides
                        .as_ref()
                        .map(|list| {
                            list.iter()
                                .map(|h| Ok(HoldOverride { beat: h.beat, foot: foot_override(&h.foot)? }))
                                .collect::<Result<Vec<_>, String>>()
                        })
                        .transpose()?,
                })
            } else {
                None
            };
            let note_type =
                NoteType::parse(&n.note_type).ok_or_else(|| format!("unknown note type {}", n.note_type))?;
            if n.col >= libparity::MAX_COLUMNS {
                return Err(format!("column {} out of range", n.col));
            }
            Ok(NotedataEntry {
                beat: n.beat,
                col: n.col,
                second: n.second,
                warped: n.warped.unwrap_or(false),
                fake: n.fake.unwrap_or(false),
                parity,
                note_type,
                hold: if matches!(note_type, NoteType::Hold | NoteType::Roll) { n.hold.unwrap_or(0.0) } else { 0.0 },
            })
        })
        .collect()
}

fn named_counts(counts: &[u32], names: &[CodeInfo]) -> Value {
    let mut out = Map::new();
    for (i, &count) in counts.iter().enumerate() {
        if count != 0 {
            out.insert(names[i].code.to_string(), json!(count));
        }
    }
    Value::Object(out)
}

/// analyze_counts() as a result with only id, noPath, counts and errorCounts
pub fn compute_counts(c: &Case) -> Result<Value, String> {
    if !is_supported_steps_type(&c.steps_type) {
        return Err(format!("Unsupported game type: {}", c.steps_type));
    }
    let notedata = to_notedata(&c.notes)?;
    let Some(counts) = analyze_counts(&c.steps_type, &notedata) else {
        return Ok(json!({ "id": c.id, "noPath": true, "counts": {}, "errorCounts": {} }));
    };
    Ok(json!({
        "id": c.id,
        "counts": named_counts(&counts.tech_counts, &TECH_INFO),
        "errorCounts": named_counts(&counts.tech_error_counts, &TECH_ERROR_INFO),
    }))
}

pub fn compute_reference(c: &Case) -> Result<Value, String> {
    if !is_supported_steps_type(&c.steps_type) {
        return Err(format!("Unsupported game type: {}", c.steps_type));
    }
    let notedata = to_notedata(&c.notes)?;
    let Some(a) = analyze(&c.steps_type, &notedata) else {
        return Ok(json!({
            "id": c.id,
            "noPath": true,
            "feet": "",
            "rowCount": 0,
            "rows": [],
            "mineRows": [],
            "holdOwnership": [],
            "candles": [],
            "stance": "",
            "angleChecksum": 0,
            "counts": {},
            "errorCounts": {},
        }));
    };

    let feet: String = a.feet.iter().map(|&f| FOOT_INFO[f as usize].code).collect();

    let rows: Vec<Value> = a
        .rows
        .iter()
        .filter(|r| r.techs.0 != 0 || r.errors.0 != 0)
        .map(|r| {
            let techs: Vec<&str> = r.techs.values().map(|t| TECH_INFO[t as usize].code).collect();
            let errors: Vec<&str> = r.errors.values().map(|e| TECH_ERROR_INFO[e as usize].code).collect();
            json!([r.beat, techs, errors])
        })
        .collect();

    let mine_rows: Vec<Value> = a
        .mine_rows
        .iter()
        .map(|m| {
            let techs: Vec<&str> = m.techs.values().map(|t| TECH_INFO[t as usize].code).collect();
            json!([m.beat, techs])
        })
        .collect();

    let hold_ownership: Vec<Value> = a
        .hold_ownership
        .iter()
        .map(|h| {
            let t: Vec<Value> =
                h.timeline.iter().map(|t| json!([t.beat, FOOT_INFO[t.foot as usize].code])).collect();
            json!([h.note, t])
        })
        .collect();

    let candles: Vec<Value> = a
        .rows
        .iter()
        .filter(|r| r.candle != NONE)
        .map(|r| json!([r.beat, FOOT_INFO[r.candle as usize].code]))
        .collect();

    let mut stance = String::with_capacity(a.rows.len() * 4);
    for r in &a.rows {
        for &col in &r.foot_columns[1..5] {
            stance.push(if col < 0 { '.' } else { char::from_digit(col as u32, 36).unwrap() });
        }
    }
    let mut angle_checksum = 0.0;
    for (i, r) in a.rows.iter().enumerate() {
        angle_checksum += (i + 1) as f64 * r.angle;
    }

    Ok(json!({
        "id": c.id,
        "feet": feet,
        "rowCount": a.rows.len(),
        "rows": rows,
        "mineRows": mine_rows,
        "holdOwnership": hold_ownership,
        "candles": candles,
        "stance": stance,
        "angleChecksum": angle_checksum,
        "counts": named_counts(&a.tech_counts, &TECH_INFO),
        "errorCounts": named_counts(&a.tech_error_counts, &TECH_ERROR_INFO),
    }))
}
