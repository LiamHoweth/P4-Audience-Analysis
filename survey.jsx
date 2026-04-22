/* global React, ReactDOM, Recharts */
/**
 * Single-file anonymous classroom survey + results dashboard.
 * Root component: SurveyApp (treat as `export default SurveyApp` when using a bundler).
 */

const { useCallback, useEffect, useMemo, useRef, useState } = React;
const RechartsLib = window.Recharts || {};
const {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  LabelList,
} = RechartsLib;

const ACCENT = "#00d4aa";
const CHART_PALETTE = ["#00d4aa", "#7c6cff", "#ffb547", "#ff6b9d", "#4ec6ff", "#9fe870"];
const CHARTS_READY = Boolean(
  ResponsiveContainer &&
    BarChart &&
    Bar &&
    XAxis &&
    YAxis &&
    Tooltip &&
    Legend &&
    CartesianGrid &&
    PieChart &&
    Pie &&
    Cell &&
    LabelList,
);

const STORAGE_PREFIX = "survey:response:";

let storageReadyPromise = null;

function installApiStorageAdapter() {
  window.storage = {
    async set(key, value, _shared) {
      const body = typeof value === "string" ? value : JSON.stringify(value);
      const res = await fetch("/api/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: body }),
      });
      if (!res.ok) {
        throw new Error("Could not save to server storage.");
      }
    },
    async get(key) {
      const res = await fetch(`/api/responses/${encodeURIComponent(key)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not read from server storage.");
      const data = await res.json();
      return data?.value ?? null;
    },
    async list(prefix) {
      const res = await fetch(`/api/responses?prefix=${encodeURIComponent(prefix)}`);
      if (!res.ok) throw new Error("Could not list server storage keys.");
      const data = await res.json();
      return Array.isArray(data?.keys) ? data.keys : [];
    },
  };
}

async function canUseApiStorage() {
  try {
    const res = await fetch("/api/health");
    return res.ok;
  } catch {
    return false;
  }
}

function normalizeListResult(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (Array.isArray(raw.keys)) return raw.keys.filter(Boolean);
  if (Array.isArray(raw.items)) return raw.items.filter(Boolean);
  if (Array.isArray(raw.results)) return normalizeListResult(raw.results);
  if (typeof raw === "object") {
    const vals = Object.values(raw).flat();
    if (vals.every((v) => typeof v === "string")) return vals;
  }
  return [];
}

function installIndexedDbStoragePolyfill() {
  const DB_NAME = "anonymous-survey-kv-v1";
  const STORE = "entries";

  const openDb = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Could not open storage."));
    });

  const withStore = async (mode, fn) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let out;
      try {
        out = fn(store);
      } catch (e) {
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error || new Error("Storage transaction failed."));
      tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted."));
    });
  };

  window.storage = {
    async set(key, value, _shared) {
      const stored =
        typeof value === "string" ? value : JSON.stringify(value);
      await withStore("readwrite", (store) => store.put({ key, value: stored }));
    },
    async get(key) {
      return await withStore("readonly", (store) => {
        return new Promise((resolve, reject) => {
          const r = store.get(key);
          r.onsuccess = () => resolve(r.result ? r.result.value : null);
          r.onerror = () => reject(r.error || new Error("Could not read storage."));
        });
      });
    },
    async list(prefix) {
      const rows = await withStore("readonly", (store) => {
        return new Promise((resolve, reject) => {
          const r = store.getAll();
          r.onsuccess = () => resolve(r.result || []);
          r.onerror = () => reject(r.error || new Error("Could not list storage."));
        });
      });
      return rows.map((row) => row.key).filter((k) => k.startsWith(prefix));
    },
  };
}

async function ensureStorage() {
  if (storageReadyPromise) return storageReadyPromise;
  storageReadyPromise = (async () => {
    window.__surveyPolyfillActive = false;
    window.__surveyStorageMode = "unknown";
    if (window.storage && typeof window.storage.get === "function") {
      window.__surveyStorageMode = "window-storage";
      return;
    }
    if (await canUseApiStorage()) {
      installApiStorageAdapter();
      window.__surveyStorageMode = "api";
      return;
    }
    if (!window.indexedDB) {
      throw new Error(
        "This browser does not support the storage this survey needs.",
      );
    }
    installIndexedDbStoragePolyfill();
    window.__surveyPolyfillActive = true;
    window.__surveyStorageMode = "indexeddb";
  })();
  return storageReadyPromise;
}

async function safeListKeys() {
  try {
    await ensureStorage();
    const raw = await window.storage.list(STORAGE_PREFIX);
    return normalizeListResult(raw);
  } catch (error) {
    throw new Error(error?.message || "Could not load the saved response list.");
  }
}

async function safeGetMany(keys) {
  try {
    await ensureStorage();
    return await Promise.all(
      keys.map(async (key) => {
        try {
          return { key, raw: await window.storage.get(key) };
        } catch {
          return { key, raw: null };
        }
      }),
    );
  } catch (error) {
    throw new Error(error?.message || "Could not load saved responses.");
  }
}

async function safeSaveResponse(payloadObj) {
  try {
    await ensureStorage();
    const key = `${STORAGE_PREFIX}${Date.now()}`;
    const body = JSON.stringify(payloadObj);
    await window.storage.set(key, body, true);
  } catch (error) {
    throw new Error(error?.message || "Could not save your response.");
  }
}

function parseStoredRecord(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

const QUESTIONS = [
  {
    id: "q1",
    type: "mc",
    prompt:
      "How much do you know about the debate over whether AI should have government rules?",
    options: ["Nothing at all", "A little", "A fair amount", "A lot"],
  },
  {
    id: "q2",
    type: "mc",
    prompt:
      "How often do you use AI tools like ChatGPT, Siri, or AI image generators?",
    options: [
      "Never",
      "A few times a month",
      "A few times a week",
      "Every day",
    ],
  },
  {
    id: "q3",
    type: "mc",
    prompt: "How risky do you think AI is for society?",
    options: ["Very risky", "Somewhat risky", "Not very risky", "Not risky at all"],
  },
  {
    id: "q4",
    type: "tf",
    prompt:
      "AI is safer when its code is shared publicly so anyone can inspect it and find problems.",
  },
  {
    id: "q5",
    type: "mc",
    prompt: "Who do you think should be in charge of making sure AI is safe?",
    options: [
      "The government",
      "The companies building AI",
      "Independent watchdog groups",
      "All of the above working together",
    ],
  },
  {
    id: "q6",
    type: "mc",
    prompt: "Which of these best describes how you feel about government rules for AI?",
    options: [
      "AI needs strict rules",
      "AI needs some rules, but only for the most dangerous uses",
      "AI companies should mostly handle it themselves",
      "AI should have no government rules at all",
    ],
  },
  {
    id: "q7",
    type: "tf",
    prompt:
      "Government rules for technology usually slow down progress and innovation.",
  },
  {
    id: "q8",
    type: "mc",
    prompt:
      "Would you trust an AI product more if you knew the government had reviewed it for safety?",
    options: [
      "Yes, a lot more",
      "Somewhat more",
      "It would not change how I feel",
      "I would actually trust it less",
    ],
  },
  {
    id: "q9",
    type: "mc",
    prompt: "If the government did create rules for AI, what should be the top priority?",
    options: [
      "Protecting people's personal data",
      "Making sure AI does not discriminate against certain groups",
      "Requiring companies to explain how their AI makes decisions",
      "Making sure the US stays ahead of other countries in AI",
    ],
  },
  {
    id: "q10",
    type: "tf",
    prompt:
      "Big tech companies like Meta, Google, and OpenAI can be trusted to police themselves without government involvement.",
  },
  {
    id: "q11",
    type: "mc",
    prompt: "Which of these statements do you agree with most?",
    options: [
      "Government rules kill innovation",
      "Government rules slow things down but are sometimes worth it",
      "Good rules and innovation can exist at the same time",
      "Good rules actually push companies to innovate better",
    ],
  },
  {
    id: "q12",
    type: "tf",
    prompt:
      "Companies should be required to pass safety checks before releasing AI products to the public, similar to how drugs must be approved before being sold.",
  },
];

const MC_IDS = ["q1", "q2", "q3", "q5", "q6", "q8", "q9", "q11"];
const TF_IDS = ["q4", "q7", "q10", "q12"];

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function countsForOptions(rows, qid, options) {
  const map = Object.fromEntries(options.map((o) => [o, 0]));
  rows.forEach((r) => {
    const v = r[qid];
    if (v != null && Object.prototype.hasOwnProperty.call(map, v)) {
      map[v] += 1;
    }
  });
  return options.map((label) => ({
    label,
    count: map[label],
    percent: pct(map[label], rows.length),
  }));
}

function tfSplit(rows, qid) {
  let t = 0;
  let f = 0;
  rows.forEach((r) => {
    if (r[qid] === "True") t += 1;
    else if (r[qid] === "False") f += 1;
  });
  const total = t + f;
  return [
    { name: "True", value: t, percent: pct(t, total) },
    { name: "False", value: f, percent: pct(f, total) },
  ];
}

function crossTab(rows, rowQ, rowOrder, colQ, colOrder) {
  const matrix = rowOrder.map((rLabel) => {
    const row = { name: rLabel };
    colOrder.forEach((cLabel) => {
      row[cLabel] = 0;
    });
    return row;
  });

  rows.forEach((rec) => {
    const rv = rec[rowQ];
    const cv = rec[colQ];
    if (!rowOrder.includes(rv) || !colOrder.includes(cv)) return;
    const rowObj = matrix.find((m) => m.name === rv);
    rowObj[cv] += 1;
  });

  return matrix;
}

function rowTotal(row, colOrder) {
  return colOrder.reduce((s, c) => s + (row[c] || 0), 0);
}

function topCellPercent(rows, rowQ, rowOrder, colQ, colOrder) {
  const matrix = crossTab(rows, rowQ, rowOrder, colQ, colOrder);
  let best = null;
  matrix.forEach((row) => {
    const denom = rowTotal(row, colOrder);
    colOrder.forEach((col) => {
      const n = row[col] || 0;
      const p = pct(n, denom);
      if (!best || n > best.n) best = { row: row.name, col, n, p, denom };
    });
  });
  return { matrix, best };
}

function insightPair26(rows) {
  const rowOrder = QUESTIONS.find((q) => q.id === "q2").options;
  const colOrder = QUESTIONS.find((q) => q.id === "q6").options;
  const daily = rows.filter((r) => r.q2 === "Every day");
  const target =
    colOrder.find((o) => o.includes("some rules, but only")) || colOrder[1];
  const num = daily.filter((r) => r.q6 === target).length;
  const p = pct(num, daily.length);
  const alt = () => {
    const { best } = topCellPercent(rows, "q2", rowOrder, "q6", colOrder);
    if (!best || best.denom === 0) {
      return "Not enough answers yet to compare these two questions.";
    }
    return `${best.p}% of people who use these tools ${best.row.toLowerCase()} most agree that "${best.col}"`;
  };
  if (daily.length === 0) {
    return {
      text: alt(),
      matrix: crossTab(rows, "q2", rowOrder, "q6", colOrder),
      rowOrder,
      colOrder,
    };
  }
  return {
    text: `${p}% of people who use these tools every day picked this stance: "${target}".`,
    matrix: crossTab(rows, "q2", rowOrder, "q6", colOrder),
    rowOrder,
    colOrder,
  };
}

function insightPair310(rows) {
  const risky = rows.filter((r) => r.q3 === "Very risky");
  const untrust = risky.filter((r) => r.q10 === "False").length;
  const p = pct(untrust, risky.length);
  if (risky.length === 0) {
    const rowOrder = QUESTIONS.find((q) => q.id === "q3").options;
    const colOrder = ["True", "False"];
    const { best } = topCellPercent(rows, "q3", rowOrder, "q10", colOrder);
    const label =
      best.col === "False"
        ? "do not trust big companies to police themselves"
        : "trust big companies to police themselves";
    return {
      text:
        best && best.denom
          ? `${best.p}% of people who see risk as "${best.row}" ${label}.`
          : "Not enough answers yet to compare these two questions.",
      matrix: crossTab(rows, "q3", rowOrder, "q10", colOrder),
      rowOrder,
      colOrder: ["False", "True"],
    };
  }
  return {
    text: `${p}% of people who rated the risk as "Very risky" do not trust big companies to police themselves.`,
    matrix: crossTab(rows, "q3", QUESTIONS.find((q) => q.id === "q3").options, "q10", [
      "False",
      "True",
    ]),
    rowOrder: QUESTIONS.find((q) => q.id === "q3").options,
    colOrder: ["False", "True"],
  };
}

function insightPair711(rows) {
  const rowOrder = ["True", "False"];
  const colOrder = QUESTIONS.find((q) => q.id === "q11").options;
  const slows = rows.filter((r) => r.q7 === "True");
  const aligned = slows.filter((r) =>
    r.q11 === "Government rules kill innovation" ||
    r.q11 === "Government rules slow things down but are sometimes worth it",
  ).length;
  const p = pct(aligned, slows.length);
  if (slows.length === 0) {
    const matrix = crossTab(rows, "q7", rowOrder, "q11", colOrder);
    return {
      text: "Not enough answers yet to compare these two questions.",
      matrix,
      rowOrder,
      colOrder,
    };
  }
  return {
    text: `${p}% of people who agree rules slow innovation also picked answers that treat rules as a drag on progress (at least sometimes).`,
    matrix: crossTab(rows, "q7", rowOrder, "q11", colOrder),
    rowOrder,
    colOrder,
  };
}

function insightPair18(rows) {
  const rowOrder = QUESTIONS.find((q) => q.id === "q1").options;
  const colOrder = QUESTIONS.find((q) => q.id === "q8").options;
  const lot = rows.filter((r) => r.q1 === "A lot");
  const more = lot.filter(
    (r) => r.q8 === "Yes, a lot more" || r.q8 === "Somewhat more",
  ).length;
  const p = pct(more, lot.length);
  if (lot.length === 0) {
    const { best } = topCellPercent(rows, "q1", rowOrder, "q8", colOrder);
    if (!best || !best.denom) {
      return {
        text: "Not enough answers yet to compare these two questions.",
        matrix: crossTab(rows, "q1", rowOrder, "q8", colOrder),
        rowOrder,
        colOrder,
      };
    }
    return {
      text: `${best.p}% of people who know ${best.row.toLowerCase()} about the debate said they would trust a reviewed product "${best.col}".`,
      matrix: crossTab(rows, "q1", rowOrder, "q8", colOrder),
      rowOrder,
      colOrder,
    };
  }
  return {
    text: `${p}% of people who feel they know a lot about the debate say government safety review would make them trust a product more (a little or a lot).`,
    matrix: crossTab(rows, "q1", rowOrder, "q8", colOrder),
    rowOrder,
    colOrder,
  };
}

function buildTakeaways(rows) {
  if (!rows.length) {
    return [
      "Once answers start coming in, this section will highlight the clearest patterns in plain language.",
    ];
  }
  const n = rows.length;
  const top = (qid, options) => {
    let best = options[0];
    let bestC = -1;
    options.forEach((opt) => {
      const c = rows.filter((r) => r[qid] === opt).length;
      if (c > bestC) {
        bestC = c;
        best = opt;
      }
    });
    return { label: best, p: pct(bestC, n) };
  };

  const bullets = [];
  const q6 = top(
    "q6",
    QUESTIONS.find((q) => q.id === "q6").options,
  );
  bullets.push(
    `The most common stance on government rules was: "${q6.label}" (${q6.p}% of people).`,
  );

  const q5 = top(
    "q5",
    QUESTIONS.find((q) => q.id === "q5").options,
  );
  bullets.push(
    `The top pick for who should keep things safe was: "${q5.label}" (${q5.p}% of people).`,
  );

  const false10 = rows.filter((r) => r.q10 === "False").length;
  bullets.push(
    `${pct(false10, n)}% of people said big tech companies cannot be trusted to police themselves without government involvement.`,
  );

  const true12 = rows.filter((r) => r.q12 === "True").length;
  bullets.push(
    `${pct(true12, n)}% of people agreed that companies should pass safety checks before releasing these products to the public.`,
  );

  const q8 = top(
    "q8",
    QUESTIONS.find((q) => q.id === "q8").options,
  );
  bullets.push(
    `On government safety review and trust, the most common answer was: "${q8.label}" (${q8.p}% of people).`,
  );

  return bullets.slice(0, 4);
}

const tooltipStyles = {
  contentStyle: {
    background: "#121826",
    border: "1px solid #1e2636",
    borderRadius: 12,
    color: "#e8ecf4",
    fontFamily: "Outfit, system-ui, sans-serif",
  },
  labelStyle: { color: "#b6bac5", fontWeight: 600 },
  itemStyle: { color: "#e8ecf4" },
};

function MonoTick(props) {
  const { x, y, payload } = props;
  return (
    <text
      x={x}
      y={y}
      dy={4}
      fill="#b6bac5"
      fontSize={11}
      fontFamily="JetBrains Mono, ui-monospace, monospace"
      textAnchor="end"
    >
      {payload.value}
    </text>
  );
}

function HorizontalBarBlock({ title, data }) {
  const chartData = [...data].reverse();
  const renderCountPercent = (value, entry) => {
    if (!entry || !entry.payload) return "";
    return `${entry.payload.count} (${entry.payload.percent}%)`;
  };
  return (
    <div className="rounded-2xl border border-line bg-panel/80 p-5 shadow-glow backdrop-blur">
      <h4 className="mb-4 text-sm font-semibold text-snow">{title}</h4>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart layout="vertical" data={chartData} margin={{ left: 4, right: 28 }}>
            <CartesianGrid strokeDasharray="3 6" stroke="#1e2636" horizontal={false} />
            <XAxis
              type="number"
              stroke="#8b93a7"
              tick={{ fill: "#b6bac5", fontSize: 11, fontFamily: "JetBrains Mono" }}
              allowDecimals={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={260}
              tick={<MonoTick />}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip {...tooltipStyles} formatter={(value, name, item) => [`${value} (${item.payload.percent}%)`, "Responses"]} />
            <Bar dataKey="count" radius={[0, 8, 8, 0]} barSize={14}>
              {chartData.map((_, idx) => (
                <Cell key={idx} fill={CHART_PALETTE[idx % CHART_PALETTE.length]} />
              ))}
              <LabelList
                dataKey="count"
                position="right"
                fill="#e8ecf4"
                fontFamily="JetBrains Mono, ui-monospace, monospace"
                fontSize={11}
                formatter={renderCountPercent}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DonutBlock({ title, data }) {
  return (
    <div className="rounded-2xl border border-line bg-panel/80 p-5 shadow-glow backdrop-blur">
      <h4 className="mb-2 text-sm font-semibold text-snow">{title}</h4>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip
              {...tooltipStyles}
              formatter={(value, _n, item) => [
                `${value} (${item.payload.percent}%)`,
                item.payload.name,
              ]}
            />
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={52}
              outerRadius={78}
              paddingAngle={3}
            >
              {data.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={entry.name === "True" ? ACCENT : "#7c6cff"}
                  stroke="#0c1018"
                  strokeWidth={2}
                />
              ))}
              <LabelList
                dataKey="percent"
                position="outside"
                fill="#e8ecf4"
                fontFamily="JetBrains Mono, ui-monospace, monospace"
                fontSize={12}
                formatter={(v) => `${v}%`}
              />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex items-center justify-center gap-6 text-xs text-mist">
        <span className="inline-flex items-center gap-2 font-mono">
          <span className="h-2 w-2 rounded-full bg-accent" /> True
        </span>
        <span className="inline-flex items-center gap-2 font-mono">
          <span className="h-2 w-2 rounded-full bg-[#7c6cff]" /> False
        </span>
      </div>
    </div>
  );
}

function StackedCorrelationCard({ title, subtitle, insight, matrix, colOrder, stackId }) {
  return (
    <div className="rounded-2xl border border-line bg-panel/80 p-5 shadow-glow backdrop-blur">
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h4 className="text-base font-semibold text-snow">{title}</h4>
          <p className="mt-1 max-w-3xl text-sm text-mist">{subtitle}</p>
        </div>
      </div>
      <div className="mb-4 rounded-xl border border-accent/20 bg-ink/60 px-4 py-3 text-sm text-snow">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
          Quick read
        </span>
        <p className="mt-2 leading-relaxed">{insight}</p>
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={matrix} margin={{ top: 8, right: 8, left: 8, bottom: 96 }}>
            <CartesianGrid strokeDasharray="3 6" stroke="#1e2636" vertical={false} />
            <XAxis
              dataKey="name"
              stroke="#8b93a7"
              tick={{ fill: "#b6bac5", fontSize: 11, fontFamily: "JetBrains Mono" }}
            />
            <YAxis
              stroke="#8b93a7"
              tick={{ fill: "#b6bac5", fontSize: 11, fontFamily: "JetBrains Mono" }}
              allowDecimals={false}
            />
            <Tooltip {...tooltipStyles} />
            <Legend wrapperStyle={{ color: "#b6bac5", fontSize: 12 }} />
            {colOrder.map((col, idx) => (
              <Bar
                key={col}
                dataKey={col}
                stackId={stackId}
                fill={CHART_PALETTE[idx % CHART_PALETTE.length]}
                radius={idx === colOrder.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SectionHeading({ eyebrow, title, subtitle, id }) {
  return (
    <div id={id} className="mb-8 scroll-mt-28">
      <p className="font-mono text-xs uppercase tracking-[0.28em] text-accent">{eyebrow}</p>
      <h3 className="mt-2 text-2xl font-semibold text-snow md:text-3xl">{title}</h3>
      {subtitle ? <p className="mt-2 max-w-2xl text-sm text-mist">{subtitle}</p> : null}
    </div>
  );
}

function Reveal({ children, delay = 0 }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`transform transition-all duration-700 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

function SurveyApp() {
  const [booting, setBooting] = useState(true);
  const [storageError, setStorageError] = useState("");
  const [usingFallback, setUsingFallback] = useState(false);
  const [responses, setResponses] = useState([]);
  const [mode, setMode] = useState("landing");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [slide, setSlide] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const refreshData = useCallback(async ({ silent } = {}) => {
    if (!silent) setBooting(true);
    setStorageError("");
    try {
      await ensureStorage();
      if (!window.storage || typeof window.storage.list !== "function") {
        throw new Error("Storage is not available in this environment.");
      }
      setUsingFallback(!!window.__surveyPolyfillActive);

      const keys = await safeListKeys();
      const rowsRaw = await safeGetMany(keys);
      const parsed = [];
      rowsRaw.forEach(({ raw }) => {
        const obj = parseStoredRecord(raw);
        if (obj && typeof obj === "object") parsed.push(obj);
      });
      setResponses(parsed);
      setMode((prev) => {
        if (parsed.length > 0 && prev === "landing") return "dashboard";
        return prev;
      });
    } catch (e) {
      setStorageError(
        e?.message ||
          "Could not load past responses. If this keeps happening, try refreshing the page.",
      );
      setResponses([]);
    } finally {
      if (!silent) setBooting(false);
    }
  }, []);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    setSlide(false);
    const id = requestAnimationFrame(() => setSlide(true));
    return () => cancelAnimationFrame(id);
  }, [step]);

  const current = QUESTIONS[step];
  const progressLabel = `${step + 1} of ${QUESTIONS.length}`;
  const progressPct = ((step + 1) / QUESTIONS.length) * 100;

  const selectOption = (value) => {
    setAnswers((prev) => ({ ...prev, [current.id]: value }));
  };

  const canAdvance = Boolean(answers[current?.id]);

  const goNext = () => {
    if (!canAdvance) return;
    if (step < QUESTIONS.length - 1) setStep((s) => s + 1);
  };

  const goBack = () => {
    if (step > 0) setStep((s) => s - 1);
  };

  const startSurvey = () => {
    setAnswers({});
    setStep(0);
    setMode("survey");
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  const submit = async () => {
    if (!canAdvance) return;
    setSubmitting(true);
    setStorageError("");
    try {
      const payload = {};
      QUESTIONS.forEach((q) => {
        payload[q.id] = answers[q.id];
      });
      await safeSaveResponse(payload);
      await refreshData({ silent: true });
      setMode("dashboard");
      window.requestAnimationFrame(() => {
        const el = document.getElementById("results-top");
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (e) {
      setStorageError(
        e?.message ||
          "Your answers could not be saved. Nothing was stored this time.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const takeaways = useMemo(() => buildTakeaways(responses), [responses]);

  const pair26 = useMemo(() => insightPair26(responses), [responses]);
  const pair310 = useMemo(() => insightPair310(responses), [responses]);
  const pair711 = useMemo(() => insightPair711(responses), [responses]);
  const pair18 = useMemo(() => insightPair18(responses), [responses]);

  const navScroll = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (booting) {
    return (
      <div className="min-h-screen bg-grid bg-ink text-snow">
        <div className="mx-auto flex max-w-3xl flex-col items-center justify-center px-6 py-32 text-center">
          <div className="h-12 w-12 animate-spin rounded-full border-2 border-line border-t-accent" />
          <p className="mt-6 text-sm text-mist">Gathering the latest group responses…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-grid bg-ink text-snow">
      <div className="soft-vignette" />
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent" />
      <header className="sticky top-0 z-30 border-b border-line/80 bg-ink/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-accent">
                Anonymous class survey
            </p>
            <p className="text-sm text-mist">Rules for AI</p>
          </div>
          <div className="flex items-center gap-2">
            {mode === "dashboard" ? (
              <button
                type="button"
                onClick={startSurvey}
                className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-ink shadow-glow transition hover:bg-accentDim"
              >
                Take survey
              </button>
            ) : null}
            {mode === "dashboard" ? (
              <button
                type="button"
                onClick={() => navScroll("section-1")}
                className="rounded-full border border-line px-4 py-2 text-sm text-mist transition hover:border-accent hover:text-snow"
              >
                Jump to charts
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-5 pb-24 pt-10">
        {usingFallback ? (
          <div className="mb-6 rounded-2xl border border-line bg-panel/70 px-4 py-3 text-sm text-mist">
            Heads up: this preview is storing answers on this device only.
            To share one combined set of results across classmates, run this app with the
            server API enabled (for example on Render Web Service).
          </div>
        ) : null}

        {storageError ? (
          <div className="mb-6 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {storageError}
          </div>
        ) : null}

        {mode === "landing" ? (
          <section className="card-sheen relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-panel via-ink to-igloo/40 p-10 shadow-glow md:p-14">
            <div className="floating-orb pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />
            <div className="floating-orb-slow pointer-events-none absolute -bottom-32 -left-10 h-72 w-72 rounded-full bg-[#7c6cff]/10 blur-3xl" />
            <div className="relative max-w-3xl">
              <p className="font-mono text-xs uppercase tracking-[0.3em] text-silver">
                ENGL-1213-395 · Spring 2026 · Week 14 discussion
              </p>
              <h1 className="mt-4 max-w-4xl text-4xl font-semibold leading-tight md:text-6xl">
                Should AI follow government rules, or should the companies set their own
                safety rules?
              </h1>
              <p className="mt-5 text-base leading-relaxed text-mist">
                This is anonymous. No names, no email, no grades—just twelve tap-to-answer
                questions so we can see where the class stands, then look at charts together.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={startSurvey}
                  className="rounded-full bg-accent px-6 py-3 text-sm font-semibold text-ink shadow-glow transition duration-300 hover:-translate-y-0.5 hover:bg-accentDim"
                >
                  Start the survey
                </button>
                {responses.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMode("dashboard");
                      window.requestAnimationFrame(() =>
                        document.getElementById("results-top")?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        }),
                      );
                    }}
                    className="rounded-full border border-line px-6 py-3 text-sm text-mist transition duration-300 hover:-translate-y-0.5 hover:border-accent hover:text-snow"
                  >
                    View results ({responses.length})
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {mode === "survey" ? (
          <section className="mx-auto max-w-3xl">
            <div className="mb-8 flex items-center justify-between gap-4">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.28em] text-accent">
                  Your progress
                </p>
                <p className="text-sm text-mist">{progressLabel}</p>
              </div>
              <p className="font-mono text-xs text-silver">{Math.round(progressPct)}%</p>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent to-[#4ec6ff] transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            <div
              className={`mt-10 transform transition duration-500 ease-out ${
                slide ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
              }`}
            >
              <div className="card-sheen rounded-3xl border border-line bg-panel/80 p-8 shadow-glow backdrop-blur-md md:p-10">
                <p className="font-mono text-xs uppercase tracking-[0.28em] text-silver">
                  Question {step + 1}
                </p>
                <h2 className="mt-3 text-2xl font-semibold leading-snug md:text-3xl">
                  {current.prompt}
                </h2>

                <div className="mt-8 grid gap-3">
                  {current.type === "mc"
                    ? current.options.map((opt) => {
                        const active = answers[current.id] === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => selectOption(opt)}
                            className={`group flex w-full items-center justify-between rounded-2xl border px-4 py-4 text-left text-sm transition duration-300 md:text-base ${
                              active
                                ? "border-accent bg-accent/10 text-snow shadow-glow"
                                : "border-line bg-ink/40 text-mist hover:-translate-y-0.5 hover:border-silver/60 hover:text-snow"
                            }`}
                          >
                            <span>{opt}</span>
                            <span
                              className={`font-mono text-xs ${
                                active ? "text-accent" : "text-silver"
                              }`}
                            >
                              {active ? "Selected" : "Choose"}
                            </span>
                          </button>
                        );
                      })
                    : ["True", "False"].map((opt) => {
                        const active = answers[current.id] === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => selectOption(opt)}
                            className={`rounded-2xl border px-4 py-5 text-center text-lg font-semibold transition duration-300 ${
                              active
                                ? "border-accent bg-accent/10 text-snow shadow-glow"
                                : "border-line bg-ink/40 text-mist hover:-translate-y-0.5 hover:border-silver/60 hover:text-snow"
                            }`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                </div>

                <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={goBack}
                    disabled={step === 0}
                    className="rounded-full border border-line px-5 py-2 text-sm text-mist transition enabled:hover:border-accent enabled:hover:text-snow disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Back
                  </button>
                  {step < QUESTIONS.length - 1 ? (
                    <button
                      type="button"
                      onClick={goNext}
                      disabled={!canAdvance}
                      className="rounded-full bg-accent px-6 py-2 text-sm font-semibold text-ink shadow-glow transition enabled:hover:bg-accentDim disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={submit}
                      disabled={!canAdvance || submitting}
                      className="rounded-full bg-accent px-6 py-2 text-sm font-semibold text-ink shadow-glow transition enabled:hover:bg-accentDim disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {submitting ? "Submitting…" : "Submit answers"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {mode === "dashboard" ? (
          <div className="space-y-16" id="results-top">
            <Reveal>
            <section className="card-sheen relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-panel via-ink to-igloo/35 p-10 shadow-glow md:p-12">
              <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-accent/10 to-transparent blur-3xl" />
              <div className="relative flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">
                    Survey Results
                  </p>
                  <h2 className="mt-3 text-4xl font-semibold md:text-5xl">Survey Results</h2>
                  <p className="mt-3 max-w-xl text-base text-mist">
                    Here's how your classmates responded.
                  </p>
                </div>
                <div className="flex flex-col items-start gap-3 md:items-end">
                  <div className="rounded-2xl border border-line bg-ink/60 px-5 py-4 text-left shadow-inner">
                    <p className="font-mono text-xs uppercase tracking-[0.2em] text-silver">
                      Total responses
                    </p>
                    <p className="mt-2 font-mono text-4xl text-accent">{responses.length}</p>
                  </div>
                  <button
                    type="button"
                    onClick={startSurvey}
                    className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-ink shadow-glow transition duration-300 hover:-translate-y-0.5 hover:bg-accentDim"
                  >
                    Take survey
                  </button>
                </div>
              </div>
              <div className="relative mt-8 flex flex-wrap gap-3 text-sm text-mist">
                <button
                  type="button"
                  onClick={() => navScroll("section-1")}
                  className="rounded-full border border-line px-4 py-2 transition hover:border-accent hover:text-snow"
                >
                  Individual answers
                </button>
                <button
                  type="button"
                  onClick={() => navScroll("section-2")}
                  className="rounded-full border border-line px-4 py-2 transition hover:border-accent hover:text-snow"
                >
                  Compare answers
                </button>
                <button
                  type="button"
                  onClick={() => navScroll("section-3")}
                  className="rounded-full border border-line px-4 py-2 transition hover:border-accent hover:text-snow"
                >
                  Key takeaways
                </button>
              </div>
            </section>
            </Reveal>

            <Reveal delay={80}>
            <section>
              <SectionHeading
                id="section-1"
                eyebrow="Section 1"
                title="Individual question results"
                subtitle="Each chart is a snapshot of the full class set so far."
              />
              {!CHARTS_READY ? (
                <div className="rounded-2xl border border-line bg-panel/70 px-4 py-3 text-sm text-mist">
                  Charts could not load. Try a hard refresh. If this persists, your
                  network may be blocking JavaScript—try another network or browser.
                </div>
              ) : null}
              {responses.length === 0 ? (
                <p className="text-sm text-mist">
                  No responses yet. Be the first to take the survey.
                </p>
              ) : CHARTS_READY ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  {MC_IDS.map((qid) => {
                    const meta = QUESTIONS.find((q) => q.id === qid);
                    return (
                      <HorizontalBarBlock
                        key={qid}
                        title={meta.prompt}
                        data={countsForOptions(responses, qid, meta.options)}
                      />
                    );
                  })}
                  {TF_IDS.map((qid) => {
                    const meta = QUESTIONS.find((q) => q.id === qid);
                    return (
                      <DonutBlock key={qid} title={meta.prompt} data={tfSplit(responses, qid)} />
                    );
                  })}
                </div>
              ) : null}
            </section>
            </Reveal>

            <Reveal delay={120}>
            <section>
              <SectionHeading
                id="section-2"
                eyebrow="Section 2"
                title="Correlation insights"
                subtitle="These charts stack two questions together to see if patterns show up."
              />
              {CHARTS_READY ? (
              <div className="grid gap-8">
                <StackedCorrelationCard
                  stackId="pair-q2-q6"
                  title="Usage frequency vs. stance on government rules"
                  subtitle="Does how often you use these tools affect how you feel about government rules?"
                  insight={pair26.text}
                  matrix={pair26.matrix}
                  colOrder={pair26.colOrder}
                />
                <StackedCorrelationCard
                  stackId="pair-q3-q10"
                  title="Risk level vs. trusting companies to self-police"
                  subtitle="Does seeing more risk line up with trusting big companies to police themselves?"
                  insight={pair310.text}
                  matrix={pair310.matrix}
                  colOrder={pair310.colOrder}
                />
                <StackedCorrelationCard
                  stackId="pair-q7-q11"
                  title="Rules slowing innovation vs. rules and creativity"
                  subtitle="Are people consistent about rules slowing progress and how rules relate to innovation?"
                  insight={pair711.text}
                  matrix={pair711.matrix}
                  colOrder={pair711.colOrder}
                />
                <StackedCorrelationCard
                  stackId="pair-q1-q8"
                  title="Knowledge of the debate vs. trust after government review"
                  subtitle="Does knowing more about the debate change whether a safety review would affect trust?"
                  insight={pair18.text}
                  matrix={pair18.matrix}
                  colOrder={pair18.colOrder}
                />
              </div>
              ) : (
                <div className="rounded-2xl border border-line bg-panel/70 px-4 py-3 text-sm text-mist">
                  Correlation charts are unavailable until the chart library loads.
                </div>
              )}
            </section>
            </Reveal>

            <Reveal delay={160}>
            <section>
              <SectionHeading
                id="section-3"
                eyebrow="Section 3"
                title="Key takeaways"
                subtitle="Short, plain-language bullets based on the most common answers right now."
              />
              <ul className="space-y-4 rounded-3xl border border-line bg-panel/70 p-6 text-sm leading-relaxed text-mist md:p-8 md:text-base">
                {takeaways.map((line, idx) => (
                  <li key={idx} className="flex gap-3">
                    <span className="font-mono text-accent">0{idx + 1}</span>
                    <span className="text-snow">{line}</span>
                  </li>
                ))}
              </ul>
            </section>
            </Reveal>
          </div>
        ) : null}
      </main>

      <footer className="border-t border-line/70 bg-ink/90 py-8 text-center text-xs text-mist">
        ENGL-1213-395 (Spring 2026) · Week 14 Audience Analysis discussion · Anonymous survey
      </footer>
    </div>
  );
}

window.__SURVEY_APP__ = SurveyApp;
const rootNode = document.getElementById("root");
if (rootNode) {
  const root = ReactDOM.createRoot(rootNode);
  root.render(<SurveyApp />);
}
