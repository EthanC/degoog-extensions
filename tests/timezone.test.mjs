import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const pluginDir = path.resolve("plugins/timezone");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const template = await readFile(path.join(pluginDir, "template.html"), "utf8");
const indexSource = await readFile(path.join(pluginDir, "index.js"), "utf8");
const scriptSource = await readFile(path.join(pluginDir, "script.js"), "utf8");
const locales = Object.fromEntries(
  await Promise.all(
    ["en", "de", "fr", "it"].map(async (lang) => [
      lang,
      JSON.parse(await readFile(path.join(pluginDir, "locales", `${lang}.json`), "utf8")),
    ]),
  ),
);

const lookup = (bank, key) =>
  key.split(".").reduce((cur, part) => (cur && typeof cur === "object" ? cur[part] : undefined), bank);

const translator = (key, vars, locale) => {
  const lang = String(locale || "en").split("-")[0];
  const value = lookup(locales[lang], key) ?? lookup(locales.en, key);
  if (typeof value !== "string") return key;
  if (!vars) return value;
  return value.replace(/\{([^}]+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
};

const { slot, _internals } = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
slot.t = translator;
slot.init({ template });

const defaults = Object.fromEntries(slot.settingsSchema.map((field) => [field.key, field.default]));
const configure = (overrides = {}) => slot.configure({ ...defaults, homeZone: "America/New_York", ...overrides });
configure();

const NOW = Date.parse("2026-11-01T12:00:00Z");
const at = (iso) => Date.parse(iso);
const run = (query, context = {}) => slot.execute(query, { locale: "en-US", now: NOW, ...context });

const attr = (html, name) => {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
};

// Text of the first element with data-tz-fmt=<kind> inside the row for <zone> and <role>.
const rowField = (html, role, zone, kind) => {
  const start = html.indexOf(`data-tz-role="${role}" data-tz-zone="${zone}"`);
  if (start < 0) return null;
  const end = html.indexOf('<div class="tz-row', start + 1);
  const row = html.slice(start, end < 0 ? undefined : end);
  const match = row.match(new RegExp(`data-tz-fmt="${kind}"[^>]*>([^<]*)<`));
  return match ? match[1] : null;
};

const headline = (html) => {
  const block = html.match(/<div class="tz-headline">([\s\S]*?)<\/div>\s*<div class="tz-sub">/)?.[1] ?? "";
  return block.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
};

const notes = (html) => [...html.matchAll(/<p class="tz-note"[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);
const dstRows = (html) =>
  [...html.matchAll(/data-tz-row="dst"><dt class="tz-label">([^<]*)<\/dt><dd class="tz-value"><span class="tz-text">([^<]*)</g)].map(
    (m) => [m[1], m[2]],
  );

const zonesOf = (parsed) => {
  if (!parsed) return null;
  const id = (entry) => (entry ? entry.zone : "home");
  if (parsed.intent === "now") return parsed.zones.map(id);
  if (parsed.intent === "convert") return [id(parsed.source), ...parsed.targets.map(id)];
  if (parsed.intent === "diff") return [id(parsed.base), ...parsed.targets.map(id)];
  return [id(parsed.zone)];
};

test("plugin shape matches the degoog slot contract", () => {
  assert.equal(typeof slot.name, "string");
  assert.equal(typeof slot.trigger, "function");
  assert.equal(typeof slot.execute, "function");
  assert.equal(slot.isClientExposed, false);
  assert.equal(slot.position, "at-a-glance");
  assert.ok(slot.slotPositions.includes(slot.position));
  assert.equal(slot.supportsNojs, true);
  for (const field of slot.settingsSchema) {
    assert.equal(typeof field.default, "string", field.key);
    assert.ok(lookup(locales.en, `timezone.settings.${field.key}.label`), field.key);
    assert.equal(lookup(locales.en, `timezone.settings.${field.key}.label`), field.label, field.key);
  }
});

test("store manifest lists the plugin as a slot with a semantic version", () => {
  const entry = manifest.plugins.find((item) => item.path === "plugins/timezone");
  assert.ok(entry);
  assert.equal(entry.type, "slot");
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
  assert.equal(entry.description, slot.description);
  assert.equal(lookup(locales.en, "timezone.description"), slot.description);
});

test("every locale carries the same keys as English", () => {
  const flatten = (obj, prefix = "") =>
    Object.entries(obj).flatMap(([key, value]) =>
      typeof value === "object" ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`],
    );
  const english = flatten(locales.en).sort();
  for (const [lang, bank] of Object.entries(locales)) {
    assert.deepEqual(flatten(bank).sort(), english, lang);
  }
});

test("every translation key used in the code exists in English", () => {
  const used = new Set();
  for (const source of [indexSource, scriptSource]) {
    for (const match of source.matchAll(/\btr\(\s*"([a-zA-Z.]+)"/g)) used.add(match[1]);
    for (const match of source.matchAll(/"((?:title|kicker|labels|diff|dst|note)\.[a-zA-Z]+)"/g)) used.add(match[1]);
    for (const match of source.matchAll(/`kicker\.\$\{[^}]+\}`/g)) used.add(match[0]);
  }
  for (const key of used) {
    if (key.includes("${")) continue;
    assert.equal(typeof lookup(locales.en, `timezone.${key}`), "string", key);
  }
});

test("script.js carries an exact copy of the shared time zone maths", () => {
  const block = (source) => {
    const start = source.indexOf("// <shared-core>");
    const end = source.indexOf("// </shared-core>");
    assert.ok(start >= 0 && end > start);
    return source
      .slice(start, end)
      .split("\n")
      .map((line) => line.trim())
      .join("\n");
  };
  assert.equal(block(scriptSource), block(indexSource));
});

test("every zone in the lookup tables is valid", () => {
  for (const zone of new Set(_internals.tableZones())) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), zone);
  }
  for (const [key, entry] of _internals.zoneIndex) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: entry.zone }), `${key} -> ${entry.zone}`);
  }
});

test("no single-word zone key collides with a grammar word", () => {
  const grammar = new Set(_internals.grammarWords());
  for (const key of _internals.zoneIndex.keys()) {
    assert.ok(!grammar.has(key), key);
  }
  for (const word of ["easter", "christmas", "wake", "center", "jersey", "oral", "us", "at", "west", "nt", "z"]) {
    assert.ok(!_internals.zoneIndex.has(word), word);
  }
  assert.equal(_internals.zoneIndex.get("kolkata").zone, "Asia/Kolkata");
  assert.equal(_internals.zoneIndex.get("san juan").zone, "America/Puerto_Rico");
});

const POSITIVE = [
  ["current time melbourne", "now", ["Australia/Melbourne"]],
  ["current time ET", "now", ["America/New_York"]],
  ["current time est", "now", ["America/New_York"]],
  ["what time is it in tokyo", "now", ["Asia/Tokyo"]],
  ["What's the time in Tokyo?", "now", ["Asia/Tokyo"]],
  ["time in new york", "now", ["America/New_York"]],
  ["melbourne time", "now", ["Australia/Melbourne"]],
  ["london time now", "now", ["Europe/London"]],
  ["time zone in dubai", "now", ["Asia/Dubai"]],
  ["what time zone is dubai in", "now", ["Asia/Dubai"]],
  ["eastern time", "now", ["America/New_York"]],
  ["utc", "now", ["UTC"]],
  ["what time is it", "now", []],
  ["local time", "now", []],
  ["what is my time zone", "now", []],
  ["what time is it in the usa", "now", ["America/New_York"]],
  ["mumbai time", "now", ["Asia/Kolkata"]],
  ["time in kyiv", "now", ["Europe/Kyiv"]],
  ["zürich time", "now", ["Europe/Zurich"]],
  ["time in st. john’s", "now", ["America/St_Johns"]],
  ["Europe/Berlin time", "now", ["Europe/Berlin"]],
  ["what is cet", "now", ["Europe/Berlin"]],
  ["time in london and tokyo", "now", ["Europe/London", "Asia/Tokyo"]],
  ["5pm ET to PT", "convert", ["America/New_York", "America/Los_Angeles"]],
  ["5:30pm est in tokyo", "convert", ["America/New_York", "Asia/Tokyo"]],
  ["17:00 london to new york", "convert", ["Europe/London", "America/New_York"]],
  ["convert 9am cet to ist", "convert", ["Europe/Berlin", "Asia/Kolkata"]],
  ["noon pt to et", "convert", ["America/Los_Angeles", "America/New_York"]],
  ["5pm ET tomorrow to PT", "convert", ["America/New_York", "America/Los_Angeles"]],
  ["5pm ET monday to PT", "convert", ["America/New_York", "America/Los_Angeles"]],
  ["5pm ET nov 8 to PT", "convert", ["America/New_York", "America/Los_Angeles"]],
  ["5pm et to pt nov 8, 2026", "convert", ["America/New_York", "America/Los_Angeles"]],
  ["9am utc+5:30 to pst", "convert", ["+05:30", "America/Los_Angeles"]],
  ["9am UTC +5:30 to PST", "convert", ["+05:30", "America/Los_Angeles"]],
  ["5pm ET", "convert", ["America/New_York"]],
  ["5pm to tokyo", "convert", ["home", "Asia/Tokyo"]],
  ["5pm in tokyo", "convert", ["Asia/Tokyo"]],
  ["5pm ET to PT, CET and tokyo", "convert", ["America/New_York", "America/Los_Angeles", "Europe/Berlin", "Asia/Tokyo"]],
  ["5 p.m. est → pst", "convert", ["America/New_York", "America/Los_Angeles"]],
  ["5pm est -> pst", "convert", ["America/New_York", "America/Los_Angeles"]],
  ["from et to pt 5pm", "convert", ["America/New_York", "America/Los_Angeles"]],
  ["17:00z to est", "convert", ["UTC", "America/New_York"]],
  ["what is 5pm et in london", "convert", ["America/New_York", "Europe/London"]],
  ["5pm local time to tokyo", "convert", ["home", "Asia/Tokyo"]],
  ["ET to PT", "diff", ["America/New_York", "America/Los_Angeles"]],
  ["et vs pt", "diff", ["America/New_York", "America/Los_Angeles"]],
  ["time difference between london and tokyo", "diff", ["Europe/London", "Asia/Tokyo"]],
  ["time difference between ET and PT", "diff", ["America/New_York", "America/Los_Angeles"]],
  ["how many hours ahead is tokyo", "diff", ["home", "Asia/Tokyo"]],
  ["how many hours is tokyo ahead of london", "diff", ["Europe/London", "Asia/Tokyo"]],
  ["london vs new york time", "diff", ["Europe/London", "America/New_York"]],
  ["london to kolkata time", "diff", ["Europe/London", "Asia/Kolkata"]],
  ["when does daylight savings go into effect", "dst", ["home"]],
  ["when does the time change", "dst", ["home"]],
  ["when do the clocks change", "dst", ["home"]],
  ["when does dst end", "dst", ["home"]],
  ["when do the clocks go back in the uk", "dst", ["Europe/London"]],
  ["daylight savings 2027", "dst", ["home"]],
  ["daylight saving melbourne", "dst", ["Australia/Melbourne"]],
  ["is it daylight savings time right now", "dst", ["home"]],
  ["spring forward 2027", "dst", ["home"]],
  ["fall back", "dst", ["home"]],
  ["dst start date germany", "dst", ["Europe/Berlin"]],
  ["when does daylight saving time start in australia", "dst", ["Australia/Sydney"]],
  ["does japan observe dst", "dst", ["Asia/Tokyo"]],
  ["zeitumstellung 2027", "dst", ["home"]],
  ["when does british summer time start", "dst", ["Europe/London"]],
  ["is it summer time in the uk", "dst", ["Europe/London"]],
];

test("positive queries resolve to the right intent and zones", () => {
  for (const [query, intent, zones] of POSITIVE) {
    const parsed = _internals.parse(query);
    assert.ok(parsed, query);
    assert.equal(parsed.intent, intent, query);
    assert.deepEqual(zonesOf(parsed), zones, query);
    assert.equal(slot.trigger(query), true, query);
  }
});

test("every example in the README triggers the slot", async () => {
  const readme = await readFile(path.join(pluginDir, "README.md"), "utf8");
  const table = readme.slice(readme.indexOf("## Triggers"), readme.indexOf("Times can be written"));
  const examples = [...table.matchAll(/^\| (.+?) \|/gm)].flatMap((m) => [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]));
  assert.ok(examples.length > 30);
  for (const query of examples) assert.equal(slot.trigger(query), true, query);
  for (const query of ["ct scan", "pt cruiser", "london to paris"]) assert.equal(slot.trigger(query), false, query);
});

test("times and dates can be written in several ways", () => {
  const forms = {
    "5:30 pm et to pt": [17, 30, ""],
    "5 p.m. et to pt": [17, 0, ""],
    "17h30 cet to et": [17, 30, ""],
    "1700z to et": [17, 0, ""],
    "1700 utc to et": [17, 0, ""],
    "noon et to pt": [12, 0, ""],
    "12 midnight et to pt": [0, 0, ""],
    "5pm et 8 november 2026 to pt": [17, 0, "abs:2026:11:8"],
    "5pm et on the 8th of november to pt": [17, 0, "abs::11:8"],
    "5pm et 2026-11-08 to pt": [17, 0, "abs:2026:11:8"],
    "5pm et next friday to pt": [17, 0, "wd:5:1"],
    "5pm et yesterday to pt": [17, 0, "rel:-1"],
  };
  for (const [query, [h, mi, date]] of Object.entries(forms)) {
    const parsed = _internals.parse(query);
    assert.ok(parsed, query);
    assert.deepEqual([parsed.h, parsed.mi, parsed.date], [h, mi, date], query);
  }
});

test("daylight saving questions carry direction, year and status", () => {
  const expect = {
    "when does daylight savings go into effect": { direction: "forward", year: 0, status: false },
    "when does dst end": { direction: "back", year: 0, status: false },
    "when does the time change": { direction: "any", year: 0, status: false },
    "spring forward 2027": { direction: "forward", year: 2027, status: false },
    "fall back": { direction: "back", year: 0, status: false },
    "is it daylight savings time right now": { direction: "any", year: 0, status: true },
    "daylight savings 2027": { direction: "any", year: 2027, status: false },
  };
  for (const [query, want] of Object.entries(expect)) {
    const { direction, year, status } = _internals.parse(query);
    assert.deepEqual({ direction, year, status }, want, query);
  }
});

const NEGATIVE = [
  "time in a bottle",
  "ct scan",
  "et phone home",
  "paris time lapse",
  "flight time to melbourne",
  "pt cruiser",
  "mt everest",
  "in time movie",
  "time zone converter app",
  "time magazine",
  "new york times",
  "est 1990 meaning",
  "utc meaning",
  "ist to english translation",
  "tokyo time attack",
  "central time zone map",
  "time",
  "tokyo",
  "london",
  "est",
  "now",
  "the time",
  "what time",
  "5pm",
  "noon",
  "9 to 5",
  "17:00 to 18:00",
  "24 hours in london",
  "midnight in paris",
  "noon in tokyo",
  "christmas time",
  "jersey time",
  "easter time",
  "monday in tokyo",
  "2026 in tokyo",
  "time to melbourne",
  "time in ct",
  "et time",
  "cat time",
  "time to eat",
  "art and cat",
  "london to paris",
  "london vs paris",
  "fall back plan",
  "spring forward meaning",
  "summertime",
  "summer time",
  "dst file",
  "time change calculator",
  "quelle heure est il a tokyo",
  "wie spät ist es in tokio",
  "5pm est 2026",
  "1700 est",
  "5 et",
  "e.t.",
  "how to change time zone on iphone",
  "",
  "x".repeat(121),
];

test("ordinary searches do not trigger the slot", () => {
  for (const query of NEGATIVE) {
    assert.equal(_internals.parse(query), null, query);
    assert.equal(slot.trigger(query), false, query);
  }
});

test("short queries follow the bare trigger setting", () => {
  configure({ bareTriggers: "false" });
  try {
    assert.equal(slot.trigger("melbourne time"), false);
    assert.equal(slot.trigger("time melbourne"), false);
    assert.equal(slot.trigger("london timezone"), false);
    assert.equal(slot.trigger("time in melbourne"), true);
    assert.equal(slot.trigger("eastern time"), true);
    assert.equal(slot.trigger("current time et"), true);
  } finally {
    configure();
  }
  assert.equal(slot.trigger("melbourne time"), true);
});

test("daylight saving transitions are found to the minute", () => {
  const future = (zone, now) => _internals.transitions(zone, at(now)).filter((change) => change.at > at(now));
  const iso = (change) => new Date(change.at).toISOString();
  assert.deepEqual(future("America/New_York", "2026-01-01T00:00:00Z").slice(0, 4).map(iso), [
    "2026-03-08T07:00:00.000Z",
    "2026-11-01T06:00:00.000Z",
    "2027-03-14T07:00:00.000Z",
  ]);
  assert.equal(iso(future("America/New_York", "2026-11-02T00:00:00Z")[1]), "2027-11-07T06:00:00.000Z");
  assert.deepEqual(future("Europe/London", "2026-01-01T00:00:00Z").slice(0, 3).map(iso), [
    "2026-03-29T01:00:00.000Z",
    "2026-10-25T01:00:00.000Z",
    "2027-03-28T01:00:00.000Z",
  ]);
  assert.deepEqual(future("Australia/Sydney", "2026-01-01T00:00:00Z").slice(0, 3).map(iso), [
    "2026-04-04T16:00:00.000Z",
    "2026-10-03T16:00:00.000Z",
    "2027-04-03T16:00:00.000Z",
  ]);
  assert.deepEqual(future("America/Santiago", "2026-01-01T00:00:00Z").slice(0, 2).map(iso), [
    "2026-04-05T03:00:00.000Z",
    "2026-09-06T04:00:00.000Z",
  ]);
  const lordHowe = future("Australia/Lord_Howe", "2026-07-01T00:00:00Z")[0];
  assert.equal(iso(lordHowe), "2026-10-03T15:30:00.000Z");
  assert.equal(lordHowe.to - lordHowe.from, 30);
  assert.deepEqual(future("Asia/Tokyo", "2026-01-01T00:00:00Z"), []);
  assert.deepEqual(future("America/Phoenix", "2026-01-01T00:00:00Z"), []);
  assert.deepEqual(_internals.yearTransitions("Europe/London", 2027).map(iso), [
    "2027-03-28T01:00:00.000Z",
    "2027-10-31T01:00:00.000Z",
  ]);
});

test("local times inside a clock change are resolved like Temporal's compatible mode", () => {
  const gap = _internals.localToInstant("America/New_York", 2026, 3, 8, 2, 30);
  assert.equal(gap.kind, "gap");
  assert.equal(new Date(gap.ms).toISOString(), "2026-03-08T07:30:00.000Z");
  const overlap = _internals.localToInstant("America/New_York", 2026, 11, 1, 1, 30);
  assert.equal(overlap.kind, "ambiguous");
  assert.equal(new Date(overlap.ms).toISOString(), "2026-11-01T05:30:00.000Z");
  const normal = _internals.localToInstant("Asia/Kolkata", 2026, 11, 1, 9, 0);
  assert.equal(new Date(normal.ms).toISOString(), "2026-11-01T03:30:00.000Z");
  const fixed = _internals.localToInstant("+05:30", 2026, 11, 2, 9, 0);
  assert.equal(new Date(fixed.ms).toISOString(), "2026-11-02T03:30:00.000Z");
});

test("dates default to today in the source zone and roll forward sensibly", () => {
  const now = at("2026-11-02T03:00:00Z"); // Sunday 10pm in New York, Monday noon in Tokyo
  assert.deepEqual(_internals.resolveDate("rel:0", "America/New_York", now, 17, 0), { y: 2026, m: 11, d: 1 });
  assert.deepEqual(_internals.resolveDate("rel:0", "Asia/Tokyo", now, 17, 0), { y: 2026, m: 11, d: 2 });
  assert.deepEqual(_internals.resolveDate("rel:1", "America/New_York", now, 17, 0), { y: 2026, m: 11, d: 2 });
  // Monday 5pm in New York is tomorrow; Sunday 5pm has already passed, so next week.
  assert.deepEqual(_internals.resolveDate("wd:1:0", "America/New_York", now, 17, 0), { y: 2026, m: 11, d: 2 });
  assert.deepEqual(_internals.resolveDate("wd:0:0", "America/New_York", now, 17, 0), { y: 2026, m: 11, d: 8 });
  assert.deepEqual(_internals.resolveDate("wd:0:0", "America/New_York", now, 23, 30), { y: 2026, m: 11, d: 1 });
  assert.deepEqual(_internals.resolveDate("abs::11:8", "America/New_York", now, 17, 0), { y: 2026, m: 11, d: 8 });
  assert.deepEqual(_internals.resolveDate("abs::3:1", "America/New_York", now, 17, 0), { y: 2027, m: 3, d: 1 });
  assert.equal(_internals.resolveDate("abs:2026:2:29", "America/New_York", now, 17, 0), null);
});

test("conversions respect each zone's daylight saving rules", async () => {
  let html = (await run("5pm ET to london", { now: at("2026-03-15T12:00:00Z") })).html;
  assert.equal(attr(html, "data-tz-at"), String(at("2026-03-15T21:00:00Z")));
  assert.equal(rowField(html, "target", "Europe/London", "time"), "9:00 PM");
  assert.equal(rowField(html, "target", "Europe/London", "abbr"), "GMT");
  assert.equal(rowField(html, "target", "Europe/London", "rel"), "4 hours ahead of Eastern Time");

  html = (await run("5pm ET to london", { now: at("2026-04-01T12:00:00Z") })).html;
  assert.equal(rowField(html, "target", "Europe/London", "time"), "10:00 PM");
  assert.equal(rowField(html, "target", "Europe/London", "abbr"), "BST");

  html = (await run("5pm ET nov 1 2026 to PT")).html;
  assert.equal(attr(html, "data-tz-at"), String(at("2026-11-01T22:00:00Z")));
  assert.equal(headline(html), "2:00 PMPST");
  assert.equal(rowField(html, "source", "America/New_York", "abbr"), "EST");

  html = (await run("9am utc+5:30 to pst", { now: at("2026-11-02T00:00:00Z") })).html;
  assert.equal(attr(html, "data-tz-at"), String(at("2026-11-02T03:30:00Z")));
  assert.equal(rowField(html, "target", "America/Los_Angeles", "time"), "7:30 PM");
  assert.equal(rowField(html, "target", "America/Los_Angeles", "date"), "Sun, Nov 1");
  assert.equal(rowField(html, "target", "America/Los_Angeles", "day"), "−1 day");
  assert.equal(rowField(html, "source", "+05:30", "label"), "UTC+5:30");

  html = (await run("5pm ET to PT, CET and tokyo")).html;
  assert.equal(rowField(html, "target", "Asia/Tokyo", "time"), "7:00 AM");
  assert.equal(rowField(html, "target", "Asia/Tokyo", "day"), "+1 day");
  assert.equal(rowField(html, "target", "Europe/Berlin", "time"), "11:00 PM");
  assert.equal(rowField(html, "target", "America/Los_Angeles", "rel"), "3 hours behind Eastern Time");
});

test("times that are skipped or repeated by a clock change get a note", async () => {
  let html = (await run("2:30am ET mar 8 2026 to utc")).html;
  assert.equal(rowField(html, "target", "UTC", "time"), "7:30 AM");
  assert.equal(rowField(html, "source", "America/New_York", "time"), "3:30 AM");
  assert.match(notes(html)[0], /^2:30 AM does not exist in Eastern Time on Sun, Mar 8, 2026.*Showing 3:30 AM EDT instead\.$/);

  html = (await run("1:30am ET nov 1 2026 to utc")).html;
  assert.equal(rowField(html, "target", "UTC", "time"), "5:30 AM");
  assert.match(notes(html)[0], /happens twice in Eastern Time.*back 1 hour/);
});

test("conversions without a target or source use the home time zone", async () => {
  let html = (await run("5pm to tokyo")).html;
  assert.equal(attr(html, "data-tz-home"), "1");
  assert.equal(attr(html, "data-tz-wall"), "17:00");
  assert.equal(rowField(html, "source", "America/New_York", "time"), "5:00 PM");
  assert.match(html, /data-tz-role="source" data-tz-zone="America\/New_York" data-tz-label="New York" data-tz-home="1"/);

  html = (await run("5pm in tokyo")).html;
  assert.match(html, /data-tz-role="target" data-tz-zone="America\/New_York" data-tz-label="New York" data-tz-home="1"/);
  assert.equal(rowField(html, "target", "America/New_York", "time"), "3:00 AM");
});

test("ambiguous abbreviations and places explain themselves", async () => {
  let html = (await run("convert 9am cet to ist")).html;
  assert.ok(notes(html).some((note) => /^IST was read as India Standard Time\. It can also mean Israel Time or Ireland Time\.$/.test(note)));

  html = (await run("5pm cst to et", { now: at("2026-07-01T12:00:00Z") })).html;
  assert.ok(notes(html).some((note) => note.startsWith("CST was read as Central Time. It can also mean China Standard Time")));
  assert.ok(notes(html).some((note) => note.startsWith("CST was read as Central Time, which is on CDT (UTC−5)")));

  html = (await run("5pm mst to et", { now: at("2026-01-15T12:00:00Z") })).html;
  assert.equal(notes(html).length, 0, "Phoenix matches Denver in winter, so no note");

  html = (await run("when does daylight saving time start in australia")).html;
  assert.ok(notes(html).some((note) => note.startsWith("Australia spans several time zones. Showing Sydney.")));

  html = (await run("what time is it in the usa")).html;
  for (const zone of ["America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"]) {
    assert.ok(html.includes(`data-tz-role="other" data-tz-zone="${zone}"`), zone);
  }
});

test("time differences handle fractional offsets and upcoming clock changes", async () => {
  const diff = async (query, now) => headline((await run(query, { now: at(now) })).html);
  assert.equal(await diff("london to kolkata time", "2026-11-01T12:00:00Z"), "Kolkata is 5.5 hours ahead of London");
  assert.equal(await diff("london to kolkata time", "2026-07-01T12:00:00Z"), "Kolkata is 4.5 hours ahead of London");
  assert.equal(await diff("la to kathmandu time", "2026-11-01T12:00:00Z"), "Kathmandu is 13.75 hours ahead of Los Angeles");
  assert.equal(await diff("new york to phoenix time", "2026-07-01T12:00:00Z"), "Phoenix is 3 hours behind New York");
  assert.equal(await diff("new york to phoenix time", "2026-12-01T12:00:00Z"), "Phoenix is 2 hours behind New York");
  assert.equal(await diff("ET to sydney", "2026-10-01T21:00:00Z"), "Sydney is 14 hours ahead of Eastern Time");
  assert.equal(await diff("ET to sydney", "2026-10-10T21:00:00Z"), "Sydney is 15 hours ahead of Eastern Time");
  assert.equal(await diff("ET to sydney", "2026-11-05T22:00:00Z"), "Sydney is 16 hours ahead of Eastern Time");
  assert.equal(await diff("how many hours ahead is tokyo", "2026-11-05T22:00:00Z"), "Tokyo is 14 hours ahead of New York");
  const html = (await run("ET to sydney", { now: at("2026-10-01T21:00:00Z") })).html;
  assert.deepEqual(notes(html), ["From Sun, Oct 4, 2026, Sydney will be 15 hours ahead of Eastern Time."]);
});

test("daylight saving panels show the next change, the one after and the current state", async () => {
  let html = (await run("when does dst end", { now: at("2026-10-31T12:00:00Z") })).html;
  assert.equal(headline(html), "Clocks go back 1 hour on Sunday, November 1, 2026");
  assert.match(html, /data-tz-dst-sub>2:00 AM → 1:00 AM local time · in 18 hours</);
  assert.deepEqual(dstRows(html), [
    ["Next change", "Sun, Nov 1, 2026 · Clocks go back 1 hour"],
    ["After that", "Sun, Mar 14, 2027 · Clocks go forward 1 hour"],
    ["Right now", "Daylight saving time · UTC−4, EDT"],
  ]);

  html = (await run("when does dst end", { now: at("2026-11-02T00:00:00Z") })).html;
  assert.equal(headline(html), "Clocks go back 1 hour on Sunday, November 7, 2027");

  html = (await run("daylight savings 2027 uk")).html;
  assert.equal(headline(html), "Clock changes in United Kingdom in 2027");
  assert.deepEqual(dstRows(html), [
    ["Sun, Mar 28, 2027", "Clocks go forward 1 hour · 1:00 AM → 2:00 AM local time"],
    ["Sun, Oct 31, 2027", "Clocks go back 1 hour · 2:00 AM → 1:00 AM local time"],
  ]);

  html = (await run("dst sydney")).html;
  assert.equal(headline(html), "Clocks go back 1 hour on Sunday, April 4, 2027");

  html = (await run("dst tokyo")).html;
  assert.equal(headline(html), "Tokyo does not use daylight saving time");
  assert.match(html, /data-tz-dst-sub>UTC\+9, JST all year</);

  html = (await run("is it dst now", { now: at("2026-11-01T05:00:00Z") })).html;
  assert.equal(headline(html), "Yes, daylight saving time is in effect in New York");
  html = (await run("is it dst now", { now: at("2026-11-01T07:00:00Z") })).html;
  assert.equal(headline(html), "No, New York is on standard time");
  html = (await run("does japan observe dst")).html;
  assert.equal(headline(html), "No, Japan does not use daylight saving time");

  html = (await run("dst lord howe", { now: at("2026-07-01T00:00:00Z") })).html;
  assert.equal(headline(html), "Clocks go forward 30 minutes on Sunday, October 4, 2026");
});

test("the current time panel describes the zone and compares it with home", async () => {
  const { title, html } = await run("current time melbourne");
  assert.equal(title, "Current time");
  assert.equal(attr(html, "data-tz-at"), "now");
  assert.equal(attr(html, "data-tz-zone"), "Australia/Melbourne");
  assert.match(html, /data-tz-fmt="time" data-tz-sec="1">11:00:00 PM</);
  assert.match(html, /data-tz-fmt="abbr">AEDT</);
  assert.match(html, /data-tz-fmt="long">Australian Eastern Daylight Time</);
  assert.match(html, /data-tz-fmt="offset">UTC\+11</);
  assert.match(html, /data-tz-fmt="dst">In effect until Sun, Apr 4, 2027</);
  assert.match(html, /16 hours ahead of New York/);
  assert.match(html, /data-tz-role="home" data-tz-zone="America\/New_York"[^>]*data-tz-home="1">/);
  assert.match(html, /data-tz-row="local"[^>]*hidden>/);
});

test("the home row and difference are hidden when the zone is the home zone", async () => {
  const { html } = await run("time in new york");
  assert.match(html, /data-tz-row="diff"[^>]* hidden>/);
  assert.match(html, /data-tz-role="home"[^>]* hidden>/);
});

test("a question about the time zone itself leads with the zone name", async () => {
  const { title, html } = await run("what time zone is dubai in");
  assert.equal(title, "Time zone");
  assert.equal(headline(html), "Gulf Standard Time");
});

test("the home time zone setting accepts ids, places and abbreviations", async () => {
  const homeOf = async (value) => {
    configure({ homeZone: value });
    try {
      return attr((await run("what time is it")).html, "data-tz-zone");
    } finally {
      configure();
    }
  };
  assert.equal(await homeOf("Europe/Berlin"), "Europe/Berlin");
  assert.equal(await homeOf("europe/berlin"), "Europe/Berlin");
  assert.equal(await homeOf("new york"), "America/New_York");
  assert.equal(await homeOf("EST"), "America/New_York");
  assert.equal(await homeOf("utc+5:30"), "+05:30");
  const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fallback = await homeOf("not a zone");
  assert.equal(fallback, await homeOf(""));
  assert.ok(fallback === "UTC" || new Intl.DateTimeFormat("en-US", { timeZone: fallback }).resolvedOptions().timeZone ===
    new Intl.DateTimeFormat("en-US", { timeZone: server }).resolvedOptions().timeZone);
});

test("clock format and seconds settings apply", async () => {
  configure({ timeFormat: "24h", showSeconds: "false" });
  try {
    const { html } = await run("current time melbourne");
    assert.match(html, /class="tz-clock" data-tz-fmt="time">23:00</);
    assert.equal(attr(html, "data-tz-clock"), "24h");
  } finally {
    configure();
  }
});

test("other languages format dates and phrases in that language", async () => {
  const { title, html } = await run("current time melbourne", { locale: "de-DE" });
  assert.equal(title, "Aktuelle Uhrzeit");
  assert.match(html, /Sonntag, 1\. November 2026/);
  assert.match(html, /16 Stunden vor New York/);
  const fr = await run("london to kolkata time", { locale: "fr-FR" });
  assert.equal(headline(fr.html), "Kolkata a 5,5 heures d’avance sur London");
  const bad = await run("current time melbourne", { locale: "not a locale!!" });
  assert.match(bad.html, /data-tz-locale="en"/);
});

test("rendered panels never leak template syntax or untranslated keys", async () => {
  const queries = [...POSITIVE.map(([query]) => query), "daylight savings 2027 uk", "is it dst now", "dst tokyo"];
  for (const query of queries) {
    for (const nojs of [false, true]) {
      const { title, html } = await run(query, { nojs });
      assert.ok(html.length > 0, query);
      assert.ok(title.length > 0, query);
      assert.ok(!html.includes("{{"), query);
      assert.ok(!/timezone\.[a-z]/.test(html), `${query}: ${html.match(/timezone\.[a-zA-Z.]+/)?.[0]}`);
      assert.ok(!/\{[a-z]+\}/.test(html), query);
    }
  }
});

test("no-JS panels leave out copy buttons, pending rows and the live clock", async () => {
  const { html } = await run("current time melbourne", { nojs: true });
  assert.ok(!html.includes("data-tz-copy="));
  assert.ok(!html.includes('data-tz-row="local"'));
  assert.equal(attr(html, "data-tz-at"), String(NOW));
  assert.equal(attr(html, "data-tz-browser"), "0");
  assert.ok(!html.includes('data-tz-sec="'));
});

test("the browser zone setting turns off the local row", async () => {
  configure({ browserZone: "false" });
  try {
    const { html } = await run("5pm ET to PT");
    assert.equal(attr(html, "data-tz-browser"), "0");
    assert.ok(!html.includes('data-tz-row="local"'));
  } finally {
    configure();
  }
});

test("escaping keeps markup and template syntax out of the panel", async () => {
  const original = slot.t;
  slot.t = (key, vars, locale) => (key === "timezone.labels.zone" ? '<b>"{{ t:x }}"</b>' : translator(key, vars, locale));
  try {
    const { html } = await run("current time melbourne");
    assert.ok(html.includes("&lt;b&gt;&quot;&#123;&#123; t:x }}&quot;&lt;/b&gt;"));
    assert.ok(!html.includes("<b>"));
  } finally {
    slot.t = original;
  }
});

test("a parse that cannot be rendered returns an empty panel instead of throwing", async () => {
  assert.deepEqual(await run("5pm et feb 29 to pt", { now: at("2026-03-01T12:00:00Z") }), { title: "", html: "" });
  assert.deepEqual(await run("no panel for this"), { title: "", html: "" });
});

test("trigger stays fast on long ordinary queries", () => {
  const started = performance.now();
  for (let i = 0; i < 2000; i++) {
    slot.trigger(`best pasta recipes with garlic and olive oil ${i}`);
    slot.trigger(`what time is it in tokyo ${i % 2 ? "now" : ""}`);
  }
  assert.ok(performance.now() - started < 1000);
});

// Fake Open-Meteo geocoder: records every request and answers from a small table.
const GEO = {
  "foster city": [
    { name: "Foster City", country_code: "US", country: "United States", admin1: "Michigan", timezone: "America/Menominee", feature_code: "PPL" },
    { name: "Foster City", country_code: "US", country: "United States", admin1: "California", timezone: "America/Los_Angeles", population: 33477, feature_code: "PPL" },
    { name: "Foster City Recreation Center", country_code: "US", admin1: "California", timezone: "America/Los_Angeles", feature_code: "PRK" },
  ],
  springfield: [
    { name: "Springfield", country_code: "US", admin1: "Missouri", timezone: "America/Chicago", population: 170188, feature_code: "PPLA2" },
    { name: "Springfield", country_code: "US", admin1: "Massachusetts", timezone: "America/New_York", population: 154341, feature_code: "PPL" },
    { name: "Springfield", country_code: "US", admin1: "Illinois", timezone: "America/Chicago", population: 114394, feature_code: "PPLA" },
  ],
  paris: [
    { name: "Paris", country_code: "US", admin1: "Texas", timezone: "America/Chicago", population: 24782, feature_code: "PPLA2" },
    { name: "Paris", country_code: "US", admin1: "Kentucky", timezone: "America/New_York", population: 9870, feature_code: "PPLA2" },
  ],
};

const geocoder = ({ fail = false } = {}) => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (fail) throw new Error("offline");
    const params = new URL(url).searchParams;
    const results = (GEO[params.get("name")] || []).filter((r) => !params.get("countryCode") || r.country_code === params.get("countryCode"));
    return { ok: true, json: async () => ({ results }) };
  };
  return { calls, fetch };
};

test("places that are not built in are looked up online by name only", async () => {
  const geo = geocoder();
  const zoneOf = async (query) => {
    const { html } = await run(query, { fetch: geo.fetch });
    return [attr(html, "data-tz-zone"), attr(html, "data-tz-label")];
  };
  assert.deepEqual(await zoneOf("Current time Foster City"), ["America/Los_Angeles", "Foster City, CA"]);
  assert.deepEqual(await zoneOf("Current time Foster City CA"), ["America/Los_Angeles", "Foster City, CA"]);
  assert.deepEqual(await zoneOf("Current time Springfield ma"), ["America/New_York", "Springfield, MA"]);
  assert.deepEqual(await zoneOf("what time is it in springfield, massachusetts"), ["America/New_York", "Springfield, MA"]);
  assert.deepEqual(await zoneOf("current time paris texas"), ["America/Chicago", "Paris, TX"]);
  assert.deepEqual(await zoneOf("what time is it in paris, texas"), ["America/Chicago", "Paris, TX"]);
  const list = _internals.parse("time in london, new york and tokyo");
  assert.deepEqual(list.zones.map((entry) => entry.zone), ["Europe/London", "America/New_York", "Asia/Tokyo"]);
  for (const url of geo.calls) {
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://geocoding-api.open-meteo.com/v1/search");
    assert.deepEqual([...parsed.searchParams.keys()].filter((k) => !["name", "count", "language", "format", "countryCode"].includes(k)), []);
    assert.ok(!/time|current|what/.test(parsed.searchParams.get("name")), url);
  }
  assert.equal(new URL(geo.calls[1]).searchParams.get("countryCode"), "US");
});

test("looked-up places work in conversions, differences and daylight saving questions", async () => {
  const geo = geocoder();
  let html = (await run("5pm et to foster city", { fetch: geo.fetch })).html;
  assert.equal(rowField(html, "target", "America/Los_Angeles", "time"), "2:00 PM");
  html = (await run("time difference between springfield il and tokyo", { fetch: geo.fetch })).html;
  assert.equal(headline(html), "Tokyo is 15 hours ahead of Springfield, IL");
  html = (await run("when does dst end in foster city", { fetch: geo.fetch, now: at("2026-10-31T12:00:00Z") })).html;
  assert.equal(headline(html), "Clocks go back 1 hour on Sunday, November 1, 2026");
  assert.equal(attr(html, "data-tz-zone"), "America/Los_Angeles");
});

test("ambiguous looked-up places name the alternatives in other zones", async () => {
  const { html } = await run("current time springfield", { fetch: geocoder().fetch });
  assert.equal(attr(html, "data-tz-label"), "Springfield, MO");
  assert.deepEqual(notes(html), ["Springfield was read as Springfield, MO. It can also mean Springfield, MA."]);
  const qualified = await run("current time springfield il", { fetch: geocoder().fetch });
  assert.equal(attr(qualified.html, "data-tz-label"), "Springfield, IL");
  assert.deepEqual(notes(qualified.html), []);
});

test("unknown places only trigger inside a clear time question", () => {
  for (const query of [
    "current time foster city",
    "what time is it in foster city",
    "5pm et to foster city",
    "5pm foster city to tokyo",
    "time difference between foster city and tokyo",
    "how many hours ahead is foster city",
    "when does dst end in foster city",
    "what time zone is foster city in",
  ]) {
    assert.equal(slot.trigger(query), true, query);
  }
  for (const query of [
    "foster city time",
    "time in foster city",
    "foster city",
    "5pm foster city",
    "5pm meeting",
    "current time foster city and springfield",
    "5pm foster city to springfield",
    "current time in a very long place name here",
    "flight time to foster city",
    "best restaurants in foster city",
  ]) {
    assert.equal(slot.trigger(query), false, query);
  }
});

test("trigger never makes a network request", () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    calls++;
    throw new Error("no network in trigger");
  };
  try {
    slot.trigger("current time foster city");
    slot.trigger("what time is it in springfield il");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});

test("a failed or empty lookup shows no panel, and results are cached", async () => {
  assert.deepEqual(await run("what time is it in heaven", { fetch: geocoder().fetch }), { title: "", html: "" });
  assert.deepEqual(await run("current time kalamazoo", { fetch: geocoder({ fail: true }).fetch }), { title: "", html: "" });
  assert.deepEqual(await run("current time zzyzx"), { title: "", html: "" }, "no fetch available");
  const retry = geocoder();
  await run("current time kalamazoo", { fetch: retry.fetch });
  assert.equal(retry.calls.length, 1, "network errors are not cached");
  const geo = geocoder();
  await run("current time paris kentucky", { fetch: geo.fetch });
  await run("current time paris kentucky", { fetch: geo.fetch });
  assert.equal(geo.calls.length, 1);
  assert.equal(attr((await run("current time paris kentucky", { fetch: geo.fetch })).html, "data-tz-label"), "Paris, KY");
});

test("the online lookup setting keeps every lookup on the server", async () => {
  configure({ onlineLookup: "false" });
  try {
    assert.equal(slot.trigger("current time foster city"), false);
    const geo = geocoder();
    const { html } = await run("current time paris texas", { fetch: geo.fetch });
    assert.equal(geo.calls.length, 0);
    assert.equal(attr(html, "data-tz-zone"), "America/Chicago");
    assert.equal(attr(html, "data-tz-label"), "Paris");
    assert.equal(slot.trigger("current time london ky"), false);
  } finally {
    configure();
  }
});

test("two looked-up places can be compared or converted when each is spelled out", async () => {
  const geo = geocoder();
  let html = (await run("springfield il time to foster city ca time", { fetch: geo.fetch })).html;
  assert.equal(headline(html), "Foster City, CA is 2 hours behind Springfield, IL");
  html = (await run("5pm springfield il to paris tx", { fetch: geo.fetch })).html;
  assert.equal(rowField(html, "source", "America/Chicago", "time"), "5:00 PM");
  assert.equal(attr(html, "data-tz-label"), "Springfield, IL");
  for (const query of ["springfield time to foster city time", "foster city ca time to tokyo", "foster city time to tokyo time", "foster city ca time vs tokyo time"]) {
    assert.equal(slot.trigger(query), true, query);
  }
  for (const query of [
    "5pm meeting to discuss",
    "springfield il to foster city ca",
    "springfield to foster city",
    "foster city time",
    "springfield time",
    "5pm springfield to foster city",
    "foster city time to tokyo",
    "drive time to foster city ca",
    "commute time to springfield il",
    "travel time to tokyo",
  ]) {
    assert.equal(slot.trigger(query), false, query);
  }
});

test("zones that change clocks on the same day get no change note", async () => {
  const html = (await run("ET to PT", { now: at("2027-03-10T12:00:00Z") })).html;
  assert.equal(headline(html), "Pacific Time is 3 hours behind Eastern Time");
  assert.deepEqual(notes(html), []);
  const london = (await run("ET to london", { now: at("2027-03-10T12:00:00Z") })).html;
  assert.deepEqual(notes(london), ["From Sun, Mar 14, 2027, London will be 4 hours ahead of Eastern Time."]);
});
