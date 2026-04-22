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

const SURVEY_KEY_PREFIX = "survey:response:";

/** Demo rows so the first visitor sees charts (only applied when the store has no survey keys yet). */
const SEED_SURVEY_RESPONSES = [
  {
    key: `${SURVEY_KEY_PREFIX}seed-balanced-moderate`,
    value: {
      q1: "A fair amount",
      q2: "A few times a week",
      q3: "Somewhat risky",
      q4: "True",
      q5: "All of the above working together",
      q6: "AI needs some rules, but only for the most dangerous uses",
      q7: "False",
      q8: "Somewhat more",
      q9: "Protecting people's personal data",
      q10: "False",
      q11: "Good rules and innovation can exist at the same time",
      q12: "True",
    },
  },
  {
    key: `${SURVEY_KEY_PREFIX}seed-hands-off-user`,
    value: {
      q1: "A little",
      q2: "Every day",
      q3: "Not very risky",
      q4: "True",
      q5: "The companies building AI",
      q6: "AI companies should mostly handle it themselves",
      q7: "True",
      q8: "It would not change how I feel",
      q9: "Making sure the US stays ahead of other countries in AI",
      q10: "True",
      q11: "Government rules kill innovation",
      q12: "False",
    },
  },
  {
    key: `${SURVEY_KEY_PREFIX}seed-strong-rules`,
    value: {
      q1: "A lot",
      q2: "A few times a month",
      q3: "Very risky",
      q4: "True",
      q5: "The government",
      q6: "AI needs strict rules",
      q7: "False",
      q8: "Yes, a lot more",
      q9: "Making sure AI does not discriminate against certain groups",
      q10: "False",
      q11: "Good rules actually push companies to innovate better",
      q12: "True",
    },
  },
];

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

async function seedSurveyResponsesIfEmpty() {
  const store = await readStore();
  const hasAnySurvey = Object.keys(store).some((k) =>
    k.startsWith(SURVEY_KEY_PREFIX),
  );
  if (hasAnySurvey) return;

  for (const row of SEED_SURVEY_RESPONSES) {
    store[row.key] = JSON.stringify(row.value);
  }
  await writeStoreAtomic(store);
  console.log(
    `Seeded ${SEED_SURVEY_RESPONSES.length} demo survey responses (empty store).`,
  );
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

async function start() {
  await seedSurveyResponsesIfEmpty();
  app.listen(PORT, () => {
    console.log(`Survey app listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
