import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const pluginDir = path.resolve("plugins/timestamp");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const template = await readFile(path.join(pluginDir, "template.html"), "utf8");
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

const { slot } = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
slot.t = translator;
slot.init({ template });

const defaults = Object.fromEntries(slot.settingsSchema.map((field) => [field.key, field.default]));
const configure = (overrides = {}) => slot.configure({ ...defaults, ...overrides });
configure();

const run = (query, context = {}) => slot.execute(query, { locale: "en-US", ...context });

const attr = (html, name) => {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
};

const field = (html, name) => {
  const match = html.match(new RegExp(`data-tstamp-field="${name}"[^>]*>([^<]*)<`));
  return match ? match[1] : null;
};

test("plugin shape matches the degoog slot contract", () => {
  assert.equal(typeof slot.name, "string");
  assert.equal(typeof slot.trigger, "function");
  assert.equal(typeof slot.execute, "function");
  assert.equal(slot.isClientExposed, false);
  assert.equal(slot.position, "at-a-glance");
  assert.ok(slot.slotPositions.includes(slot.position));
  assert.equal(slot.supportsNojs, true);
  for (const fieldDef of slot.settingsSchema) {
    assert.ok(lookup(locales.en, `timestamp.settings.${fieldDef.key}.label`), fieldDef.key);
  }
});

test("store manifest lists the plugin as a slot with a semantic version", () => {
  const entry = manifest.plugins.find((item) => item.path === "plugins/timestamp");
  assert.ok(entry);
  assert.equal(entry.type, "slot");
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
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

test("triggers on timestamp-like queries", () => {
  const positives = [
    "1700000000",
    " 1700000000 ",
    "1700000000000",
    "1700000000123456",
    "1700000000123456789",
    "-1700000000",
    "1700000000.5",
    "@86400",
    "2024-01-15",
    "2024-01-15T10:30:00Z",
    "2024-01-15 10:30",
    "2024-01-15T10:30:00.123+02:00",
    "timestamp",
    "unix timestamp",
    "epoch time now",
    "current unix time",
    "what is the unix timestamp?",
    "epoch converter",
    "unix 1700000000",
    "epoch 86400",
    "timestamp 1,700,000,000",
    "1700000000 to date",
    "1700000000 to human readable",
    "1700000000000 ms",
    "epoch ms 1700000000000",
    "unix time 15 jan 2024 10:30 utc",
    "epoch for March 3, 2021",
    "13.07.2025 to unix time",
    "01/15/2024 timestamp",
    "Mon, 15 Jan 2024 10:30:00 +0000 to epoch",
    "zeitstempel 1700000000",
    "horodatage",
    "timestamp -> 1700000000",
  ];
  for (const query of positives) assert.equal(slot.trigger(query), true, query);
});

test("stays quiet on unrelated queries", () => {
  const negatives = [
    "",
    "12345678",
    "123",
    "2024",
    "5 ms",
    "-86400",
    "unix",
    "unix commands",
    "epoch games",
    "timestamp format sql",
    "sql timestamp column",
    "time in tokyo",
    "what time is it",
    "2024-13-45",
    "2024-02-30",
    "phone 555 0100",
    "3.14159",
    "1700000000 + 5",
    "100 usd to eur",
    "x".repeat(200),
    "https://example.com/1700000000",
  ];
  for (const query of negatives) assert.equal(slot.trigger(query), false, query);
});

test("converts a seconds timestamp to UTC, ISO and milliseconds", async () => {
  const { title, html } = await run("1700000000");
  assert.equal(title, "Unix timestamp");
  assert.equal(attr(html, "data-tstamp-mode"), "number");
  assert.equal(attr(html, "data-tstamp-ms"), "1700000000000");
  assert.equal(attr(html, "data-tstamp-live"), "false");
  assert.equal(field(html, "iso"), "2023-11-14T22:13:20Z");
  assert.equal(field(html, "seconds"), "1700000000");
  assert.equal(field(html, "millis"), "1700000000000");
  assert.match(html, /Tuesday, November 14, 2023 at 10:13:20\s?PM UTC/);
  assert.match(html, /ISO week 46 · day 318 of 2023/);
  assert.match(html, /years? ago|last year/);
  assert.ok(html.includes('data-tstamp-field="local"'), "local row present for JS clients");
  assert.ok(html.includes("data-tstamp-copy="), "copy buttons present for JS clients");
  assert.doesNotMatch(html, /\{\{/);
  assert.doesNotMatch(html, /timestamp\.[a-z]/i);
});

test("guesses milliseconds, microseconds and nanoseconds from digit count", async () => {
  const ms = await run("1700000000123");
  assert.equal(attr(ms.html, "data-tstamp-ms"), "1700000000123");
  assert.equal(field(ms.html, "iso"), "2023-11-14T22:13:20.123Z");
  assert.match(ms.html, /Unit guessed from the number of digits: milliseconds/);

  const us = await run("1700000000123456");
  assert.equal(attr(us.html, "data-tstamp-ms"), "1700000000123");
  assert.match(us.html, />microseconds</);

  const ns = await run("1700000000123456789");
  assert.equal(attr(ns.html, "data-tstamp-ms"), "1700000000123");
  assert.match(ns.html, />nanoseconds</);
});

test("unit words and the @ prefix override the guess", async () => {
  const forcedMs = await run("1700000000 ms");
  assert.equal(attr(forcedMs.html, "data-tstamp-ms"), "1700000000");
  assert.doesNotMatch(forcedMs.html, /Unit guessed/);

  const forcedSeconds = await run("epoch 1700000000000 s");
  assert.equal(attr(forcedSeconds.html, "data-tstamp-ms"), "1700000000000000");

  const at = await run("@86400");
  assert.equal(field(at.html, "iso"), "1970-01-02T00:00:00Z");

  const grouped = await run("timestamp 1,700,000,000");
  assert.equal(attr(grouped.html, "data-tstamp-ms"), "1700000000000");
});

test("handles negative and fractional seconds", async () => {
  const negative = await run("epoch -86400");
  assert.equal(field(negative.html, "iso"), "1969-12-31T00:00:00Z");

  const bareNegative = await run("-1700000000");
  assert.equal(field(bareNegative.html, "iso"), "1916-02-18T01:46:40Z");

  const fractional = await run("1700000000.5");
  assert.equal(attr(fractional.html, "data-tstamp-ms"), "1700000000500");
  assert.equal(field(fractional.html, "seconds"), "1700000000");
});

test("reports out-of-range values instead of crashing", async () => {
  const { html } = await run("timestamp 99999999999999 s");
  assert.match(html, /outside the range/);
  assert.equal(attr(html, "data-tstamp-ms"), "");
});

test("converts ISO dates to timestamps and flags assumed UTC", async () => {
  const dateOnly = await run("2024-01-15");
  assert.equal(attr(dateOnly.html, "data-tstamp-mode"), "date");
  assert.equal(field(dateOnly.html, "seconds"), "1705276800");
  assert.match(dateOnly.html, /read as UTC/);

  const zoned = await run("2024-01-15T10:30:00Z");
  assert.equal(field(zoned.html, "seconds"), "1705314600");
  assert.doesNotMatch(zoned.html, /read as UTC/);

  const offset = await run("2024-01-15T10:30:00+02:00");
  assert.equal(field(offset.html, "seconds"), "1705307400");

  const fractional = await run("2024-01-15T10:30:00.250Z");
  assert.equal(field(fractional.html, "millis"), "1705314600250");
});

test("parses keyword dates in several written forms", async () => {
  const cases = [
    ["unix time 15 jan 2024 10:30 utc", "1705314600"],
    ["epoch for January 15, 2024", "1705276800"],
    ["epoch for Jan 15th 2024 10:30 pm", "1705357800"],
    ["13.07.2025 to unix time", "1752364800"],
    ["01/15/2024 timestamp", "1705276800"],
    ["15/01/2024 timestamp", "1705276800"],
    ["Mon, 15 Jan 2024 10:30:00 +0000 to epoch", "1705314600"],
    ["2024/01/15 timestamp", "1705276800"],
  ];
  for (const [query, seconds] of cases) {
    const { html } = await run(query);
    assert.equal(attr(html, "data-tstamp-mode"), "date", query);
    assert.equal(field(html, "seconds"), seconds, query);
  }
});

test("rejects impossible dates even with a keyword", () => {
  assert.equal(slot.trigger("epoch 2024-02-30"), false);
  assert.equal(slot.trigger("timestamp 31 feb 2024"), false);
  assert.equal(slot.trigger("timestamp 2024-01-15 25:00"), false);
  assert.equal(slot.trigger("timestamp 2024-01-15 13:00 pm"), false);
});

test("renders a live counter for keyword-only queries", async () => {
  const before = Math.floor(Date.now() / 1000);
  const { title, html } = await run("unix timestamp");
  const after = Math.floor(Date.now() / 1000);
  assert.equal(title, "Current Unix timestamp");
  assert.equal(attr(html, "data-tstamp-mode"), "now");
  assert.equal(attr(html, "data-tstamp-live"), "true");
  const seconds = Number(field(html, "seconds"));
  assert.ok(seconds >= before && seconds <= after, `${seconds} within [${before}, ${after}]`);
  assert.match(html, /Right now/);
});

test("nojs rendering drops the local row and copy buttons", async () => {
  const { html } = await run("1700000000", { nojs: true });
  assert.doesNotMatch(html, /data-tstamp-field="local"/);
  assert.doesNotMatch(html, /data-tstamp-copy/);
  assert.equal(field(html, "iso"), "2023-11-14T22:13:20Z");
});

test("extra time zones are validated and rendered", async () => {
  configure({ extraTimeZones: "America/New_York, Not/AZone, UTC, Europe/Berlin" });
  const { html } = await run("1700000000");
  assert.match(html, /data-tstamp-zone="America\/New_York"/);
  assert.match(html, /data-tstamp-zone="Europe\/Berlin"/);
  assert.doesNotMatch(html, /Not\/AZone/);
  assert.match(html, /Tuesday, November 14, 2023 at 5:13:20\s?PM EST/);
  assert.match(html, /Tuesday, November 14, 2023 at 11:13:20\s?PM GMT\+1/);
  configure();
});

test("clock format setting switches between 12 and 24 hour output", async () => {
  configure({ timeFormat: "24h" });
  const h24 = await run("1700000000");
  assert.match(h24.html, /22:13:20 UTC/);
  configure({ timeFormat: "12h" });
  const h12 = await run("1700000000", { locale: "de-DE" });
  assert.match(h12.html, /10:13:20\s?PM UTC/);
  configure();
});

test("bare triggers can be switched off while keywords keep working", () => {
  configure({ bareNumbers: "false", bareDates: "false" });
  assert.equal(slot.trigger("1700000000"), false);
  assert.equal(slot.trigger("2024-01-15"), false);
  assert.equal(slot.trigger("@1700000000"), true);
  assert.equal(slot.trigger("epoch 1700000000"), true);
  assert.equal(slot.trigger("timestamp 2024-01-15"), true);
  configure();
});

test("formats with the request locale and survives bad locale tags", async () => {
  const de = await run("1700000000", { locale: "de-DE" });
  assert.match(de.html, /Dienstag, 14\. November 2023 um 22:13:20 UTC/);
  assert.match(de.html, /ISO-Woche 46 · Tag 318 von 2023/);
  assert.equal(de.title, "Unix-Zeitstempel");

  const fr = await run("2024-01-15", { locale: "fr" });
  assert.match(fr.html, /lundi 15 janvier 2024/);
  assert.match(fr.html, /lue en UTC/);

  const broken = await run("1700000000", { locale: "not a locale!!" });
  assert.equal(field(broken.html, "iso"), "2023-11-14T22:13:20Z");

  const missing = await run("1700000000", {});
  assert.equal(field(missing.html, "iso"), "2023-11-14T22:13:20Z");
});

test("escapes anything that could be interpreted as markup or template syntax", async () => {
  configure({ extraTimeZones: "Europe/Berlin" });
  const { html } = await run("1700000000");
  assert.doesNotMatch(html, /<script/i);
  configure();
  assert.equal(slot.trigger('timestamp <script>alert(1)</script>'), false);
  assert.equal(slot.trigger("epoch {{ t:core.foo }}"), false);
});

test("unit words after a keyword override the digit-count guess", async () => {
  const millis = await run("epoch millis 1700000000");
  assert.equal(attr(millis.html, "data-tstamp-ms"), "1700000000");
  assert.equal(field(millis.html, "iso"), "1970-01-20T16:13:20Z");

  const seconds = await run("epoch seconds 1700000000000");
  assert.equal(attr(seconds.html, "data-tstamp-ms"), "1700000000000000");
  assert.doesNotMatch(seconds.html, /Unit guessed/);

  const unixSeconds = await run("unix seconds 1700000000000");
  assert.equal(attr(unixSeconds.html, "data-tstamp-ms"), "1700000000000000");

  const micros = await run("epoch micros 1700000000");
  assert.equal(attr(micros.html, "data-tstamp-ms"), "1700000");

  const now = await run("epoch ms");
  assert.equal(attr(now.html, "data-tstamp-mode"), "now");
});

test("contractions are not mistaken for a seconds unit", async () => {
  const straight = await run("what's the epoch 1700000000");
  assert.equal(attr(straight.html, "data-tstamp-ms"), "1700000000000");

  const curly = await run("what’s the unix timestamp 1700000000000");
  assert.equal(attr(curly.html, "data-tstamp-ms"), "1700000000000");
  assert.match(curly.html, /Unit guessed from the number of digits: milliseconds/);

  assert.equal(slot.trigger("it's epoch 1700000000"), true);
});

test("micro sign units are recognised, spaced or attached", async () => {
  for (const query of ["1700000000 µs", "1700000000 μs", "1700000000µs", "epoch 1700000000 us"]) {
    const { html } = await run(query);
    assert.equal(attr(html, "data-tstamp-ms"), "1700000", query);
    assert.match(html, />microseconds</, query);
  }
  const attachedMs = await run("1700000000000ms");
  assert.equal(attr(attachedMs.html, "data-tstamp-ms"), "1700000000000");
});

test("weak keywords need a timestamp-sized number or an explicit unit", async () => {
  for (const query of ["in time 2011", "unix 101", "back in time 1985", "unix 2038", "86400 to date"]) {
    assert.equal(slot.trigger(query), false, query);
  }
  assert.equal(slot.trigger("unix 1700000000"), true);
  assert.equal(slot.trigger("1700000000 to date"), true);
  const unitized = await run("unix 101 s");
  assert.equal(field(unitized.html, "iso"), "1970-01-01T00:01:41Z");
  assert.equal(slot.trigger("epoch 101"), true);
});

test("years 0 to 99 are not shifted into the 1900s", async () => {
  const fifty = await run("0050-01-01");
  assert.equal(field(fifty.html, "seconds"), String(Date.parse("0050-01-01T00:00:00Z") / 1000));
  assert.match(fifty.html, /day 1 of 50/);

  const keyworded = await run("timestamp 15 jan 0099 12:00 utc");
  assert.equal(field(keyworded.html, "seconds"), String(Date.parse("0099-01-15T12:00:00Z") / 1000));

  const ms = -61000000000000;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const yearStart = Date.parse(`${String(year).padStart(4, "0")}-01-01T00:00:00Z`);
  const expectedDay = Math.floor((ms - yearStart) / 86400000) + 1;
  const ancient = await run("@-61000000000");
  assert.match(ancient.html, new RegExp(`day ${expectedDay} of ${year}<`));

  const weekOf = (html) => html.match(/ISO week (\d+)/)[1];
  for (const day of ["01-01", "01-04", "06-15", "12-28", "12-31"]) {
    const early = await run(`0050-${day}`);
    const shifted = await run(`2450-${day}`);
    assert.equal(weekOf(early.html), weekOf(shifted.html), day);
  }
});

test("an explicit UTC or GMT in a keyword date is honoured", async () => {
  const cases = [
    "15 jan 2024 10:30 utc timestamp",
    "15 jan 2024 10:30 gmt timestamp",
    "utc 15 jan 2024 10:30 timestamp",
    "timestamp for 2024-01-15 10:30 gmt",
  ];
  for (const query of cases) {
    const { html } = await run(query);
    assert.equal(field(html, "seconds"), "1705314600", query);
    assert.doesNotMatch(html, /read as UTC/, query);
  }
  const unzoned = await run("15 jan 2024 10:30 timestamp");
  assert.match(unzoned.html, /read as UTC/);
});

test("numbers with a unit work without a keyword, whatever the bare-number toggle says", async () => {
  for (const toggle of ["true", "false"]) {
    configure({ bareNumbers: toggle });
    const ms = await run("1700000000000 ms");
    assert.equal(attr(ms.html, "data-tstamp-ms"), "1700000000000", toggle);
    const seconds = await run("1700000000 s");
    assert.equal(attr(seconds.html, "data-tstamp-ms"), "1700000000000", toggle);
    assert.equal(slot.trigger("5 ms"), false, toggle);
    assert.equal(slot.trigger("86400 s"), false, toggle);
    assert.equal(slot.trigger("epoch 86400 s"), true, toggle);
  }
  configure();
});

test("all three panel types render the same row set in their own order", async () => {
  const order = (html) => [...html.matchAll(/data-tstamp-field="(\w+)"/g)].map((m) => m[1]).slice(1);
  configure({ extraTimeZones: "Asia/Tokyo" });
  assert.deepEqual(order((await run("1700000000")).html), ["local", "iso", "seconds", "millis", "zone"]);
  assert.deepEqual(order((await run("2024-01-15")).html), ["millis", "iso", "zone", "local", "zone"]);
  assert.deepEqual(order((await run("unix timestamp")).html), ["millis", "iso", "zone", "local", "zone"]);
  configure();
});
