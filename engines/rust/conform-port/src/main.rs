// Port protocol (CONFORMANCE.md): cases as NDJSON on stdin, one result
// line per case on stdout, in completion order. `-j N` sets the worker count;
// `--counts` computes analyze_counts() instead of analyze(); `--describe`
// prints the public API description instead (describe.rs).

mod describe;
mod format;

use std::io::{BufRead, Write};
use std::sync::Mutex;

fn process(line: &str, counts: bool) -> String {
    let case: format::Case = match serde_json::from_str(line) {
        Ok(c) => c,
        Err(e) => {
            let id = serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|v| v.get("id").cloned())
                .unwrap_or(serde_json::Value::Null);
            return serde_json::json!({ "id": id, "error": e.to_string() }).to_string();
        }
    };
    let id = case.id.clone();
    let result = std::panic::catch_unwind(|| {
        if counts { format::compute_counts(&case) } else { format::compute_reference(&case) }
    });
    match result {
        Ok(Ok(v)) => v.to_string(),
        Ok(Err(e)) => serde_json::json!({ "id": id, "error": e }).to_string(),
        Err(_) => serde_json::json!({ "id": id, "error": "panic" }).to_string(),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut jobs = std::thread::available_parallelism().map_or(1, |n| n.get());
    let mut counts = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--describe" => {
                println!("{}", describe::describe());
                return;
            }
            "--counts" => counts = true,
            "-j" | "--jobs" => {
                jobs = args.get(i + 1).and_then(|s| s.parse().ok()).expect("-j takes a number");
                i += 1;
            }
            other => {
                eprintln!("unknown argument {other}; usage: libparity-port [-j N] [--counts] < cases.ndjson | libparity-port --describe");
                std::process::exit(2);
            }
        }
        i += 1;
    }

    let input = Mutex::new(std::io::BufReader::with_capacity(1 << 20, std::io::stdin()).lines());
    let output = Mutex::new(std::io::BufWriter::new(std::io::stdout()));
    let failed = Mutex::new(0usize);
    std::thread::scope(|scope| {
        for _ in 0..jobs.max(1) {
            scope.spawn(|| loop {
                let line = match input.lock().unwrap().next() {
                    Some(Ok(line)) => line,
                    Some(Err(e)) => panic!("reading stdin: {e}"),
                    None => break,
                };
                if line.is_empty() {
                    continue;
                }
                let out = process(&line, counts);
                if out.contains("\"error\":") {
                    eprintln!("{out}");
                    *failed.lock().unwrap() += 1;
                }
                let mut o = output.lock().unwrap();
                writeln!(o, "{out}").expect("writing stdout");
            });
        }
    });
    output.lock().unwrap().flush().expect("flushing stdout");
    if *failed.lock().unwrap() > 0 {
        std::process::exit(1);
    }
}
