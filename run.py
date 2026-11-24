#!/usr/bin/env python3
"""libparity task runner: fixtures, corpus and port checks.

Python 3.9+ (keep in sync with cmd_deps), standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import BinaryIO, Callable, Optional, Sequence

ROOT = Path(__file__).resolve().parent
LOGS = ROOT / ".logs"
TS = ROOT / "engines" / "typescript"
PORTS = ROOT / "engines"
PARITY_CLI = TS / "tests" / "cli.ts"
REFERENCE = str(ROOT / "corpus" / "reference.ndjson.gz")
CONFORM_CLI = TS / "conformance" / "cli.ts"

EPILOG = """\
After an engine change, run `test`: it runs every step, prints one line per
step and exits non-zero if any failed.

Commands use the host's toolchains. container/run.py runs them in a container
(podman, else docker) that has every dependency: container/run.py test.

Each run is logged, without colours, to .logs/<step>.log (typecheck, fixtures,
check-rust, ...), ending with "exit N" when the run is over."""

ANSI = re.compile(rb"\x1b\[[0-9;]*[A-Za-z]")
TTY_PROGRESS = b"\x1b[2K\x1b[2m"  # how engines/typescript/tests/progress.ts starts a redrawn line, after its \r


class UsageError(Exception):
    pass


def available_ports() -> list[str]:
    return sorted(d.name for d in PORTS.iterdir() if (d / "run").is_file() and os.access(d / "run", os.X_OK))


def progress_mode(stream: BinaryIO) -> str:
    """PARITY_PROGRESS for a command whose output reaches `stream`: tty for a terminal, lines for an
    agent (AI_AGENT or CLAUDECODE set; its output is a file, so redirects can't be told apart), else off."""
    if stream.isatty():
        return "tty"
    return "lines" if os.environ.get("AI_AGENT") or os.environ.get("CLAUDECODE") else "off"


def tee(cmd: Sequence[str], log: Path, out: Optional[BinaryIO], mode: str,
        on_progress: Optional[Callable[[str], None]] = None, columns: Optional[int] = None) -> int:
    """Runs cmd with PARITY_PROGRESS=mode, copying its combined output to `out` as is and appending it
    to `log` as plain text without progress: a tty-mode line is redrawn after \r, so the log keeps
    what is left after the last \r, and lines-mode "progress: " lines are dropped. on_progress gets
    each progress text as it changes ("" once a tty-mode line is erased)."""
    env = {**os.environ, "PARITY_PROGRESS": mode}
    if mode == "tty":
        env["COLUMNS"] = str(columns or shutil.get_terminal_size().columns)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    assert proc.stdout is not None

    def plain(line: bytes) -> bytes:
        return ANSI.sub(b"", line.removesuffix(b"\r").rsplit(b"\r", 1)[-1])

    with log.open("ab", buffering=0) as f:
        pending = b""
        shown = ""
        try:
            while chunk := os.read(proc.stdout.fileno(), 65536):
                if out:
                    out.write(chunk)
                    out.flush()
                *lines, pending = (pending + chunk).split(b"\n")
                for line in map(plain, lines):
                    if line.startswith(b"progress: "):
                        if on_progress:
                            on_progress(line.decode(errors="replace"))
                    else:
                        f.write(line + b"\n")
                if on_progress and mode == "tty":
                    last = pending.rsplit(b"\r", 1)[-1] if b"\r" in pending else b""
                    text = ANSI.sub(b"", last).decode(errors="replace") if last.startswith(TTY_PROGRESS) else ""
                    if text != shown:
                        shown = text
                        on_progress(text)
            if pending_text := plain(pending):
                f.write(pending_text + b"\n")
            return proc.wait()
        except KeyboardInterrupt:
            proc.send_signal(signal.SIGINT)
            proc.wait()
            f.write(b"\ninterrupted\n")
            raise


TOOLS_PATH = f"{TS / 'node_modules' / '.bin'}{os.pathsep}{os.environ.get('PATH', '')}"

NPM_CI = "cd engines/typescript && npm ci"


def cpp_build_tool() -> str:
    return "ninja" if "ninja" in os.environ.get("CMAKE_GENERATOR", "").lower() else "make"


# Tools for native runs: (name, command, required version, what needs it, how to get it). A command
# given as a list prints the version itself, run from engines/typescript/; a name gets --version. The
# required version is a minimum, or LOCKED: exactly the version package-lock.json pins.
# A port without an entry here needs only what its engines/<name>/README.md says.
Command = "str | list[str]"
LOCKED = "locked"


def locked_version(package: str) -> Optional[str]:
    try:
        lock = json.loads((TS / "package-lock.json").read_text())
        return lock["packages"][f"node_modules/{package}"]["version"]
    except (OSError, ValueError, KeyError):
        return None


def dependencies() -> list[tuple[str, Command, "tuple[int, ...] | str | None", str, str]]:
    ts = [
        # import.meta.dirname in engines/typescript/conformance/cli.ts; keep in sync with the comment there
        ("node", "node", (20, 11), "TypeScript engine and tools", "https://nodejs.org"),
        # engines/typescript/package-lock.json lockfileVersion 3
        ("npm", "npm", (7,), "installing engines/typescript/node_modules", "comes with node"),
        ("tsx", "tsx", LOCKED, "TypeScript engine and tools", NPM_CI),
        ("typescript", "tsc", LOCKED, "typecheck", NPM_CI),
        # the platform binary tsx loads, not node_modules/.bin/esbuild (the installing host's binary)
        ("esbuild", ["node", "-p", "require('esbuild').transformSync('').code + require('esbuild').version"],
         LOCKED, "tsx (its platform binary)", NPM_CI),
    ]
    ports = {
        # engines/rust/Cargo.lock version 4; the code needs >= 1.65 (let-else). Keep in sync with the
        # comments at `edition` in the engines/rust crates.
        "rust": [("cargo", "cargo", (1, 78), "rust port", "https://rustup.rs"),
                 ("rustc", "rustc", (1, 78), "rust port", "https://rustup.rs")],
        # keep cmake's minimum and C++17 in sync with engines/cpp/CMakeLists.txt
        "cpp": [("cmake", "cmake", (3, 14), "cpp port", "a package manager"),
                # C++17 support differs by vendor; cmake's cxx_std_17 check rejects older compilers
                ("c++", os.environ.get("CXX", "c++"), None, "cpp port (a C++17 compiler)", "a package manager"),
                (cpp_build_tool(), cpp_build_tool(), None, "cpp port (cmake's build tool)", "a package manager")],
    }
    return ts + [dep for port in available_ports() for dep in ports.get(port, [])]


def tool_version(command: Command) -> Optional[str]:
    """The first version number the command prints, "" when it prints none, None when it doesn't run."""
    args = command if isinstance(command, list) else [command, "--version"]
    path = shutil.which(args[0], path=TOOLS_PATH)
    if path is None:
        return None
    try:
        out = subprocess.run([path, *args[1:]], capture_output=True, text=True, timeout=30, cwd=TS)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    match = re.search(r"\d+(?:\.\d+)+", out.stdout + out.stderr)
    return match.group(0) if match else ""


def missing_tools() -> list[str]:
    """Dependencies not on PATH, without running them (for --help)."""
    return [name for name, cmd, *_ in dependencies()
            if shutil.which(cmd[0] if isinstance(cmd, list) else cmd, path=TOOLS_PATH) is None]


def command(args: Sequence[str]) -> list[str]:
    return ["env", f"PATH={TOOLS_PATH}", *args]


STEP_WIDTH = 14


def run(name: str, args: Sequence[str], quiet: bool = False) -> int:
    """Runs args, logged to .logs/<name>.log. quiet keeps the output out of the terminal except for
    progress, shown after the step name on a terminal and as "progress: " lines for an agent."""
    log = LOGS / f"{name}.log"
    log.write_text(f"$ {shlex.join(args)}\n\n")
    mode = progress_mode(sys.stdout)
    on_progress = None
    columns = None
    if quiet and mode == "tty":
        columns = shutil.get_terminal_size().columns - STEP_WIDTH - 1

        def on_progress(text: str) -> None:
            # drop the command's own task name: the step name stands in for it
            status = text.split("  ", 1)[-1] if text else "..."
            print(f"\r\x1b[2K{name:<{STEP_WIDTH}} {status}", end="", flush=True)
    elif quiet and mode == "lines":
        def on_progress(text: str) -> None:
            print(text, flush=True)
    try:
        rc = tee(command(args), log, None if quiet else sys.stdout.buffer, mode, on_progress, columns)
    except KeyboardInterrupt:
        raise SystemExit(130)
    with log.open("a") as f:
        f.write(f"\nexit {rc}\n")
    return rc


def summary(name: str) -> str:
    """The suite's own count line (its last line), else the first line of output, usually the first error."""
    lines = [line.strip() for line in (LOGS / f"{name}.log").read_text().splitlines()[2:-1] if line.strip()]
    if not lines:
        return ""
    return lines[-1] if re.match(r"\d+/\d+ ", lines[-1]) else lines[0]


# Steps shared by `test` and the single commands: (log name, command).


def typecheck_step() -> tuple[str, list[str]]:
    script = f"cd {shlex.quote(str(TS))} && tsc -p tsconfig.json && tsc -p tests/tsconfig.json"
    return "typecheck", ["sh", "-c", script]


def fixtures_step(args: Sequence[str] = ()) -> tuple[str, list[str]]:
    return "fixtures", ["tsx", str(PARITY_CLI), *args]


def check_step(port: str, jobs: str | None, conform_args: Sequence[str] = ()) -> tuple[str, list[str]]:
    port_args = ["-j", jobs] if jobs else []
    # per-port output, so ports can be checked in parallel
    out = [] if "--out" in conform_args else ["--out", str(ROOT / "corpus" / f"{port}.ndjson.gz")]
    return f"check-{port}", ["tsx", str(CONFORM_CLI), "check", *out, *conform_args, "--", str(PORTS / port / "run"), *port_args]


def counts_step(port: str, jobs: str | None) -> tuple[str, list[str]]:
    """analyzeCounts over the corpus, compared with the reference's counts; port "ts" is the reference engine."""
    port_args = ["-j", jobs] if jobs else []
    if port == "ts":
        out = str(ROOT / "corpus" / "ts-counts.ndjson.gz")
        cli = shlex.quote(str(CONFORM_CLI))
        script = (f"tsx {cli} reference --counts {shlex.join(port_args)} --out {shlex.quote(out)} && "
                  f"tsx {cli} diff --counts {shlex.quote(REFERENCE)} {shlex.quote(out)}")
        return "counts-ts", ["sh", "-c", script]
    out = str(ROOT / "corpus" / f"{port}-counts.ndjson.gz")
    return f"counts-{port}", ["tsx", str(CONFORM_CLI), "check", "--counts", "--out", out, "--", str(PORTS / port / "run"), *port_args]


def api_step(port: str) -> tuple[str, list[str]]:
    return f"api-{port}", ["tsx", str(CONFORM_CLI), "check-api", "--", str(PORTS / port / "run")]


def ports_arg(names: Sequence[str]) -> list[str]:
    if not names or list(names) == ["all"]:
        return available_ports()
    unknown = sorted(set(names) - set(available_ports()))
    if unknown:
        raise UsageError(f"unknown port {', '.join(unknown)}; ports: {', '.join(available_ports())}")
    return list(names)


# Commands. Each takes the parsed arguments and the arguments it passes through.


def cmd_test(ns: argparse.Namespace, rest: list[str]) -> int:
    ports = ports_arg(ns.ports)
    steps = [typecheck_step(), fixtures_step(), counts_step("ts", ns.jobs), *(api_step(p) for p in ports),
             *(check_step(p, ns.jobs) for p in ports), *(counts_step(p, ns.jobs) for p in ports)]
    failed = 0
    tty = sys.stdout.isatty()
    for name, args in steps:
        if tty:
            print(f"{name:<{STEP_WIDTH}} ...", end="", flush=True)
        rc = run(name, args, quiet=True)
        failed += rc != 0
        detail = summary(name)
        status = "ok" if rc == 0 else f"FAIL (exit {rc}, .logs/{name}.log)"
        print(f"{chr(13) + chr(27) + '[2K' if tty else ''}{name:<{STEP_WIDTH}} {status}{'  ' + detail if detail else ''}", flush=True)
    return 1 if failed else 0


def cmd_deps(ns: argparse.Namespace, rest: list[str]) -> int:
    rows = [("tool", "version", "required", "status", "needed for")]
    hints: dict[str, list[str]] = {}
    python = ".".join(map(str, sys.version_info[:3]))
    # keep in sync with the docstrings of run.py and container/run.py
    rows.append(("python3", python, ">= 3.9", "ok" if sys.version_info >= (3, 9) else "too old", "run.py"))
    node_missing = tool_version("node") is None
    for name, cmd, required_version, purpose, hint in dependencies():
        version = tool_version(cmd)
        node_tool = cmd[0] == "node" if isinstance(cmd, list) else (TS / "node_modules" / ".bin" / cmd).exists()
        if version is None and node_missing and node_tool:
            version, status = "", "needs node"
        elif version is None:
            status = "missing"
        elif required_version == LOCKED:
            status = "ok" if version == locked_version(name) else "not locked"
        elif required_version and version and tuple(int(p) for p in version.split(".")) < required_version:
            status = "too old"
        else:
            status = "ok"
        if status in ("missing", "too old", "not locked"):
            hints.setdefault(hint, []).append(name)
        if required_version == LOCKED:
            required = f"= {locked_version(name) or '?'}"
        else:
            required = f">= {'.'.join(map(str, required_version))}" if required_version else ""
        rows.append((name, version or "-", required, status, purpose))
    color = sys.stdout.isatty() and "NO_COLOR" not in os.environ

    def paint(text: str, code: str) -> str:
        return f"\x1b[{code}m{text}\x1b[0m" if color else text

    status_color = {"ok": "32", "missing": "31", "too old": "33", "needs node": "33", "not locked": "33"}
    widths = [max(len(row[i]) for row in rows) for i in range(4)]
    for i, row in enumerate(rows):
        cells = [cell.ljust(w) for cell, w in zip(row, widths)] + [row[4]]
        if i == 0:
            print(paint("  ".join(cells), "2"))
        else:
            cells[3] = paint(cells[3], status_color[row[3]])
            cells[4] = paint(cells[4], "2")
            print("  ".join(cells))
    for hint, names in hints.items():
        print(f"{', '.join(names)}: {paint(hint, '36')}")
    if hints:
        print(f"or run everything in a container: {paint('container/run.py', '36')}")
    return 0 if all(row[3] == "ok" for row in rows[1:]) else 1


def cmd_typecheck(ns: argparse.Namespace, rest: list[str]) -> int:
    return run(*typecheck_step())


def cmd_fixtures(ns: argparse.Namespace, rest: list[str]) -> int:
    return run(*fixtures_step(rest))


def cmd_check(ns: argparse.Namespace, rest: list[str]) -> int:
    ports = ports_arg([ns.port])
    rc = 0
    for port in ports:
        if len(ports) > 1:
            print(f"== {port}", flush=True)
        rc = run(*api_step(port)) or rc
        rc = run(*check_step(port, ns.jobs, rest)) or rc
    return rc


def cmd_corpus_extract(ns: argparse.Namespace, rest: list[str]) -> int:
    return run("corpus-extract", ["tsx", str(CONFORM_CLI), "extract", *ns.dirs, *rest])


def cmd_corpus_reference(ns: argparse.Namespace, rest: list[str]) -> int:
    return run("corpus-reference", ["tsx", str(CONFORM_CLI), "reference", *rest])


def cmd_corpus_sample(ns: argparse.Namespace, rest: list[str]) -> int:
    out = str(ROOT / "corpus" / "sample.ndjson.gz")
    sample = ["--sample", str(ns.size)]
    jobs = ["-j", ns.jobs] if ns.jobs else []
    rc = run("corpus-sample", ["tsx", str(CONFORM_CLI), "reference", *sample, *jobs, "--out", out, *rest])
    if rc:
        return rc
    return run("corpus-sample-diff", ["tsx", str(CONFORM_CLI), "diff", *sample, REFERENCE, out])


def cmd_corpus_diff(ns: argparse.Namespace, rest: list[str]) -> int:
    return run("corpus-diff", ["tsx", str(CONFORM_CLI), "diff", ns.expected, ns.actual, *rest])


def cmd_shell(ns: argparse.Namespace, rest: list[str]) -> int:
    rest = rest[1:] if rest[:1] == ["--"] else rest
    return subprocess.run(command(rest or [os.environ.get("SHELL", "bash")])).returncode


def build_parser() -> argparse.ArgumentParser:
    missing = missing_tools()
    status = (f"Missing for native runs: {', '.join(missing)}. See ./run.py deps." if missing
              else "All tools for native runs found; ./run.py deps prints their versions.")
    parser = argparse.ArgumentParser(
        prog="run.py", description=__doc__.splitlines()[0], epilog=f"{EPILOG}\n\n{status}",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    commands = parser.add_subparsers(dest="command", metavar="<command>", required=True)
    ports = ", ".join(available_ports())

    def command(parent, name: str, func, help: str, passthrough: bool = False, extra_args: bool = False,
                **kwargs) -> argparse.ArgumentParser:
        """passthrough: every argument goes to the tool, --help included. extra_args: unknown options do."""
        sub = parent.add_parser(name, help=help, description=help, add_help=not passthrough,
                                formatter_class=argparse.RawDescriptionHelpFormatter, **kwargs)
        sub.set_defaults(func=func, extra_args=extra_args or passthrough)
        return sub

    test = command(commands, "test", cmd_test, "typecheck, fixtures and every port check, one line each")
    test.add_argument("ports", nargs="*", metavar="port", help=f"ports to check (default all: {ports})")
    test.add_argument("-j", "--jobs", help="worker count for the ports")

    command(commands, "deps", cmd_deps, "check the tools native runs need and print their versions")
    command(commands, "typecheck", cmd_typecheck, "type-check the TypeScript engine and tools")
    command(commands, "fixtures", cmd_fixtures, "run the fixture suite (options: fixtures --help)", passthrough=True)

    check = command(commands, "check", cmd_check, "run a port over the corpus and diff it against the reference",
                    extra_args=True, epilog="Other options (--in, --ref, --out, --limit) go to the conformance check.")
    check.add_argument("port", metavar="port", help=f"{ports} or all")
    check.add_argument("-j", "--jobs", help="worker count for the port")

    corpus = commands.add_parser("corpus", help="build the corpus and its reference, compare result files")
    corpus_commands = corpus.add_subparsers(dest="corpus_command", metavar="<command>", required=True)
    extract = command(corpus_commands, "extract", cmd_corpus_extract,
                      "build corpus/inputs.ndjson.gz from song folders", extra_args=True)
    extract.add_argument("dirs", nargs="+", metavar="songs_dir")
    command(corpus_commands, "reference", cmd_corpus_reference,
            "compute corpus/reference.ndjson.gz with computeBatch() (--incremental: compute(), --out FILE)",
            extra_args=True)
    sample = command(corpus_commands, "sample", cmd_corpus_sample,
                     "run the TS engine over a fixed sample of the corpus and diff it against the reference",
                     extra_args=True, epilog="Other options (--in, --heap, --incremental) go to the reference run. "
                     "Ports take --sample N on check.")
    sample.add_argument("-n", "--size", type=int, default=300, help="sample size (default 300)")
    sample.add_argument("-j", "--jobs", help="worker count")
    diff = command(corpus_commands, "diff", cmd_corpus_diff, "compare two result files (--in FILE, --limit N)",
                   extra_args=True)
    diff.add_argument("expected")
    diff.add_argument("actual")

    command(commands, "shell", cmd_shell, "run a command, or a shell without one, with the TypeScript tools on PATH",
            passthrough=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    ns, rest = parser.parse_known_args(sys.argv[1:] if argv is None else argv)
    if rest and not ns.extra_args:
        parser.error(f"unrecognized arguments: {' '.join(rest)}")
    if ns.func is not cmd_deps and shutil.which("tsx", path=TOOLS_PATH) is None:
        parser.exit(2, f"TypeScript dependencies missing; run: ({NPM_CI}), or use container/run.py; see ./run.py deps\n")
    LOGS.mkdir(exist_ok=True)
    try:
        return ns.func(ns, rest)
    except UsageError as e:
        parser.exit(2, f"{parser.prog}: {e}\n")


if __name__ == "__main__":
    sys.exit(main())
