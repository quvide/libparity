// Globals present in browsers, workers and Node, declared here so the engine
// typechecks without the DOM or Node type libraries.
declare const performance: { now(): number }
declare const console: {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
