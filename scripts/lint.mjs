// web-ext lint --warnings-as-errors, minus the warnings that only hold for Firefox:
// addons-linter knows no Thunderbird permissions, and checks the manifest for
// Firefox for Android, which Thunderbird is not. Anything else fails.
import { execFileSync } from 'node:child_process'

const THUNDERBIRD_ONLY = [
  (w) => w.code === 'MANIFEST_PERMISSIONS' && /"(messagesRead|accountsRead)"/.test(w.message),
  (w) => w.code === 'KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION',
]

let out
try {
  out = execFileSync('web-ext', ['lint', '--output=json'], { encoding: 'utf8' })
} catch (e) {
  out = e.stdout // web-ext exits non-zero on errors; the JSON says which
}
const report = JSON.parse(out)
const problems = [
  ...report.errors,
  ...report.notices,
  ...report.warnings.filter((w) => !THUNDERBIRD_ONLY.some((skip) => skip(w))),
]
for (const p of problems) console.error(`${p._type} ${p.code} ${p.file ?? ''}: ${p.message}`)
console.log(`web-ext lint: ${problems.length} problem(s), ${report.count - problems.length} Thunderbird-only warning(s) skipped`)
process.exit(problems.length ? 1 : 0)
