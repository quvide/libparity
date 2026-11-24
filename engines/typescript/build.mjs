import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"

const tsc = (project) => execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", project], { stdio: "inherit" })
rmSync("dist", { recursive: true, force: true })
tsc("tsconfig.build.json")
tsc("tsconfig.cjs.json")
writeFileSync("dist/cjs/package.json", '{"type":"commonjs"}\n')
