import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const pluginDir = path.resolve("plugins/orbis-patches");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const template = await readFile(path.join(pluginDir, "template.html"), "utf8");
const readme = await readFile(path.join(pluginDir, "README.md"), "utf8");
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

const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
const { slot, routes, _internals } = mod;

const API_BASE = "/api/plugin/example-degoog-extensions-orbis-patches";
const CDN = "https://cdn.orbispatches.com/titles/CUSA04762_0123abcd";
const FOUND = {
  success: true,
  metadata: {
    name: "Call of Duty®: Infinite Warfare",
    currentVersion: "01.25",
    region: "US",
    icon: `${CDN}/icon0.webp`,
    background: `${CDN}/pic0.webp`,
    latestPatch: { size: "19601817600" },
  },
};
const NOT_FOUND = { success: false, code: 2, message: "Title could not be found" };
const INVALID = { success: false, code: 1, message: "Provided Title ID is invalid" };
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A fake outgoing fetch: maps title ids to API bodies and CDN URLs to bytes, and records calls.
const fakeFetch = ({ titles = { CUSA04762: FOUND }, art = {}, fail = false } = {}) => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (fail) throw new Error("network down");
    const parsed = new URL(url);
    if (parsed.hostname === "orbispatches.com" && parsed.pathname === "/api/lookup") {
      const id = parsed.searchParams.get("titleid");
      return jsonResponse(titles[id] ?? (/^CUSA\d{5}$/.test(id) ? NOT_FOUND : INVALID));
    }
    if (url in art) return new Response(art[url], { status: 200 });
    return new Response("missing", { status: 404 });
  };
  fetcher.calls = calls;
  return fetcher;
};

const defaults = Object.fromEntries(slot.settingsSchema.map((field) => [field.key, field.default]));
const setup = ({ fetcher = fakeFetch(), apiBase = API_BASE, settings = {} } = {}) => {
  _internals.clearCaches();
  slot.t = translator;
  slot.init({ template, apiBase, fetch: fetcher });
  slot.configure({ ...defaults, ...settings });
  return fetcher;
};

const run = (query, context = {}) => slot.execute(query, { locale: "en-US", ...context });
const attr = (html, name) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
const artSrc = (html, kind) => html.match(new RegExp(`src="([^"]*)"[^>]*data-orbis-art="${kind}"`))?.[1] ?? null;
const row = (html, key) =>
  html.match(new RegExp(`data-orbis-row="${key}"><dt[^>]*>([^<]*)</dt><dd[^>]*>([^<]*)</dd>`))?.slice(1) ?? null;
const openHref = (html, kind) => html.match(new RegExp(`href="([^"]*)"[^>]*data-orbis-open="${kind}"`))?.[1] ?? null;
const artRoute = routes.find((route) => route.path === "/art");
const getArt = (query) => artRoute.handler(new Request(`http://degoog.test${API_BASE}/art?${query}`));

test("plugin shape matches the degoog slot contract", () => {
  assert.equal(typeof slot.name, "string");
  assert.equal(typeof slot.description, "string");
  assert.equal(typeof slot.trigger, "function");
  assert.equal(typeof slot.execute, "function");
  assert.equal(slot.position, "at-a-glance");
  assert.ok(slot.slotPositions.includes(slot.position));
  assert.equal(slot.isClientExposed, false);
  assert.equal(slot.supportsNojs, true);
  assert.equal(mod.default.slot, slot);
  assert.equal(mod.default.routes, routes);
  const reserved = ["disabled", "slotPosition", "slotSearchTypes", "priority", "score", "outgoingTransport"];
  for (const field of slot.settingsSchema) {
    assert.ok(!reserved.includes(field.key), field.key);
    assert.equal(typeof field.default, "string", field.key);
  }
});

test("art route matches the degoog plugin route contract", () => {
  assert.ok(artRoute);
  assert.equal(artRoute.method, "get");
  assert.equal(typeof artRoute.handler, "function");
  assert.equal(artRoute.rateLimit, true);
});

test("manifest lists the plugin", () => {
  const entry = manifest.plugins.find((plugin) => plugin.path === "plugins/orbis-patches");
  assert.ok(entry);
  assert.equal(entry.type, "slot");
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
});

test("locales share the same keys as en.json", () => {
  const keys = (obj, prefix = "") =>
    Object.entries(obj).flatMap(([key, value]) =>
      value && typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
    );
  const expected = keys(locales.en).sort();
  for (const [lang, bank] of Object.entries(locales)) assert.deepEqual(keys(bank).sort(), expected, lang);
});

test("triggers on PS4 title ids with or without the hyphen", () => {
  for (const query of ["CUSA04762", "CUSA-04762", "cusa04762", "cusa-04762", "Cusa-04762", "  CUSA04762  ", "CUSA00001"]) {
    assert.equal(slot.trigger(query), true, query);
  }
  assert.equal(_internals.parseQuery("cusa-04762"), "CUSA04762");
  assert.equal(_internals.parseQuery(" CUSA04762 "), "CUSA04762");
});

test("ignores anything that is not exactly a title id", () => {
  const negatives = [
    "",
    "cusa",
    "CUSA",
    "04762",
    "CUSA4762",
    "CUSA047620",
    "CUSA 04762",
    "CUSA--04762",
    "CUSA_04762",
    "CUSA-04762-00",
    "CUSA04762 patch",
    "patch CUSA04762",
    "CUSA04762 CUSA00001",
    "PPSA01284",
    "PCAS00001",
    "PLJS00001",
    "BCUS98174",
    "CUSAO4762",
    "CUSA٠٤٧٦٢",
    "https://orbispatches.com/CUSA04762",
  ];
  for (const query of negatives) assert.equal(slot.trigger(query), false, query);
  assert.equal(slot.trigger(null), false);
  assert.equal(slot.trigger(undefined), false);
  assert.equal(slot.trigger(4762), false);
});

test("renders the title name, page link and art for an exact match", async () => {
  const fetcher = setup();
  const { title, html } = await run("CUSA-04762");
  assert.deepEqual(fetcher.calls, ["https://orbispatches.com/api/lookup?titleid=CUSA04762", `${CDN}/logo.webp`]);
  assert.equal(title, "", "no panel header");
  assert.equal(attr(html, "data-orbis-id"), "CUSA04762");
  assert.match(html, /<a class="orbis-name" href="https:\/\/orbispatches\.com\/CUSA04762" data-orbis-link>Call of Duty®: Infinite Warfare<\/a>/);
  assert.match(html, /href="https:\/\/orbispatches\.com\/CUSA04762" data-orbis-more>View patches on ORBISPatches/);
  assert.equal(artSrc(html, "icon"), `${API_BASE}/art?id=CUSA04762&amp;kind=icon`);
  assert.equal(artSrc(html, "background"), `${API_BASE}/art?id=CUSA04762&amp;kind=background`);
  assert.match(html, /alt="Call of Duty®: Infinite Warfare icon"/);
  for (const kind of ["icon", "background"]) {
    assert.equal(openHref(html, kind), artSrc(html, kind), `${kind} links to its own image`);
    assert.match(html, new RegExp(`target="_blank" rel="noopener noreferrer" aria-label="[^"]+" title="[^"]+" data-orbis-open="${kind}"`));
  }
  assert.match(html, /aria-label="Open the icon"/);
  assert.match(html, /aria-label="Open the background art"/);
  assert.equal(openHref(html, "logo"), null);
  assert.ok(!html.includes("cdn.orbispatches.com"), "art must go through the server");
  assert.deepEqual(row(html, "region"), ["Region", "US"]);
  assert.deepEqual(row(html, "version"), ["Current Version", "01.25"]);
  assert.deepEqual(row(html, "patchSize"), ["Latest patch", "18.26 GB"]);
  assert.ok(!html.includes("{{"), "no template placeholders leak");
  assert.ok(!/\borbis\.[a-z]/i.test(html), "no untranslated keys leak");
});

test("hyphenated and plain queries share one lookup", async () => {
  const fetcher = setup();
  const [a, b] = await Promise.all([run("CUSA04762"), run("cusa-04762")]);
  assert.equal(a.html, b.html);
  await run("CUSA04762");
  assert.equal(fetcher.calls.filter((url) => url.includes("/api/lookup")).length, 1);
});

test("translates its own strings", async () => {
  setup();
  const { html } = await run("CUSA04762", { locale: "de-DE" });
  assert.match(html, />Patches auf ORBISPatches ansehen/);
  assert.deepEqual(row(html, "version"), ["Aktuelle Version", "01.25"]);
  const [label, size] = row(html, "patchSize");
  assert.equal(label, "Neuester Patch");
  assert.match(size, /^18,26\sGB$/u);
});

test("escapes text from the API", async () => {
  const hostile = {
    success: true,
    metadata: {
      name: '<img src=x onerror="alert(1)"> {{ t:orbis.title }} & co',
      region: "<b>US</b>",
      currentVersion: '01.00"',
      icon: `${CDN}/icon0.webp`,
    },
  };
  setup({ fetcher: fakeFetch({ titles: { CUSA00001: hostile } }) });
  const { html } = await run("CUSA00001");
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<b>"));
  assert.ok(!html.includes("{{"));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &#123;&#123; t:orbis\.title }} &amp; co/);
  assert.match(html, /&lt;b&gt;US&lt;\/b&gt;/);
  assert.match(html, /01\.00&quot;/);
});

test("shows no panel for unknown, invalid or failed lookups", async () => {
  setup();
  assert.equal((await run("CUSA99999")).html, "");
  setup({ fetcher: fakeFetch({ titles: { CUSA12345: INVALID } }) });
  assert.equal((await run("CUSA12345")).html, "");
  setup({ fetcher: fakeFetch({ titles: { CUSA12345: { success: true, metadata: { name: "  " } } } }) });
  assert.equal((await run("CUSA12345")).html, "");
  setup({ fetcher: fakeFetch({ fail: true }) });
  assert.equal((await run("CUSA04762")).html, "");
  setup({ fetcher: async () => new Response("oops", { status: 500 }) });
  assert.equal((await run("CUSA04762")).html, "");
  setup({ fetcher: async () => new Response("<html>", { status: 200 }) });
  assert.equal((await run("CUSA04762")).html, "");
  assert.equal((await run("not a title id")).html, "");
});

test("caches misses but retries after a failure", async () => {
  let fetcher = setup();
  await run("CUSA99999");
  await run("CUSA99999");
  assert.equal(fetcher.calls.length, 1, "a missing title is cached");

  fetcher = setup({ fetcher: fakeFetch({ fail: true }) });
  await run("CUSA04762");
  await run("CUSA04762");
  assert.equal(fetcher.calls.length, 2, "a failed lookup is not cached");
});

test("prefers the request's fetch over the one from init", async () => {
  const initFetch = setup();
  const requestFetch = fakeFetch();
  const { html } = await run("CUSA04762", { fetch: requestFetch });
  assert.notEqual(html, "");
  assert.equal(initFetch.calls.length, 0);
  assert.equal(requestFetch.calls.length, 2, "lookup and logo check");
});

test("drops art that is not on the ORBISPatches CDN", async () => {
  const offsite = {
    success: true,
    metadata: { ...FOUND.metadata, icon: "https://example.com/icon0.webp", background: "http://cdn.orbispatches.com/pic0.webp" },
  };
  setup({ fetcher: fakeFetch({ titles: { CUSA04762: offsite } }) });
  const { html } = await run("CUSA04762");
  assert.notEqual(html, "");
  assert.equal(artSrc(html, "icon"), null);
  assert.equal(artSrc(html, "background"), null);
});

test("settings hide the icon, background and details", async () => {
  setup({ settings: { showIcon: "false" } });
  let { html } = await run("CUSA04762");
  assert.equal(artSrc(html, "icon"), null);
  assert.equal(openHref(html, "icon"), null);
  assert.ok(artSrc(html, "background"));

  setup({ settings: { showBackground: "false" } });
  ({ html } = await run("CUSA04762"));
  assert.ok(artSrc(html, "icon"));
  assert.equal(artSrc(html, "background"), null);
  assert.ok(!html.includes("orbis-banner"));

  setup({ settings: { showDetails: "false" } });
  ({ html } = await run("CUSA04762"));
  assert.ok(!html.includes("orbis-details"));
  assert.match(html, /Call of Duty/);

  setup({ settings: { showIcon: "nonsense", showBackground: "", showDetails: undefined } });
  ({ html } = await run("CUSA04762"));
  assert.ok(artSrc(html, "icon") && artSrc(html, "background") && html.includes("orbis-details"));
});

test("omits details the API leaves out", async () => {
  const sparse = { success: true, metadata: { name: "Sparse Game", latestPatch: { size: null } } };
  setup({ fetcher: fakeFetch({ titles: { CUSA00002: sparse } }) });
  const { html } = await run("CUSA00002");
  assert.match(html, /Sparse Game/);
  assert.ok(!html.includes("orbis-details"));
  assert.equal(artSrc(html, "icon"), null);
});

test("renders without art when degoog gives no route base", async () => {
  setup({ apiBase: "" });
  const { html } = await run("CUSA04762");
  assert.match(html, /Call of Duty/);
  assert.ok(!html.includes("data-orbis-art"));
});

test("prefixes art URLs with the DEGOOG_BASE_URL path", async (t) => {
  const before = process.env.DEGOOG_BASE_URL;
  t.after(() => {
    if (before === undefined) delete process.env.DEGOOG_BASE_URL;
    else process.env.DEGOOG_BASE_URL = before;
  });
  setup();
  process.env.DEGOOG_BASE_URL = "https://search.example.com/degoog/";
  let { html } = await run("CUSA04762");
  assert.equal(artSrc(html, "icon"), `/degoog${API_BASE}/art?id=CUSA04762&amp;kind=icon`);
  process.env.DEGOOG_BASE_URL = "https://search.example.com";
  ({ html } = await run("CUSA04762"));
  assert.equal(artSrc(html, "icon"), `${API_BASE}/art?id=CUSA04762&amp;kind=icon`);
});

test("renders the same panel on the no-JS page", async () => {
  setup();
  const { html } = await run("CUSA04762", { nojs: true });
  assert.match(html, /Call of Duty/);
  assert.ok(artSrc(html, "icon"));
});

test("art route serves the CDN image with a sniffed content type", async () => {
  const fetcher = setup({ fetcher: fakeFetch({ art: { [`${CDN}/icon0.webp`]: WEBP, [`${CDN}/pic0.webp`]: WEBP } }) });
  const response = await getArt("id=CUSA04762&kind=icon");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), WEBP);
  assert.equal((await getArt("id=CUSA04762&kind=background")).status, 200);
  await getArt("id=CUSA04762&kind=icon");
  assert.deepEqual(fetcher.calls, [
    "https://orbispatches.com/api/lookup?titleid=CUSA04762",
    `${CDN}/icon0.webp`,
    `${CDN}/pic0.webp`,
  ]);
});

test("art route rejects bad input and non-images", async () => {
  setup({ fetcher: fakeFetch({ art: { [`${CDN}/icon0.webp`]: new TextEncoder().encode("<html>not an image</html>") } }) });
  assert.equal((await getArt("id=CUSA-04762&kind=icon")).status, 400);
  assert.equal((await getArt("id=cusa04762&kind=icon")).status, 400);
  assert.equal((await getArt("id=CUSA04762&kind=banner")).status, 400);
  assert.equal((await getArt("id=CUSA04762")).status, 400);
  assert.equal((await getArt("kind=icon")).status, 400);
  assert.equal((await getArt("id=CUSA99999&kind=icon")).status, 404);
  assert.equal((await getArt("id=CUSA04762&kind=icon")).status, 502);
  assert.equal((await getArt("id=CUSA04762&kind=background")).status, 502);
});

test("art route only fetches CDN URLs and respects the settings", async () => {
  const offsite = { success: true, metadata: { ...FOUND.metadata, icon: "https://example.com/icon0.webp" } };
  const fetcher = setup({ fetcher: fakeFetch({ titles: { CUSA04762: offsite } }) });
  assert.equal((await getArt("id=CUSA04762&kind=icon")).status, 404);
  assert.ok(!fetcher.calls.some((url) => url.includes("example.com")));

  setup({ settings: { showIcon: "false", showBackground: "false" } });
  assert.equal((await getArt("id=CUSA04762&kind=icon")).status, 404);
  assert.equal((await getArt("id=CUSA04762&kind=background")).status, 404);

  _internals.clearCaches();
  slot.init({ template, apiBase: API_BASE });
  slot.configure(defaults);
  assert.equal((await getArt("id=CUSA04762&kind=icon")).status, 503);
});

test("overlays the logo on the banner when the title has one", async () => {
  const fetcher = setup({ fetcher: fakeFetch({ art: { [`${CDN}/logo.webp`]: WEBP } }) });
  let { html } = await run("CUSA04762");
  assert.equal(artSrc(html, "logo"), `${API_BASE}/art?id=CUSA04762&amp;kind=logo`);
  assert.match(
    html,
    /<div class="orbis-banner"><a class="orbis-banner-link"[^>]*><img [^>]*data-orbis-art="background"><\/a><a class="orbis-logo-link"[^>]*><img class="orbis-logo"[^>]*data-orbis-art="logo"><\/a><\/div>/,
  );
  assert.equal(openHref(html, "logo"), artSrc(html, "logo"));
  ({ html } = await run("CUSA04762"));
  assert.ok(artSrc(html, "logo"));
  assert.equal(fetcher.calls.filter((url) => url.endsWith("/logo.webp")).length, 1, "the logo check is cached");

  const response = await getArt("id=CUSA04762&kind=logo");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(fetcher.calls.filter((url) => url.endsWith("/logo.webp")).length, 1, "the route reuses the cached bytes");
});

test("leaves the logo out when the title has none", async () => {
  const fetcher = setup();
  await run("CUSA04762");
  const { html } = await run("CUSA04762");
  assert.equal(artSrc(html, "logo"), null);
  assert.ok(artSrc(html, "background"));
  assert.equal(fetcher.calls.filter((url) => url.endsWith("/logo.webp")).length, 1, "a missing logo is cached");
  assert.equal((await getArt("id=CUSA04762&kind=logo")).status, 502);
});

test("retries the logo check after a failure", async () => {
  let failLogo = true;
  const base = fakeFetch({ art: { [`${CDN}/logo.webp`]: WEBP } });
  const fetcher = async (url, init) => {
    if (failLogo && url.endsWith("/logo.webp")) throw new Error("network down");
    return base(url, init);
  };
  setup({ fetcher });
  assert.equal(artSrc((await run("CUSA04762")).html, "logo"), null);
  failLogo = false;
  assert.ok(artSrc((await run("CUSA04762")).html, "logo"));
});

test("logo settings skip the logo check", async () => {
  for (const settings of [{ showLogo: "false" }, { showBackground: "false" }]) {
    const fetcher = setup({ fetcher: fakeFetch({ art: { [`${CDN}/logo.webp`]: WEBP } }), settings });
    const { html } = await run("CUSA04762");
    assert.notEqual(html, "");
    assert.equal(artSrc(html, "logo"), null, JSON.stringify(settings));
    assert.ok(!fetcher.calls.some((url) => url.endsWith("/logo.webp")), JSON.stringify(settings));
    assert.equal((await getArt("id=CUSA04762&kind=logo")).status, 404, JSON.stringify(settings));
  }
});

test("finds the logo next to the icon on the CDN", () => {
  assert.equal(_internals.logoNextTo(`${CDN}/icon0.webp`), `${CDN}/logo.webp`);
  assert.equal(_internals.logoNextTo("https://example.com/titles/x/icon0.webp"), null);
  assert.equal(_internals.logoNextTo(`${CDN}/icon0.png`), null);
  assert.equal(_internals.logoNextTo(null), null);
  const withLogo = _internals.parseLookup("CUSA04762", { success: true, metadata: { ...FOUND.metadata, logo: `${CDN}/custom-logo.webp` } });
  assert.equal(withLogo.art.logo, `${CDN}/custom-logo.webp`);
  const offsite = _internals.parseLookup("CUSA04762", { success: true, metadata: { name: "X", icon: "https://example.com/icon0.webp" } });
  assert.equal(offsite.art.logo, null);
});

test("sniffs image types and formats sizes", () => {
  assert.equal(_internals.sniffImage(WEBP), "image/webp");
  assert.equal(_internals.sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(_internals.sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(_internals.sniffImage(new TextEncoder().encode("<svg></svg>")), null);
  assert.equal(_internals.sniffImage(new Uint8Array()), null);
  assert.equal(_internals.formatSize(19601817600, "en-US"), "18.26 GB");
  assert.equal(_internals.formatSize(1572864, "en-US"), "1.5 MB");
});

test("README examples trigger", () => {
  const examples = [...readme.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
  assert.ok(examples.length >= 2);
  for (const example of examples) assert.equal(slot.trigger(example), true, example);
});
