/**
 * Copies browser UMD bundles into /vendor so the browser loads them first-party
 * (same origin as the app), which avoids many ad-block / CDN block lists.
 *
 * Recharts UMD expects globals: React, ReactDOM, PropTypes (in that dependency order).
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const destDir = path.join(root, "vendor");

const copies = [
  {
    src: path.join(root, "node_modules", "recharts", "umd", "Recharts.js"),
    dest: path.join(destDir, "recharts.js"),
    label: "recharts",
  },
  {
    src: path.join(root, "node_modules", "prop-types", "prop-types.min.js"),
    dest: path.join(destDir, "prop-types.js"),
    label: "prop-types",
  },
];

let skipped = true;
for (const { src, dest, label } of copies) {
  if (!fs.existsSync(src)) {
    console.warn(
      `[copy-recharts-vendor] Skipping ${label}: source missing (${path.relative(root, src)}).`,
    );
    continue;
  }
  skipped = false;
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log("[copy-recharts-vendor] Wrote", path.relative(root, dest));
}

if (skipped) {
  process.exit(0);
}
