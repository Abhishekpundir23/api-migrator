const fs = require("fs");
const path = require("path");
// Keep in sync with INNGEST_USAGE in run-migration.js.
const usage = [
  /\bnew\s+Inngest\s*\(/,
  /\bcreateFunction\s*\(/,
  /\bEventSchemas\b/,
  /\breferenceFunction\b/,
  /\bInngestFunction\b/,
  /from\s+["']@?inngest/,
  /require\(\s*["']@?inngest/,
];
const dir = process.argv[2];
const stack = [dir];
const skip = ["node_modules", ".next", ".git", "dist", "build"];
const out = [];
while (stack.length) {
  const cur = stack.pop();
  let e;
  try {
    e = fs.readdirSync(cur, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const x of e) {
    if (skip.includes(x.name)) continue;
    const f = path.join(cur, x.name);
    if (x.isDirectory()) stack.push(f);
    else if (/\.(ts|tsx|js|jsx)$/.test(x.name)) {
      let t;
      try {
        t = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      if (usage.some((re) => re.test(t)))
        out.push(f.replace(dir + "/", "") + "  [" + path.extname(f) + "]");
    }
  }
}
console.log(out.join("\n"));
