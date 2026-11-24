#!/usr/bin/env python3
"""Runs ../run.py in a container (podman, else docker) that has every dependency.

Usage: container/run.py <run.py arguments>, or container/run.py shell for a shell.
The repository, the working directory and the existing paths named in the
arguments are mounted at their host paths. Python 3.9+ (keep in sync with
cmd_deps in ../run.py), standard library only.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path
from typing import Sequence

ROOT = Path(__file__).resolve().parent.parent
TS = ROOT / "engines" / "typescript"
IMAGE_INPUTS = (ROOT / "container" / "Containerfile", TS / "package.json", TS / "package-lock.json")


def ensure_image(engine: str) -> str:
    digest = 0
    for path in IMAGE_INPUTS:
        digest = zlib.crc32(path.read_bytes(), digest)
    image = f"libparity-dev:{digest:08x}"
    if subprocess.run([engine, "image", "inspect", image], capture_output=True).returncode == 0:
        return image
    log = ROOT / ".logs" / "image-build.log"
    log.parent.mkdir(exist_ok=True)
    print(f"building {image}, log in .logs/image-build.log", file=sys.stderr)
    with tempfile.TemporaryDirectory() as ctx, log.open("wb") as out:
        for path in IMAGE_INPUTS:
            shutil.copy(path, ctx)
        rc = subprocess.run([engine, "build", "-t", image, "-f", f"{ctx}/Containerfile", ctx],
                            stdout=out, stderr=subprocess.STDOUT).returncode
    if rc:
        sys.stderr.write("".join(log.read_text(errors="replace").splitlines(keepends=True)[-20:]))
        raise SystemExit(rc)
    return image


def mounts(args: Sequence[str]) -> list[str]:
    """The repository, the working directory and the existing paths named in args, as -v options."""
    cwd = Path.cwd()
    mounted = [ROOT]

    def add(directory: Path) -> None:
        if not any(directory == m or m in directory.parents for m in mounted):
            mounted.append(directory)

    add(cwd)
    for arg in args:
        value = arg.partition("=")[2] if arg.startswith("--") and "=" in arg else arg
        if "/" not in value:
            continue
        path = (cwd / Path(value).expanduser()).resolve()
        if path.is_dir():
            add(path)
        elif path.parent.is_dir():
            add(path.parent)
    return [opt for d in mounted for opt in ("-v", f"{d}:{d}")]


def main(args: Sequence[str]) -> int:
    engine = shutil.which("podman") or shutil.which("docker")
    if engine is None:
        sys.exit("container/run.py: podman or docker is required (or run ./run.py natively)")
    podman = "podman" in subprocess.run([engine, "--version"], capture_output=True, text=True).stdout.lower()
    image = ensure_image(engine)
    # The tmpfs hides host node_modules; the image's are on PATH.
    cmd = [engine, "run", "--rm", "-i", "--init", *mounts(args), "-w", str(Path.cwd()),
           "-v", "libparity-cache:/cache", "--mount", f"type=tmpfs,destination={TS / 'node_modules'}",
           "-e", "SHELL=/bin/bash"]
    # run.py's progress mode depends on these; -e NAME passes the host's value through
    cmd += [opt for name in ("PARITY_PROGRESS", "AI_AGENT", "CLAUDECODE") if name in os.environ for opt in ("-e", name)]
    if podman:
        cmd += ["--security-opt", "label=disable"]
    elif sys.platform.startswith("linux"):
        cmd += ["--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp"]
    if sys.stdin.isatty() and sys.stdout.isatty():
        cmd.append("-t")
    cmd += [image, "python3", str(ROOT / "run.py"), *args]
    try:
        return subprocess.run(cmd).returncode
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
