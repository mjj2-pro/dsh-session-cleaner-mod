import { readFile } from 'node:fs/promises';
const src = await readFile('./lib/client.js', 'utf8');
const lines = src.split('\n');
let inside = null, depth = 0, sawReturn = false, problems = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const fn = line.match(/^\s{4}function ([A-Za-z0-9_]+)\s*\(/);
  if (fn) { inside = fn[1]; depth = 0; sawReturn = false; continue; }
  if (inside === null) continue;
  if (/^\s{4}\}/.test(line)) { inside = null; continue; }
  if (/^\s*if \(.*\) return null;/.test(line)) sawReturn = true;
  const hook = line.match(/\buse[A-Z][A-Za-z0-9_]*\s*\(/);
  if (sawReturn && hook) {
    console.log(`[HOOK-AFTER-EARLY-RETURN] ${inside} line ${i + 1}: ${hook[0]}  <- ${line.trim().slice(0,60)}`);
    problems++;
  }
}
console.log(problems === 0 ? 'OK: 没有 Hook 落在 early return 之后' : `发现 ${problems} 处问题`);
