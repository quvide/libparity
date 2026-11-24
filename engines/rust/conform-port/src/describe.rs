// Mirrors engines/typescript/conformance/describe.ts: the public API's constants and
// edge cases as JSON, compared with the reference by `conformance check-api`.

use libparity::{
    analyze, analyze_counts, foot_from_code, is_supported_steps_type, stage_layout, tech_error_from_code, tech_from_code, CodeInfo,
    ENGINE_VERSION, FOOT_INFO, SUPPORTED_STEPS_TYPES, TECH_ERROR_INFO, TECH_INFO,
};
use serde_json::{json, Map, Value};

const STEPS_TYPE_PROBES: [&str; 4] = ["dance-single", "dance-double", "pump-single", ""];
const EXTRA_CODE_PROBES: [&str; 2] = ["??", ""];

fn table(t: &[CodeInfo]) -> Value {
    t.iter().map(|i| json!([i.code, i.name, i.description])).collect()
}

fn lookups<T: Into<Value>>(t: &[CodeInfo], lookup: impl Fn(&str) -> Option<T>) -> Value {
    let mut out = Map::new();
    for code in t.iter().map(|i| i.code).chain(EXTRA_CODE_PROBES) {
        out.insert(code.to_string(), lookup(code).map_or(Value::Null, Into::into));
    }
    Value::Object(out)
}

pub fn describe() -> Value {
    let mut layouts = Map::new();
    for steps_type in STEPS_TYPE_PROBES {
        let layout = stage_layout(steps_type).map_or(Value::Null, |l| {
            json!({
                "name": l.name,
                "columnCount": l.column_count,
                "layout": l.layout.iter().map(|p| json!([p.x, p.y, p.rotation])).collect::<Vec<_>>(),
                "upArrows": l.up_arrows,
                "downArrows": l.down_arrows,
                "leftArrows": l.left_arrows,
                "rightArrows": l.right_arrows,
                "sideArrows": l.side_arrows,
            })
        });
        layouts.insert(steps_type.to_string(), layout);
    }
    let empty = analyze("dance-single", &[]).map_or(Value::Null, |a| {
        json!({
            "feet": a.feet.len(),
            "rows": a.rows.len(),
            "techCounts": a.tech_counts,
            "techErrorCounts": a.tech_error_counts,
        })
    });
    json!({
        "engineVersion": ENGINE_VERSION,
        "supportedStepsTypes": SUPPORTED_STEPS_TYPES,
        "isSupported": STEPS_TYPE_PROBES.iter().map(|s| (s.to_string(), json!(is_supported_steps_type(s)))).collect::<Map<_, _>>(),
        "footInfo": table(&FOOT_INFO),
        "techInfo": table(&TECH_INFO),
        "techErrorInfo": table(&TECH_ERROR_INFO),
        "footFromCode": lookups(&FOOT_INFO, foot_from_code),
        "techFromCode": lookups(&TECH_INFO, tech_from_code),
        "techErrorFromCode": lookups(&TECH_ERROR_INFO, tech_error_from_code),
        "stageLayouts": layouts,
        "analyzeUnsupported": analyze("dance-double", &[]).is_none(),
        "analyzeEmpty": empty,
        "analyzeCountsUnsupported": analyze_counts("dance-double", &[]).is_none(),
        "analyzeCountsEmpty": analyze_counts("dance-single", &[]).map_or(Value::Null, |c| {
            json!({ "techCounts": c.tech_counts, "techErrorCounts": c.tech_error_counts })
        }),
    })
}
