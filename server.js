const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.RENDER ? "/var/data" : path.join(__dirname, "data"));
const DATA_FILE = path.join(DATA_DIR, "responses.json");

app.use(express.json({ limit: "1mb" }));

async function ensureDataFile() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(DATA_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(DATA_FILE, JSON.stringify({}), "utf8");
  }
}

async function readStore() {
  await ensureDataFile();
  const raw = await fsp.readFile(DATA_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

let writeQueue = Promise.resolve();
function writeStoreAtomic(nextObj) {
  writeQueue = writeQueue.then(async () => {
    await ensureDataFile();
    const tmp = `${DATA_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(nextObj), "utf8");
    await fsp.rename(tmp, DATA_FILE);
  });
  return writeQueue;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/responses", async (req, res) => {
  try {
    const prefix = String(req.query.prefix || "");
    const store = await readStore();
    const keys = Object.keys(store).filter((k) => k.startsWith(prefix));
    res.json({ keys });
  } catch (error) {
    res.status(500).json({ error: "Could not list responses." });
  }
});

app.get("/api/responses/:key", async (req, res) => {
  try {
    const key = String(req.params.key || "");
    const store = await readStore();
    if (!Object.prototype.hasOwnProperty.call(store, key)) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    res.json({ key, value: store[key] });
  } catch {
    res.status(500).json({ error: "Could not fetch response." });
  }
});

app.post("/api/responses", async (req, res) => {
  try {
    const key = String(req.body?.key || "");
    const value = req.body?.value;
    if (!key || typeof value !== "string") {
      res.status(400).json({ error: "Invalid payload." });
      return;
    }
    const store = await readStore();
    store[key] = value;
    await writeStoreAtomic(store);
    res.status(201).json({ ok: true });
  } catch {
    res.status(500).json({ error: "Could not save response." });
  }
});

app.use(express.static(__dirname));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Survey app listening on http://localhost:${PORT}`);
});
