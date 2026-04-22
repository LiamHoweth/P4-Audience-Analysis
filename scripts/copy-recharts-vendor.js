/**
 * Copies the Recharts UMD build into /vendor so the browser loads it first-party
 * (same origin as the app), which avoids many ad-block / CDN block lists.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "node_modules", "recharts", "umd", "Recharts.js");
const destDir = path.join(root, "vendor");
const dest = path.join(destDir, "recharts.js");

if (!fs.existsSync(src)) {
  console.warn(
    "[copy-recharts-vendor] Skipping: node_modules/recharts not installed yet.",
  );
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log("[copy-recharts-vendor] Wrote", path.relative(root, dest));
