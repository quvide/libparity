// Progress for long runs, on stderr, in one of three modes:
//   tty    one line redrawn in place: count, percent, elapsed, time left
//   lines  a plain "progress: ..." line every LINE_INTERVAL_MS, for agents
//          that read the output later and only need to see it moving
//   off    nothing, for logs and redirected or piped output
// PARITY_PROGRESS=tty|lines|off picks the mode (run.py sets it for the
// commands it wraps); otherwise a terminal gets tty, an agent (AI_AGENT or
// CLAUDECODE set) gets lines, and the rest off. An agent's command output
// is itself a file, so a redirect can't be told apart from it.
export type ProgressMode = "tty" | "lines" | "off"

const LINE_INTERVAL_MS = 30_000
const TTY_INTERVAL_MS = 100

export function progressMode(): ProgressMode {
  const env = process.env.PARITY_PROGRESS
  if (env === "tty" || env === "lines" || env === "off") return env
  if (process.stderr.isTTY) return "tty"
  if (process.env.AI_AGENT || process.env.CLAUDECODE) return "lines"
  return "off"
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}

export interface Progress {
  /** `done` items finished; `label` names the current item (tty only). */
  update(done: number, label?: string): void
  setTotal(total: number): void
  /** Erase the tty line before printing real output; the next update redraws it. */
  clear(): void
}

export function createProgress(task: string, total?: number, mode = progressMode()): Progress {
  const started = Date.now()
  let lastDraw = 0
  let shown = false
  let done = 0
  let label = ""

  const status = () => {
    const elapsed = Date.now() - started
    const parts = [total ? `${done}/${total}` : `${done}`]
    if (total) parts.push(`${Math.floor((100 * done) / total)}%`)
    parts.push(fmtDuration(elapsed))
    if (total && done > 0 && done < total && elapsed > 2000)
      parts.push(`~${fmtDuration((elapsed / done) * (total - done))} left`)
    return parts
  }

  const draw = () => {
    if (mode === "tty") {
      const width = process.stderr.columns || Number(process.env.COLUMNS) || 80
      const text = `${task}  ${status().join("  ")}${label ? `  ${label}` : ""}`.slice(0, width - 1)
      process.stderr.write(`\r\x1b[2K\x1b[2m${text}\x1b[0m`)
      shown = true
    } else if (mode === "lines") {
      const [count, ...rest] = status()
      process.stderr.write(`progress: ${task} ${count}${rest.length ? ` (${rest.join(", ")})` : ""}\n`)
    }
  }

  return {
    update(n, l) {
      done = n
      label = l ?? ""
      const now = Date.now()
      const interval = mode === "lines" ? LINE_INTERVAL_MS : TTY_INTERVAL_MS
      if (mode === "off" || (now - lastDraw < interval && (mode === "lines" || shown))) return
      if (mode === "lines" && now - started < LINE_INTERVAL_MS) return
      lastDraw = now
      draw()
    },
    setTotal(n) {
      total = n
    },
    clear() {
      if (!shown) return
      process.stderr.write("\r\x1b[2K")
      shown = false
    },
  }
}
