import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const pluginDir = path.resolve("plugins/qr-scanner");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const template = await readFile(path.join(pluginDir, "template.html"), "utf8");
const readme = await readFile(path.join(pluginDir, "README.md"), "utf8");
const LANGS = ["en", "de", "fr", "it"];
const locales = Object.fromEntries(
  await Promise.all(
    LANGS.map(async (lang) => [lang, JSON.parse(await readFile(path.join(pluginDir, "locales", `${lang}.json`), "utf8"))]),
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

// Mirrors degoog's {{ t:key }} pass over command HTML (it inserts the translation as is).
const translatePlaceholders = (html, locale = "en") =>
  html.replace(/\{\{\s*t:([\w.]+)\s*\}\}/g, (_, key) => translator(key, undefined, locale));

const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
const { slot, routes, _internals } = mod;
const command = mod.default;

const API_BASE = "/api/plugin/example-degoog-extensions-qr-scanner";
const signed = [];
const signProxyUrl = (url) => {
  signed.push(url);
  return `/api/proxy/image?url=${encodeURIComponent(url)}&sig=test`;
};
const ctx = {
  template,
  apiBase: API_BASE,
  signProxyUrl,
  readFile: (name) => readFile(path.join(pluginDir, name), "utf8"),
};
slot.t = translator;
slot.init(ctx);
command.init(ctx);
const defaults = Object.fromEntries(slot.settingsSchema.map((field) => [field.key, field.default]));
const configure = (overrides = {}) => slot.configure({ ...defaults, ...overrides });
configure();

const render = async (query, locale = "en-US") => (await slot.execute(query, { locale })).html;
const attr = (html, name) => {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  return match ? match[1] : null;
};
const unescape = (text) =>
  text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#123;/g, "{").replace(/&amp;/g, "&");

const route = (p) => routes.find((r) => r.path === p);
const call = (p, query = "") => route(p).handler(new Request(`http://localhost${API_BASE}${p}${query}`));

// ---- Triggers ----

const POSITIVE = [
  "qr",
  "QR",
  "qr code",
  "QR Code",
  "qrcode",
  "qr codes",
  "qr scanner",
  "qr reader",
  "qr code reader",
  "qr code scanner",
  "QR-Code Scanner",
  "scan qr",
  "scan qr code",
  "scan a qr code",
  "read qr code",
  "read qr code from image",
  "decode qr",
  "qr decoder",
  "qr code reader online",
  "qr code scanner?",
  "qr-code scannen",
  "qr code lesen",
  "lire code qr",
  "lecteur qr code",
  "lettore codice qr",
  "leggi codice qr",
  "scansiona qr",
  "qr https://example.com/code.png",
  "scan qr https://example.com/code.png",
  "https://example.com/code.png qr",
  "qr code reader https://example.com/code.png.",
  "qr data:image/png;base64,iVBORw0KGgo=",
];

const NEGATIVE = [
  "",
  "   ",
  "qr code generator",
  "qr code for wifi",
  "qr code for https://example.com",
  "generate qr code",
  "what is a qr code",
  "how do qr codes work",
  "qrcode menu",
  "qr code menu restaurant",
  "free qr code",
  "qr code online",
  "scanner",
  "code reader",
  "barcode scanner",
  "document scanner",
  "qr ftp://example.com/code.png",
  "qr javascript:alert(1)",
  "qr file:///etc/passwd",
  "qr https://example.com/a.png https://example.com/b.png",
  "qr https://user:pass@example.com/a.png",
  "https://example.com/code.png",
  "scan https://example.com/code.png",
  "code qr ar",
  "qr code scanner app for android",
];

test("triggers on QR scanner queries", () => {
  for (const query of POSITIVE) assert.equal(slot.trigger(query), true, query);
});

test("ignores other queries", () => {
  for (const query of NEGATIVE) assert.equal(slot.trigger(query), false, query);
  assert.equal(slot.trigger(undefined), false);
  assert.equal(slot.trigger("qr ".repeat(20)), false);
});

test("keeps the case of URLs and strips sentence punctuation after them", () => {
  assert.deepEqual(_internals.parseQuery("QR https://Example.com/Codes/QR.PNG"), {
    url: "https://example.com/Codes/QR.PNG",
    bare: false,
  });
  assert.equal(_internals.parseQuery("qr reader https://example.com/a.png?x=1).").url, "https://example.com/a.png?x=1");
  assert.equal(_internals.parseQuery("qr code").bare, true);
  assert.equal(_internals.parseQuery("scan qr").bare, false);
});

test("a plain qr can be turned off without disabling explicit forms", () => {
  configure({ bareQr: "false" });
  try {
    for (const query of ["qr", "qr code", "QR Code", "qrcode"]) assert.equal(slot.trigger(query), false, query);
    for (const query of ["qr scanner", "scan qr code", "qr https://example.com/code.png"]) {
      assert.equal(slot.trigger(query), true, query);
    }
  } finally {
    configure();
  }
});

test("settings are parsed defensively", async () => {
  configure({ bareQr: "nonsense" });
  assert.equal(slot.trigger("qr"), true);
  slot.configure({});
  assert.equal(slot.trigger("qr"), true);
  configure({ imageUrls: "maybe" });
  assert.equal(slot.trigger("qr https://example.com/code.png"), true);
  configure();
});

test("no grammar word is also a keyword", () => {
  // A filler that is also a keyword would let generic searches trigger without a QR word.
  const src = _internals;
  assert.ok(src.parseQuery("the") === null);
  assert.ok(src.parseQuery("scan") === null);
  assert.ok(src.parseQuery("code") === null);
});

// ---- Rendering ----

test("renders the empty scanner panel", async () => {
  const result = await slot.execute("qr code scanner", { locale: "en-US" });
  assert.equal(result.title, "QR Code Scanner");
  const html = result.html;
  assert.match(html, /data-qrscan-card/);
  assert.equal(attr(html, "data-qrscan-src"), "");
  const sign = unescape(attr(html, "data-qrscan-sign"));
  assert.ok(sign.startsWith(`${API_BASE}/image?t=s.`), sign);
  assert.equal(_internals.checkToken(new URL(`http://localhost${sign}`).searchParams.get("t")), "s");
  assert.equal(attr(html, "data-qrscan-decoder"), `${API_BASE}/decoder.js?v=1.0.0`);
  assert.match(attr(html, "data-qrscan-key"), /^[0-9a-z]+-[0-9a-z]+$/);
  assert.equal(attr(html, "data-qrscan-msg-nocode"), locales.en.qrscan.status.noCode);
  assert.equal(attr(html, "data-qrscan-msg-foundmany"), "Found {count} QR codes.");
  assert.match(html, /type="file" accept="image\/\*"/);
  assert.match(html, /Drop, paste or browse for an image of a QR code/);
  assert.doesNotMatch(html, /\{\{/);
  assert.doesNotMatch(html, /qrscan\.\w/);
});

test("signs URLs from the query through degoog's image proxy", async () => {
  const html = await render("qr https://example.com/Code.png");
  const src = unescape(attr(html, "data-qrscan-src"));
  assert.equal(src, `/api/proxy/image?url=${encodeURIComponent("https://example.com/Code.png")}&sig=test`);
  assert.equal(attr(html, "value"), "https://example.com/Code.png");
});

test("passes data URLs through without the proxy", async () => {
  signed.length = 0;
  const data = "data:image/png;base64,iVBORw0KGgo=";
  const html = await render(`qr ${data}`);
  assert.equal(attr(html, "data-qrscan-src"), data);
  assert.equal(attr(html, "value"), "");
  assert.equal(signed.length, 0);
});

test("escapes URLs, including degoog's {{ }} syntax", async () => {
  const url = 'https://example.com/a.png?q="><script>{{t:qrscan.title}}';
  assert.equal(slot.trigger(`qr ${url}`), true);
  const html = await render(`qr ${url}`);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /\{\{/);
  assert.doesNotMatch(html, /"><script/);
  assert.match(unescape(attr(html, "value")), /^https:\/\/example\.com\/a\.png\?q=/);
});

test("translates the panel with the request locale", async () => {
  const html = await render("qr code lesen", "de-DE");
  assert.match(html, /Bild eines QR-Codes ablegen, einfügen oder auswählen/);
  assert.equal(attr(html, "data-qrscan-msg-copy"), "Kopieren");
  const fallback = await render("qr code", "xx-YY");
  assert.match(fallback, /Drop, paste or browse/);
});

test("execute returns no panel for queries that do not trigger", async () => {
  assert.deepEqual(await slot.execute("qr code generator", { locale: "en" }), { title: "", html: "" });
  configure({ bareQr: "false" });
  try {
    assert.equal((await slot.execute("qr", { locale: "en" })).html, "");
  } finally {
    configure();
  }
});

test("adds DEGOOG_BASE_URL's path to route URLs", async () => {
  const previous = process.env.DEGOOG_BASE_URL;
  process.env.DEGOOG_BASE_URL = "https://search.example.com/degoog/";
  try {
    const html = await render("qr");
    assert.ok(unescape(attr(html, "data-qrscan-sign")).startsWith(`/degoog${API_BASE}/image?t=`));
  } finally {
    if (previous === undefined) delete process.env.DEGOOG_BASE_URL;
    else process.env.DEGOOG_BASE_URL = previous;
  }
});

// ---- Command ----

test("the default export is a valid command and the slot and routes are named exports", () => {
  assert.equal(typeof command.name, "string");
  assert.equal(command.trigger, "qrscan");
  assert.deepEqual(command.aliases, ["qrread", "qrdecode"]);
  assert.equal(typeof command.execute, "function");
  assert.equal(command.naturalLanguagePhrases, undefined);
  assert.equal(command.isClientExposed, false);
  // The official QR generator owns "qr" and "qrcode".
  assert.ok(![command.trigger, ...command.aliases].some((name) => ["qr", "qrcode"].includes(name)));
  assert.equal(typeof slot.trigger, "function");
  assert.equal(slot.position, "at-a-glance");
  assert.equal(slot.isClientExposed, false);
  assert.ok(Array.isArray(routes) && routes.length === 2);
  assert.equal(mod.default.slot, undefined, "default.slot would make the slot registry and command registry disagree");
});

test("the bang opens an empty scanner without arguments", async () => {
  const result = await command.execute("", {});
  // degoog does not translate placeholders in command titles, so the title is plain text.
  assert.equal(result.title, "QR Code Scanner");
  const html = translatePlaceholders(result.html);
  assert.match(html, /^<div class="command-result qrscan-command">/);
  assert.equal(attr(html, "data-qrscan-src"), "");
  assert.match(html, /Drop, paste or browse/);
  assert.doesNotMatch(html, /\{\{|qrscan\.\w/);
});

test("the bang scans an image URL", async () => {
  const result = await command.execute("https://example.com/Code.png", { signProxyUrl });
  const html = translatePlaceholders(result.html);
  assert.equal(
    unescape(attr(html, "data-qrscan-src")),
    `/api/proxy/image?url=${encodeURIComponent("https://example.com/Code.png")}&sig=test`,
  );
  const spaced = translatePlaceholders((await command.execute("  scan https://example.com/a.png, please", {})).html);
  assert.match(unescape(attr(spaced, "data-qrscan-src")), /url=https%3A%2F%2Fexample\.com%2Fa\.png&/);
});

test("the bang explains arguments that are not image URLs", async () => {
  const html = translatePlaceholders((await command.execute("hello {{ t:qrscan.title }}", {})).html);
  assert.equal(attr(html, "data-qrscan-src"), "");
  assert.equal(attr(html, "data-qrscan-kind"), "error");
  assert.match(html, /isn’t an image URL/);
  assert.equal(unescape(attr(html, "value")), "hello {{ t:qrscan.title }}");
  assert.doesNotMatch(html, /hello \{\{/);
  const ftp = translatePlaceholders((await command.execute("ftp://example.com/a.png", {})).html);
  assert.equal(attr(ftp, "data-qrscan-src"), "");
});

// ---- Routes ----

test("serves the vendored decoder", async () => {
  _internals.resetDecoder();
  const response = await call("/decoder.js", "?v=1.0.0");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/javascript/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("cache-control"), /max-age=\d+/);
  const body = await response.text();
  assert.equal(body, await readFile(path.join(pluginDir, "vendor", "jsQR.js"), "utf8"));
  assert.equal(route("/decoder.js").rateLimit, true);
  assert.equal(route("/decoder.js").method, "get");
});

/** The sign URL of a freshly rendered panel, with its token. */
const panelSign = async (query = "qr scanner") => unescape(attr(await render(query), "data-qrscan-sign"));
const callSigned = async (sign, value) => {
  const url = new URL(`http://localhost${sign}`);
  url.searchParams.set("url", value);
  return route("/image").handler(new Request(url));
};

test("redirects pasted image URLs to the signed proxy with the panel's token", async () => {
  const response = await callSigned(await panelSign(), "https://example.com/Q.png");
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    `/api/proxy/image?url=${encodeURIComponent("https://example.com/Q.png")}&sig=test`,
  );
  assert.equal(route("/image").rateLimit, true);
  assert.equal(route("/image").method, "get");
  const bang = attr(translatePlaceholders((await command.execute("", {})).html), "data-qrscan-sign");
  assert.equal((await callSigned(unescape(bang), "https://example.com/Q.png")).status, 302);
});

test("the image route is not an open proxy: it needs a valid, unexpired token", async () => {
  const url = encodeURIComponent("https://example.com/Q.png");
  assert.equal((await call("/image", `?url=${url}`)).status, 403);
  const token = new URL(`http://localhost${await panelSign()}`).searchParams.get("t");
  const forged = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  for (const t of [forged, `c${token.slice(1)}`, "s.zzzzzzzz.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "", "garbage"]) {
    assert.equal((await call("/image", `?t=${encodeURIComponent(t)}&url=${url}`)).status, 403, t);
  }
  const old = _internals.issueToken("s", Date.now() - 2 * 3600 * 1000);
  assert.equal(_internals.checkToken(old), null, "tokens expire after an hour");
  assert.equal(_internals.checkToken(_internals.issueToken("c")), "c");
});

test("turning off image links stops signing and leaves link queries alone", async () => {
  configure({ imageUrls: "false" });
  try {
    assert.equal(slot.trigger("qr https://example.com/code.png"), false);
    assert.equal(slot.trigger("scan qr code"), true);
    assert.equal(slot.trigger(`qr data:image/png;base64,iVBORw0KGgo=`), true, "data URLs need no proxy");
    const html = await render("qr scanner");
    assert.equal(attr(html, "data-qrscan-sign"), "");
    assert.equal(attr(html, "data-qrscan-msg-urlsoff"), locales.en.qrscan.status.urlsOff);
    const token = _internals.issueToken("s");
    const response = await call("/image", `?t=${token}&url=${encodeURIComponent("https://example.com/Q.png")}`);
    assert.equal(response.status, 404);
  } finally {
    configure();
  }
  command.configure({ imageUrls: "false" });
  try {
    const html = translatePlaceholders((await command.execute("https://example.com/Q.png", { signProxyUrl })).html);
    assert.equal(attr(html, "data-qrscan-src"), "");
    assert.equal(attr(html, "data-qrscan-sign"), "");
    assert.match(html, /Scanning image links is turned off/);
    assert.equal(attr(html, "value"), "https://example.com/Q.png");
    assert.equal(slot.trigger("qr https://example.com/code.png"), true, "the slot keeps its own setting");
  } finally {
    command.configure({ imageUrls: "true" });
  }
});

test("refuses anything else on the image route", async () => {
  const sign = await panelSign();
  for (const value of [
    "",
    "ftp://example.com/a.png",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:image/png;base64,AAAA",
    "https://user:pw@example.com/a.png",
    `https://example.com/${"a".repeat(3000)}`,
    "not a url",
  ]) {
    const response = await callSigned(sign, value);
    assert.equal(response.status, 400, value);
  }
});

// ---- Files, locales, docs ----

test("vendors an unmodified jsQR 1.4.0 with its licence", async () => {
  const source = await readFile(path.join(pluginDir, "vendor", "jsQR.js"));
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859",
  );
  const licence = await readFile(path.join(pluginDir, "vendor", "LICENSE"), "utf8");
  assert.match(licence, /Apache License\s+Version 2\.0/);
  // Never sent on every page: script.js stays small and only loads the decoder on demand.
  const script = await stat(path.join(pluginDir, "script.js"));
  assert.ok(script.size < 40 * 1024);
});

const keyPaths = (bank, prefix = "") =>
  Object.entries(bank).flatMap(([key, value]) =>
    value && typeof value === "object" ? keyPaths(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );

const strings = (bank) =>
  Object.values(bank).flatMap((value) => (value && typeof value === "object" ? strings(value) : [value]));

test("every locale has the same keys as English", () => {
  const expected = keyPaths(locales.en).sort();
  for (const lang of LANGS) assert.deepEqual(keyPaths(locales[lang]).sort(), expected, lang);
});

test("locale strings are safe to insert into HTML unescaped", () => {
  // Commands use {{ t:… }} placeholders, which degoog fills in without escaping.
  for (const lang of LANGS) {
    for (const value of strings(locales[lang])) assert.doesNotMatch(value, /[<>"&]|\{\{/, `${lang}: ${value}`);
  }
});

test("is listed in the Store manifest", () => {
  const entry = manifest.plugins.find((p) => p.path === "plugins/qr-scanner");
  assert.ok(entry);
  assert.equal(entry.type, "slot");
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
});

test("README trigger examples trigger", () => {
  const cells = [...readme.matchAll(/^\| (`[^|]+) \|/gm)].map((m) => m[1]);
  const examples = cells.flatMap((cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  assert.ok(examples.length >= 4);
  for (const example of examples) {
    if (example.startsWith("!")) continue;
    assert.equal(slot.trigger(example), true, example);
  }
});

// ---- SVG markup and raw base64 ----

const b64 = (text) => Buffer.from(text, "latin1").toString("base64");
const PNG_B64 = b64(`\x89PNG\r\n\x1a\n${"\0".repeat(32)}`);
const JPEG_B64 = b64(`\xff\xd8\xff\xe0${"\0".repeat(32)}`);
const GIF_B64 = b64(`GIF89a${"\0".repeat(32)}`);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><path d="M0 0h7v7H0z"/></svg>';
const svgFrom = (url) => Buffer.from(url.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");

test("reads raw base64 PNG, JPEG and GIF data in the query", () => {
  assert.equal(_internals.parseQuery(`qr ${PNG_B64}`).url, `data:image/png;base64,${PNG_B64}`);
  assert.equal(_internals.parseQuery(`scan qr ${JPEG_B64}`).url, `data:image/jpeg;base64,${JPEG_B64}`);
  assert.equal(_internals.parseQuery(`${GIF_B64} qr code reader`).url, `data:image/gif;base64,${GIF_B64}`);
  assert.equal(_internals.parseQuery(`qr ${b64(`GIF87a${"\0".repeat(32)}`)}`).url.slice(0, 22), "data:image/gif;base64,");
  const urlSafe = b64(`\xff\xd8\xff\xe0${"\xfb\xff".repeat(20)}`).replace(/\+/g, "-").replace(/\//g, "_");
  assert.match(_internals.parseQuery(`qr ${urlSafe}`).url, /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/);
  assert.equal(_internals.parseQuery(`qr ${PNG_B64}`).bare, false);
});

test("ignores base64 that is not an image, too short, or alone", () => {
  for (const query of [
    `qr ${b64("This is a long piece of plain text, not an image at all.")}`,
    "qr iVBORw0KGgo",
    PNG_B64,
    `scan ${PNG_B64}`,
    `qr ${PNG_B64} ${GIF_B64}`,
    `qr ${PNG_B64} https://example.com/a.png`,
    "qr abcdefghijklmnopqrstuvwxyzabcdefgh",
  ]) {
    assert.equal(slot.trigger(query), false, query.slice(0, 60));
  }
});

test("reads SVG markup in the query", () => {
  const parsed = _internals.parseQuery(`scan qr ${SVG}`);
  assert.match(parsed.url, /^data:image\/svg\+xml;base64,/);
  assert.equal(svgFrom(parsed.url), SVG);
  const declared = `<?xml version="1.0" encoding="UTF-8"?> <!-- generator --> ${SVG.replace("<path", "<title>Ünïcödé ✓</title><path")}`;
  assert.equal(svgFrom(_internals.parseQuery(`qr ${declared}`).url), declared);
  for (const query of [SVG, `qr code generator ${SVG}`, "qr <svg> never closed", `qr ${SVG} ${PNG_B64}`]) {
    assert.equal(slot.trigger(query), false, query.slice(0, 60));
  }
});

test("renders SVG and base64 sources as data URLs without the proxy", async () => {
  signed.length = 0;
  const html = await render(`qr ${GIF_B64}`);
  assert.equal(attr(html, "data-qrscan-src"), `data:image/gif;base64,${GIF_B64}`);
  assert.equal(attr(html, "value"), "");
  const svgHtml = await render(`qr ${SVG.replace("<path", "<desc>{{ t:qrscan.title }} \"<b>\"</desc><path")}`);
  assert.match(attr(svgHtml, "data-qrscan-src"), /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
  assert.doesNotMatch(svgHtml, /\{\{|<desc>/);
  assert.equal(signed.length, 0);
});

test("the bang reads SVG markup and base64, including base64 with line breaks", async () => {
  const src = async (args) => attr(translatePlaceholders((await command.execute(args, {})).html), "data-qrscan-src");
  assert.equal(svgFrom(await src(`  ${SVG}  `)), SVG);
  assert.equal(await src(PNG_B64), `data:image/png;base64,${PNG_B64}`);
  assert.equal(await src(JPEG_B64.replace(/(.{16})/g, "$1\n")), `data:image/jpeg;base64,${JPEG_B64}`);
  assert.equal(await src(`decode this ${GIF_B64}`), `data:image/gif;base64,${GIF_B64}`);
  assert.equal(await src(b64("Some plain words that are long enough to look like base64.")), "");
});

// ---- Review regressions ----

test("parsing hostile queries stays linear", () => {
  const time = (query) => {
    const start = performance.now();
    slot.trigger(query);
    _internals.parseQuery(query);
    return performance.now() - start;
  };
  for (const unit of ["<svg ", "<!-- ", "<?xml ", "<!-- --> ", "</svg>", "A"]) {
    const small = time(`qr ${unit.repeat(20000)}`);
    const big = time(`qr ${unit.repeat(160000)}`);
    // 8x the input: linear work takes ~8x as long. Allow plenty of noise, but not the 64x of quadratic work.
    assert.ok(big < Math.max(50, small * 25), `${JSON.stringify(unit)}: ${small.toFixed(1)} ms → ${big.toFixed(1)} ms`);
  }
  const huge = `qr ${"<svg ".repeat(800000)}`;
  const start = performance.now();
  slot.trigger(huge);
  assert.ok(performance.now() - start < 1500, "a 4 MB query is handled in well under a second or two");
});

test("trigger() never encodes SVG markup", () => {
  const original = globalThis.btoa;
  let calls = 0;
  globalThis.btoa = (value) => {
    calls += 1;
    return original(value);
  };
  try {
    assert.equal(slot.trigger(`scan qr ${SVG}`), true);
    assert.equal(calls, 0);
    _internals.parseQuery(`scan qr ${SVG}`);
    assert.equal(calls, 1);
  } finally {
    globalThis.btoa = original;
  }
});

test("a link only means 'scan this' when it points at an image or the query says scan", () => {
  for (const query of [
    "qr code https://example.com",
    "qr https://example.com/",
    "qr code https://example.com/page.html",
    "qrcode https://example.com/menu?table=4",
  ]) {
    assert.equal(slot.trigger(query), false, query);
  }
  for (const query of [
    "qr code https://example.com/logo.PNG",
    "qr https://example.com/a.jpeg?size=2",
    "qr https://example.com/a.svg#top",
    "scan qr https://example.com/",
    "qr reader https://api.example.com/v1/qr?data=hello",
  ]) {
    assert.equal(slot.trigger(query), true, query);
  }
});

test("keeps brackets that belong to the URL and drops the ones that don't", () => {
  assert.equal(_internals.trimUrl("https://host/img_(1)"), "https://host/img_(1)");
  assert.equal(_internals.trimUrl("https://host/img_(1))"), "https://host/img_(1)");
  assert.equal(_internals.trimUrl("https://host/img_(1)."), "https://host/img_(1)");
  assert.equal(_internals.trimUrl("https://host/a[0].png]"), "https://host/a[0].png");
  assert.equal(_internals.trimUrl("https://host/a.png),"), "https://host/a.png");
  assert.equal(_internals.parseQuery("scan qr https://host/img_(1)").url, "https://host/img_(1)");
});

test("findSvgMarkup finds markup and its prolog", () => {
  const find = (text) => {
    const found = _internals.findSvgMarkup(text);
    return found && text.slice(found.start, found.end);
  };
  assert.equal(find(`qr ${SVG} please`), SVG);
  const prolog = '<?xml version="1.0"?>\n<!-- a -->\n<!DOCTYPE svg>\n';
  assert.equal(find(`qr ${prolog}${SVG}`), `${prolog}${SVG}`);
  assert.equal(find(`<!-- unfinished ${SVG}`), SVG);
  assert.equal(find("<svgx></svgx>"), null);
  assert.equal(find("</svg><svg>"), null);
  assert.equal(find("<SVG\nviewBox='0 0 1 1'></SVG>"), "<SVG\nviewBox='0 0 1 1'></SVG>");
});

test("the shared core in script.js matches index.js", async () => {
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
  const index = await readFile(path.join(pluginDir, "index.js"), "utf8");
  const script = await readFile(path.join(pluginDir, "script.js"), "utf8");
  assert.equal(block(script), block(index));
});

test("each search gets its own carry-over key", async () => {
  const key = async (query) => attr(await render(query), "data-qrscan-key");
  assert.equal(await key("qr scanner"), await key("qr scanner"));
  assert.notEqual(await key("qr scanner"), await key("scan qr code"));
  const bangKey = attr((await command.execute("", {})).html, "data-qrscan-key");
  assert.notEqual(bangKey, await key("qr scanner"));
});
