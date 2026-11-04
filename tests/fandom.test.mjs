import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const pluginDir = path.resolve("plugins/fandom");
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
const { slot, _internals } = mod;

// ---------------------------------------------------------------- fixtures

const COD = "https://callofduty.fandom.com";
const SW = "https://starwars.fandom.com";
const IMG = "https://static.wikia.nocookie.net/callofduty/images";

const infobox = (...boxes) => JSON.stringify(boxes.map((data) => ({ parser_tag_version: 5, data })));
const row = (label, value) => ({ type: "data", data: { label, value } });
const NAV_BOX = [
  {
    type: "group",
    data: { value: [row("", "<strong>Original</strong>"), row("", '<a href="/wiki/X">Reboot</a>')] },
  },
];
const GHOST_BOX = [
  row("", "-"),
  { type: "title", data: { value: 'Simon "Ghost" Riley' } },
  { type: "image", data: [{ url: `${IMG}/0/04/Ghost.jpg/revision/latest?cb=1`, isVideo: false }] },
  row("Aliases", "Ghost"),
  row("Appears in", '<i><a href="/wiki/MW2">Call of Duty: Modern Warfare 2</a></i><br><i>Modern Warfare 2: Ghost</i>'),
  row("Nationality", '<span typeof="mw:File"><img src="x.png"/></span> British<sup class="reference">[1]</sup>'),
  row("Rank", "Lieutenant &amp; Ghost"),
  row("Status", "K.I.A."),
  row("Aliases", "Duplicate label is skipped"),
  row("Height", "6&#39; 2&#189;&quot;"),
];
const AK_BOX = [
  row("", "-"),
  {
    type: "panel",
    data: {
      value: [
        { type: "section", data: { label: "CoD4", value: [row("Tab Only", "first tab")] } },
        { type: "section", data: { label: "MWR", value: [row("Second Tab", "never shown")] } },
      ],
    },
  },
  row("Weapon Class", '<a href="/wiki/Assault_Rifle">Assault Rifle</a>'),
  row("Damage", "100-85 (SP)<br/>40-30 (MP)"),
];

const GHOST_INTRO = `<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr"><div class="pagination"><p class="mw-empty-elt"></p><aside class="portable-infobox"><p>Inside the infobox</p></aside></div><dl><dd><i>For other uses, see <a href="/wiki/Riley">Riley</a>.</i></dd></dl><div class="quote"><p>"Another keeper: Ghost." — Soap</p></div><p class="mw-empty-elt">
</p><p><b>Lieutenant Simon Riley</b>, also known as <b>Ghost</b>, is a British special forces operator.<sup id="cite_note-1"><a href="#cite">[1]</a></sup><br>He is a member of Task Force 141.
</p><p>Ghost appears in <i>Call of Duty: Modern Warfare 2</i> &amp; more.</p></div>`;

const page = (title, extra = {}) => ({
  pageid: title.length,
  ns: 0,
  title,
  fullurl: `${COD}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  categories: [{ ns: 14, title: "Category:Characters" }],
  ...extra,
});

const WIKIS = {
  "callofduty.fandom.com": {
    general: { sitename: "Call of Duty Wiki", favicon: "$wgUploadPath/6/64/Favicon.ico" },
    repos: [
      { name: "commons", url: "https://static.wikia.nocookie.net/commons/images" },
      { name: "local", url: "https://images.wikia.com/callofduty/images" },
    ],
    pages: {
      'Simon "Ghost" Riley': page('Simon "Ghost" Riley', {
        thumbnail: { source: `${IMG}/0/04/Ghost.jpg/revision/latest/scale-to-width-down/393?cb=1` },
        pageprops: {
          fandomdescription: 'For other uses, see Riley and Ghost. "Another keeper: Ghost." — Soap in his journal. Lieutenant Simon Riley is a soldier.',
          infoboxes: infobox(NAV_BOX, GHOST_BOX),
        },
      }),
      "AK-47": page("AK-47", {
        pageprops: {
          fandomdescription: "For a list of other variants, see AK. The AK-47 is an assault rifle.",
          // Cut off like MediaWiki's 64 KB page prop limit: the second infobox never closes.
          infoboxes: infobox(AK_BOX).slice(0, -1) + `,{"parser_tag_version":5,"data":[{"type":"data","data":{"label":"Cut`,
        },
      }),
      "Call of Duty: Modern Warfare 2": page("Call of Duty: Modern Warfare 2", {
        pageprops: { fandomdescription: "Call of Duty: Modern Warfare 2 is a game." },
      }),
      "Call of Duty 4: Modern Warfare": page("Call of Duty 4: Modern Warfare", {
        pageprops: { fandomdescription: "Call of Duty 4: Modern Warfare is a game." },
      }),
      Ghost: page("Ghost", {
        categories: [{ ns: 14, title: "Category:Disambiguations" }],
        pageprops: { fandomdescription: "Ghost may refer to: Ghost (perk)." },
      }),
      "Ghost (perk)": page("Ghost (perk)", { pageprops: { fandomdescription: "Ghost is a perk." } }),
      Riley: page("Riley", { pageprops: { fandomdescription: "Riley may also refer to: Simon Riley." } }),
      "Category:Weapons Per Game": { ns: 14, title: "Category:Weapons Per Game", pageid: 9 },
      London: page("London", { pageprops: { fandomdescription: "London is a city." } }),
    },
    redirects: {
      "Simon Riley": 'Simon "Ghost" Riley',
      MW2: "Call of Duty: Modern Warfare 2",
      Weapons: "Category:Weapons Per Game",
      "Call of Duty Modern Warfare": "Call of Duty 4: Modern Warfare",
    },
    search: {
      ak47: ["AK-47", "AK-47/Attachments"],
      "ghost perk": ["Ghost (perk)", "Ghost"],
      pizza: ["Piazza"],
    },
    intros: { 'Simon "Ghost" Riley': GHOST_INTRO, London: '<div class="mw-parser-output"><p>London is a city in the campaign.</p></div>' },
  },
  "starwars.fandom.com": {
    general: { sitename: "Wookieepedia", favicon: "https://static.wikia.nocookie.net/starwars/images/4/4a/Site-favicon.ico" },
    repos: [],
    pages: {
      "Luke Skywalker": page("Luke Skywalker", {
        fullurl: `${SW}/wiki/Luke_Skywalker`,
        pageprops: { fandomdescription: "Luke Skywalker was a Jedi Master." },
      }),
      London: page("London", { fullurl: `${SW}/wiki/London`, pageprops: { fandomdescription: "London is somewhere else." } }),
    },
    redirects: {},
    search: {},
    intros: {},
  },
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const upperFirst = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** Answers api.php the way MediaWiki does, for the parts the plugin uses. */
const fakeFetch = ({ fail = false, failHosts = [], delayMs = 0 } = {}) => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push(url);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (options.signal?.aborted) throw new Error("aborted");
    const parsed = new URL(url);
    if (fail || failHosts.includes(parsed.hostname)) throw new Error("network down");
    const wiki = WIKIS[parsed.hostname];
    if (!wiki || parsed.pathname !== "/api.php") return new Response("missing", { status: 404 });
    const params = parsed.searchParams;
    if (params.get("action") === "parse") {
      const html = wiki.intros[params.get("page")];
      return html ? jsonResponse({ parse: { title: params.get("page"), text: html } }) : jsonResponse({ error: { code: "missingtitle" } });
    }
    const query = { general: wiki.general, repos: wiki.repos };
    if (params.get("generator") === "prefixsearch") {
      const titles = wiki.search[params.get("gpssearch").toLowerCase()] ?? [];
      query.pages = titles.map((title, i) => ({ ...(wiki.pages[title] ?? page(title)), index: i + 1 }));
      return jsonResponse({ batchcomplete: true, query });
    }
    const normalized = [];
    const redirects = [];
    const pages = new Map();
    for (const raw of params.get("titles").split("|")) {
      const title = upperFirst(raw);
      if (title !== raw) normalized.push({ from: raw, to: title });
      const target = wiki.redirects[title];
      if (target) redirects.push({ from: title, to: target });
      const final = target ?? title;
      pages.set(final, wiki.pages[final] ?? { ns: 0, title: final, missing: true });
    }
    Object.assign(query, { normalized, redirects, pages: [...pages.values()] });
    return jsonResponse({ batchcomplete: true, query });
  };
  fetcher.calls = calls;
  return fetcher;
};

const WIKI_SETTING = JSON.stringify([
  { url: "https://callofduty.fandom.com/", keywords: "cod, call of duty" },
  { url: "starwars.fandom.com", keywords: "star wars" },
]);
const defaults = Object.fromEntries(slot.settingsSchema.map((field) => [field.key, field.default]));
const sign = (url) => `/api/proxy/image?url=${encodeURIComponent(url)}&sig=test`;

const setup = ({ fetcher = fakeFetch(), settings = {}, signProxyUrl = sign } = {}) => {
  _internals.clearCaches();
  slot.t = translator;
  slot.init({ template, fetch: fetcher, signProxyUrl });
  slot.configure({ ...defaults, wikis: WIKI_SETTING, ...settings });
  return fetcher;
};

const run = (query, context = {}) => slot.execute(query, { locale: "en-US", ...context });
const attr = (html, name) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
const facts = (html) => [...html.matchAll(/<dt class="fandom-label">([^<]*)<\/dt><dd class="fandom-value">([^<]*)<\/dd>/g)].map((m) => [m[1], m[2]]);
const summary = (html) => html.match(/data-fandom-summary>([^<]*)</)?.[1] ?? null;
const imageSrc = (html, kind) => html.match(new RegExp(`src="([^"]*)"[^>]*data-fandom-${kind}`))?.[1] ?? null;
const unsign = (src) => (src ? decodeURIComponent(src.match(/url=([^&]*)/)[1]) : null);

// ---------------------------------------------------------------- contract

test("plugin shape matches the degoog slot contract", () => {
  assert.equal(typeof slot.name, "string");
  assert.equal(typeof slot.description, "string");
  assert.equal(typeof slot.trigger, "function");
  assert.equal(typeof slot.execute, "function");
  assert.equal(slot.position, "knowledge-panel");
  assert.ok(slot.slotPositions.includes(slot.position));
  assert.equal(slot.isClientExposed, false);
  assert.equal(slot.supportsNojs, true);
  assert.equal(slot.waitForResults, undefined);
  assert.equal(mod.default.slot, slot);
  const reserved = ["disabled", "slotPosition", "slotSearchTypes", "priority", "score", "outgoingTransport", "searchTypeOverride", "theme", "shortcuts"];
  for (const field of slot.settingsSchema) {
    assert.ok(!reserved.includes(field.key), field.key);
    assert.equal(typeof field.default, "string", field.key);
  }
  const wikis = slot.settingsSchema.find((field) => field.key === "wikis");
  assert.equal(wikis.type, "list");
  assert.deepEqual(wikis.itemSchema.map((field) => field.key), ["url", "keywords"]);
});

test("manifest and root README list the plugin", async () => {
  const entry = manifest.plugins.find((plugin) => plugin.path === "plugins/fandom");
  assert.ok(entry);
  assert.equal(entry.type, "slot");
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
  assert.match(await readFile("README.md", "utf8"), /\(plugins\/fandom\)/);
});

test("locales share the same keys as en.json and are safe to interpolate", () => {
  const keys = (obj, prefix = "") =>
    Object.entries(obj).flatMap(([key, value]) =>
      value && typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
    );
  const expected = keys(locales.en).sort();
  for (const [lang, bank] of Object.entries(locales)) {
    assert.deepEqual(keys(bank).sort(), expected, lang);
    for (const key of expected) assert.doesNotMatch(lookup(bank, key), /[<>"&]/, `${lang}:${key}`);
  }
});

// ---------------------------------------------------------------- settings

test("wiki addresses are normalised to fandom.com wiki bases", () => {
  const cases = {
    callofduty: "https://callofduty.fandom.com",
    "CallOfDuty": "https://callofduty.fandom.com",
    "callofduty.fandom.com": "https://callofduty.fandom.com",
    "https://callofduty.fandom.com/": "https://callofduty.fandom.com",
    "https://callofduty.fandom.com/wiki/Simon_Riley": "https://callofduty.fandom.com",
    "http://callofduty.fandom.com": "https://callofduty.fandom.com",
    "https://naruto.fandom.com/es/": "https://naruto.fandom.com/es",
    "https://naruto.fandom.com/pt-br/wiki/Naruto": "https://naruto.fandom.com/pt-br",
    "https://callofduty.fandom.com/map/foo": "https://callofduty.fandom.com",
    "https://callofduty.fandom.com/f/p/123": "https://callofduty.fandom.com",
  };
  for (const [input, base] of Object.entries(cases)) assert.equal(_internals.parseWikiUrl(input)?.base, base, input);
  const rejected = [
    "",
    "fandom.com",
    "https://fandom.com",
    "https://evil.com",
    "https://fandom.com.evil.com",
    "https://callofduty.fandom.com.evil.com",
    "https://a.b.fandom.com",
    "ftp://callofduty.fandom.com",
    "javascript:alert(1)",
    "https://user:pass@callofduty.fandom.com",
    "https://callofduty.fandom.com:8443",
    "http://127.0.0.1",
    "https://-bad-.fandom.com",
  ];
  for (const input of rejected) assert.equal(_internals.parseWikiUrl(input), null, input);
});

test("the wikis list accepts degoog's JSON string and plain arrays", () => {
  const fromString = _internals.parseWikis(WIKI_SETTING);
  assert.deepEqual(fromString.map((wiki) => wiki.base), [COD, SW]);
  assert.deepEqual(fromString[0].keywords, [["cod"], ["call", "of", "duty"], ["callofduty"]]);
  assert.deepEqual(fromString[1].keywords, [["star", "wars"], ["starwars"]]);
  const fromArray = _internals.parseWikis([{ url: "callofduty", keywords: "" }, "starwars", { url: "https://callofduty.fandom.com" }]);
  assert.deepEqual(fromArray.map((wiki) => wiki.base), [COD, SW], "strings work and duplicates are dropped");
  for (const bad of ["", "not json", "{}", "null", 42, null, undefined, '[{"url":"https://evil.com"}]']) {
    assert.deepEqual(_internals.parseWikis(bad), [], String(bad));
  }
  const many = JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ url: `wiki${i}` })));
  assert.equal(_internals.parseWikis(many).length, 10);
  assert.deepEqual(_internals.parseWikis(JSON.stringify([{ url: "cod", keywords: "wiki, fandom, , Star Wars, star wars" }]))[0].keywords, [
    ["star", "wars"],
    ["cod"],
  ]);
});

test("number and toggle settings arrive as strings and are clamped", () => {
  setup({ settings: { maxFacts: "99", showImage: "false", bareMatch: "nonsense" } });
  assert.equal(_internals.settings().maxFacts, 10);
  assert.equal(_internals.settings().showImage, false);
  assert.equal(_internals.settings().bareMatch, true);
  setup({ settings: { maxFacts: "0" } });
  assert.equal(_internals.settings().maxFacts, 1);
  setup({ settings: { maxFacts: "abc" } });
  assert.equal(_internals.settings().maxFacts, 5);
});

// ---------------------------------------------------------------- triggers

test("triggers on titles, keyword forms and the fandom/wiki suffix", () => {
  setup();
  const positives = [
    "simon riley",
    "Simon Riley",
    "AK-47",
    "ak47",
    "mw2",
    "cod ghost",
    "cod ak-47",
    "ghost cod wiki",
    "ak-47 cod wiki",
    "cod wiki ak-47",
    "simon riley fandom",
    "luke skywalker fandom",
    "call of duty: modern warfare",
    "the hornet’s nest",
    "simon riley?",
    "  simon   riley  ",
  ];
  for (const query of positives) assert.equal(slot.trigger(query), true, query);
});

test("splits keyword forms into a term and the wikis to search", () => {
  setup();
  const terms = (query) => _internals.parseQuery(query)?.map(({ term, wikis }) => [term, wikis.map((wiki) => wiki.host)]);
  const both = ["callofduty.fandom.com", "starwars.fandom.com"];
  assert.deepEqual(terms("simon riley"), [["simon riley", both]]);
  assert.deepEqual(terms("cod ak-47"), [["ak-47", ["callofduty.fandom.com"]], ["cod ak-47", ["callofduty.fandom.com"]]], "the whole-query fallback stays on the keyword's wiki");
  assert.deepEqual(terms("AK-47 COD wiki"), [["AK-47", ["callofduty.fandom.com"]]]);
  assert.deepEqual(terms("callofduty fandom ak-47"), [["ak-47", ["callofduty.fandom.com"]], ["callofduty fandom ak-47", ["callofduty.fandom.com"]]]);
  assert.deepEqual(terms("star wars luke skywalker"), [["luke skywalker", ["starwars.fandom.com"]], ["star wars luke skywalker", ["starwars.fandom.com"]]]);
  assert.deepEqual(terms("luke skywalker fandom wiki"), [["luke skywalker", both]]);
  assert.deepEqual(terms("the hornet’s nest"), [["the hornet's nest", both]], "curly apostrophes become straight ones");
  assert.deepEqual(terms("cod"), [["cod", both]], "a lone keyword is just a title");
  assert.equal(_internals.parseQuery("wiki"), null);
  for (const query of ["cod wiki", "cod fandom", "COD Fandom Wiki", "call of duty wiki", "star wars fandom", "callofduty wiki"]) {
    assert.equal(_internals.parseQuery(query), null, `${query} asks for the wiki, not a page`);
  }
  assert.equal(_internals.parseQuery("fandom wiki"), null);
});

test("the longest matching keyword decides the wiki", () => {
  setup({ settings: { wikis: JSON.stringify([{ url: "stargate", keywords: "star" }, { url: "starwars", keywords: "star wars" }]) } });
  const terms = (query) => _internals.parseQuery(query)?.map(({ term, wikis }) => [term, wikis.map((wiki) => wiki.host)]);
  assert.deepEqual(terms("star wars luke skywalker"), [
    ["luke skywalker", ["starwars.fandom.com"]],
    ["star wars luke skywalker", ["starwars.fandom.com"]],
  ]);
  assert.deepEqual(terms("star atlantis"), [["atlantis", ["stargate.fandom.com"]], ["star atlantis", ["stargate.fandom.com"]]]);
  setup({ settings: { wikis: JSON.stringify([{ url: "a", keywords: "saga" }, { url: "b", keywords: "saga" }]) } });
  assert.deepEqual(terms("saga hero"), [["hero", ["a.fandom.com", "b.fandom.com"]], ["saga hero", ["a.fandom.com", "b.fandom.com"]]]);
});

test("ignores searches that are never page lookups", () => {
  setup();
  const negatives = [
    "",
    " ",
    "a",
    "!g simon riley",
    "!cod",
    "https://callofduty.fandom.com/wiki/AK-47",
    "www.fandom.com",
    "site:fandom.com ghost",
    "ghost intitle:riley",
    "12345",
    "1 + 1",
    "...",
    "simon [riley]",
    "a|b",
    "{{ t:fandom.name }}",
    "one two three four five six seven eight nine",
    "x".repeat(101),
  ];
  for (const query of negatives) assert.equal(slot.trigger(query), false, JSON.stringify(query));
  for (const value of [null, undefined, 42, {}]) assert.equal(slot.trigger(value), false);
});

test("nothing triggers until a wiki is added", () => {
  setup({ settings: { wikis: "[]" } });
  assert.equal(slot.trigger("simon riley"), false);
  assert.equal(slot.trigger("simon riley fandom"), false);
});

test("with bare matching off, only keywords and the suffix trigger", () => {
  setup({ settings: { bareMatch: "false" } });
  assert.equal(slot.trigger("simon riley"), false);
  assert.equal(slot.trigger("python"), false);
  assert.equal(slot.trigger("cod simon riley"), true);
  assert.equal(slot.trigger("simon riley fandom"), true);
  assert.deepEqual(_internals.parseQuery("cod simon riley").map(({ term }) => term), ["simon riley"]);
});

test("every README trigger example triggers", () => {
  setup();
  const table = readme.slice(readme.indexOf("## Triggers"), readme.indexOf("## Settings"));
  const examples = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
  assert.ok(examples.length >= 6);
  for (const query of examples) assert.equal(slot.trigger(query), true, query);
});

test("trigger stays linear on huge input", () => {
  setup();
  const time = (query) => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < 200; i += 1) slot.trigger(query);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  for (const unit of ["a ", "!", "a:", "' "]) {
    const small = unit.repeat(5_000);
    const large = unit.repeat(40_000);
    time(small);
    const ratio = time(large) / Math.max(time(small), 0.5);
    assert.ok(ratio < 16, `${JSON.stringify(unit)} grew ${ratio.toFixed(1)}x for 8x input`);
  }
  for (const query of ["a ".repeat(140), "x".repeat(299) + "!", "!".repeat(299)]) {
    const start = process.hrtime.bigint();
    slot.trigger(query);
    assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 20, "a single near-limit query is fast");
  }
});

// ---------------------------------------------------------------- lookups

test("renders a card for a redirect, with intro, facts, image and wiki", async () => {
  const fetcher = setup();
  const { title, html } = await run("simon riley");
  assert.equal(title, 'Simon "Ghost" Riley');
  assert.equal(attr(html, "data-fandom-wiki"), "callofduty.fandom.com");
  assert.match(html, /<a class="fandom-title" href="https:\/\/callofduty\.fandom\.com\/wiki\/Simon_%22Ghost%22_Riley"[^>]*data-fandom-link>Simon &quot;Ghost&quot; Riley<\/a>/);
  assert.equal(
    summary(html),
    "Lieutenant Simon Riley, also known as Ghost, is a British special forces operator. He is a member of Task Force 141. Ghost appears in Call of Duty: Modern Warfare 2 &amp; more.",
  );
  assert.deepEqual(facts(html), [
    ["Aliases", "Ghost"],
    ["Appears in", "Call of Duty: Modern Warfare 2, Modern Warfare 2: Ghost"],
    ["Nationality", "British"],
    ["Rank", "Lieutenant &amp; Ghost"],
    ["Status", "K.I.A."],
  ]);
  assert.equal(unsign(imageSrc(html, "image")), `${IMG}/0/04/Ghost.jpg/revision/latest/scale-to-width-down/393?cb=1`);
  assert.match(html, /alt="Simon &quot;Ghost&quot; Riley"/);
  const openHref = html.match(/<a class="fandom-thumb-link" href="([^"]*)"[^>]*data-fandom-open-image>\s*<img /)?.[1];
  assert.equal(unsign(openHref), `${IMG}/0/04/Ghost.jpg/revision/latest?cb=1`, "the image links to its full-size file");
  assert.match(openHref, /^\/api\/proxy\/image\?/, "through the image proxy");
  assert.match(html, /target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label="Open the full-size image" title="Open the full-size image" data-fandom-open-image/);
  assert.equal(unsign(imageSrc(html, "favicon")), "https://static.wikia.nocookie.net/callofduty/images/6/64/Favicon.ico");
  assert.match(html, /data-fandom-more>.*<span>Read more on Call of Duty Wiki<\/span>/);
  assert.ok(!html.includes("{{"), "no template placeholders leak");
  assert.ok(!/\bfandom\.[a-z]+[A-Z.]/.test(html.replace(/[a-z]+\.fandom\.com/g, "")), "no untranslated keys leak");
  assert.ok(!/src="https?:/.test(html), "images go through the proxy");
  // An exact hit needs no prefix search: the exact lookup, then the intro of the shown page.
  const cod = fetcher.calls.filter((url) => url.startsWith(COD));
  assert.equal(cod.length, 2);
  assert.ok(!cod.some((url) => url.includes("prefixsearch")));
  const exact = new URL(cod.find((url) => url.includes("titles=")));
  assert.deepEqual(exact.searchParams.get("titles").split("|").slice(0, 3), ["simon riley", "Simon riley", "Simon Riley"]);
  assert.equal(exact.searchParams.get("redirects"), "1");
  assert.ok(cod.some((url) => new URL(url).searchParams.get("action") === "parse" && new URL(url).searchParams.get("page") === 'Simon "Ghost" Riley'));
});

test("finds titles by case variants, folded prefix search and redirects", async () => {
  setup();
  assert.equal((await run("AK-47")).title, "AK-47");
  assert.equal((await run("ak47")).title, "AK-47", "prefix search match ignoring punctuation");
  assert.equal((await run("mw2")).title, "Call of Duty: Modern Warfare 2", "upper-case variant hits a redirect");
  assert.equal((await run("ghost perk")).title, "Ghost (perk)");
  assert.equal((await run("call of duty modern warfare")).title, "Call of Duty 4: Modern Warfare", "keyword form misses, whole query hits");
  assert.equal((await run("pizza")).html, "", "a fuzzy prefix search result that differs is ignored");
});

test("skips disambiguation pages and redirects to other namespaces", async () => {
  setup();
  assert.equal((await run("ghost")).html, "");
  assert.equal((await run("cod ghost")).html, "");
  assert.equal((await run("riley")).html, "", "'may also refer to' counts too");
  assert.equal((await run("weapons")).html, "");
});

test("the wiki order decides, and keywords narrow the search", async () => {
  setup();
  assert.equal(attr((await run("london")).html, "data-fandom-wiki"), "callofduty.fandom.com");
  assert.equal(attr((await run("star wars london")).html, "data-fandom-wiki"), "starwars.fandom.com");
  assert.equal(attr((await run("luke skywalker fandom")).html, "data-fandom-wiki"), "starwars.fandom.com");
  setup({ settings: { wikis: JSON.stringify([{ url: "starwars" }, { url: "callofduty" }]) } });
  assert.equal(attr((await run("london")).html, "data-fandom-wiki"), "starwars.fandom.com");
  const fetcher = setup({ settings: { bareMatch: "false" } });
  await run("cod london");
  assert.ok(fetcher.calls.every((url) => url.startsWith(COD)), "a keyword search only asks its own wiki");
});

test("only the shown page's intro is fetched", async () => {
  const fetcher = setup();
  assert.equal(attr((await run("london")).html, "data-fandom-wiki"), "callofduty.fandom.com");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const parses = fetcher.calls.filter((url) => new URL(url).searchParams.get("action") === "parse");
  assert.equal(parses.length, 1);
  assert.ok(parses[0].startsWith(COD));
  await run("london");
  assert.equal(fetcher.calls.filter((url) => new URL(url).searchParams.get("action") === "parse").length, 1, "the intro is cached with the page");
});

test("a hit is shown without waiting for lower-priority wikis", async () => {
  const base = fakeFetch();
  const fetcher = async (url, options) => {
    if (new URL(url).hostname === "starwars.fandom.com") await new Promise((resolve) => setTimeout(resolve, 3000));
    return base(url, options);
  };
  setup({ fetcher });
  const start = Date.now();
  assert.equal((await run("simon riley")).title, 'Simon "Ghost" Riley');
  assert.ok(Date.now() - start < 1500, `took ${Date.now() - start} ms`);
});

test("firstInOrder waits for earlier jobs but not later ones", async () => {
  const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  assert.deepEqual(await _internals.firstInOrder([later(30, null), later(5, "b"), new Promise(() => {})]), { index: 1, value: "b" });
  assert.deepEqual(await _internals.firstInOrder([later(5, "a"), later(1, "b")]), { index: 0, value: "a" });
  assert.deepEqual(await _internals.firstInOrder([Promise.reject(new Error("x")), later(1, "b")]), { index: 1, value: "b" });
  assert.equal(await _internals.firstInOrder([later(1, null), Promise.resolve(undefined)]), null);
  assert.equal(await _internals.firstInOrder([]), null);
});

test("titles that differ only in case are cached separately", async () => {
  const wiki = WIKIS["callofduty.fandom.com"];
  wiki.pages.It = page("It", { pageprops: { fandomdescription: "It is a pronoun page." } });
  wiki.pages.IT = page("IT", { pageprops: { fandomdescription: "IT is a department." } });
  try {
    setup();
    assert.equal((await run("it")).title, "It");
    assert.equal((await run("IT")).title, "IT");
    assert.equal((await run("it")).title, "It");
  } finally {
    delete wiki.pages.It;
    delete wiki.pages.IT;
  }
});

test("uncached lookups are capped per minute", async () => {
  const fetcher = setup({ settings: { wikis: JSON.stringify([{ url: "callofduty" }]) } });
  const limit = _internals.budgetPerMinute;
  for (let i = 0; i < limit + 10; i += 1) await run(`unknown page ${i}`);
  const lookups = fetcher.calls.filter((url) => url.includes("titles=")).length;
  assert.equal(lookups, limit);
  assert.deepEqual(await run("simon riley"), { title: "", html: "" }, "no new lookups once the budget is spent");
  assert.equal(fetcher.calls.filter((url) => url.includes("titles=")).length, limit);
});

test("summaries fall back to the cleaned page description", async () => {
  setup();
  assert.equal(summary((await run("ak-47")).html), "The AK-47 is an assault rifle.");
  assert.equal(
    _internals.summary('For other uses, see Riley and Ghost. "Another keeper: Ghost. What kind of name is Ghost?" — John "Soap" MacTavish in his journal. Lieutenant Simon Riley is a soldier.'),
    "Lieutenant Simon Riley is a soldier.",
  );
  assert.equal(_internals.summary("For the Wii version, see X. For the remaster, see Y. Main text."), "Main text.");
  assert.equal(_internals.summary("For Honor is a game."), "For Honor is a game.", "only 'For …, see …' hatnotes are removed");
  assert.equal(_internals.summary("For other uses, see X."), "For other uses, see X.", "keeps the text when nothing else is left");
  const long = _internals.summary("word ".repeat(200));
  assert.ok(long.length <= 321 && long.endsWith("…"));
});

test("reads intros from the lead paragraphs only", () => {
  assert.equal(_internals.introFromHtml(GHOST_INTRO).startsWith("Lieutenant Simon Riley, also known as Ghost"), true);
  assert.equal(_internals.introFromHtml("<p>No wrapper</p><div><p>nested</p></div><p>second</p>"), "No wrapper second");
  assert.equal(_internals.introFromHtml("<p>Unclosed <b>bold"), "");
  assert.equal(_internals.introFromHtml(""), "");
  assert.equal(_internals.introFromHtml("<p>a<script>alert(1)</script>b<style>x{}</style></p>"), "ab");
});

test("facts come from the first infobox with rows, even in truncated JSON", async () => {
  setup();
  assert.deepEqual(facts((await run("ak-47")).html), [
    ["Tab Only", "first tab"],
    ["Weapon Class", "Assault Rifle"],
    ["Damage", "100-85 (SP), 40-30 (MP)"],
  ]);
  assert.deepEqual(_internals.jsonObjects('[{"a":"}"},{"b":1}', 5), [{ a: "}" }, { b: 1 }]);
  assert.deepEqual(_internals.jsonObjects('[{"a":"\\"}"}, {"b":[1,{"c":2}]}, {"cut', 5), [{ a: '"}' }, { b: [1, { c: 2 }] }]);
  assert.deepEqual(_internals.jsonObjects("not json", 5), []);
  assert.deepEqual(_internals.parseInfobox("[{broken"), { facts: [], image: null });
  const decoded = _internals.parseInfobox(infobox(GHOST_BOX)).facts;
  assert.deepEqual(decoded.at(-1), ["Height", '6\' 2½"']);
  assert.equal(decoded.filter(([label]) => label === "Aliases").length, 1);
  const long = _internals.parseInfobox(infobox([row("Long", "x ".repeat(200))])).facts[0][1];
  assert.ok(long.length <= 121 && long.endsWith("…"));
});

test("infobox images are the fallback when there is no page image", async () => {
  setup();
  const box = _internals.parseInfobox(infobox(NAV_BOX, GHOST_BOX));
  assert.equal(box.image, `${IMG}/0/04/Ghost.jpg/revision/latest?cb=1`);
  const { html } = await run("ak-47");
  assert.equal(imageSrc(html, "image"), null, "AK-47 has no image at all");
  assert.equal(_internals.parseInfobox(infobox([{ type: "image", data: [{ url: "https://evil.com/x.png" }] }, row("A", "b")])).image, null);
});

test("toggles hide the image and facts, and the fact count is respected", async () => {
  setup({ settings: { showImage: "false", showFacts: "false" } });
  let { html } = await run("simon riley");
  assert.equal(imageSrc(html, "image"), null);
  assert.ok(!html.includes("data-fandom-open-image"), "no image, no image link");
  assert.ok(!html.includes("data-fandom-facts"));
  assert.ok(imageSrc(html, "favicon"), "the wiki icon stays");
  setup({ settings: { maxFacts: "2" } });
  ({ html } = await run("simon riley"));
  assert.equal(facts(html).length, 2);
});

test("without signProxyUrl no images are rendered", async () => {
  setup({ signProxyUrl: null });
  const { html } = await run("simon riley");
  assert.ok(html.includes("data-fandom-card"));
  assert.ok(!html.includes("<img"));
});

test("the request context's fetch and signProxyUrl win over init's", async () => {
  const initFetch = setup();
  const contextFetch = fakeFetch();
  const { html } = await run("simon riley", { fetch: contextFetch, signProxyUrl: (url) => `/signed?u=${encodeURIComponent(url)}` });
  assert.equal(initFetch.calls.length, 0);
  assert.ok(contextFetch.calls.length > 0);
  assert.match(imageSrc(html, "image"), /^\/signed\?u=/);
});

test("results and misses are cached and concurrent lookups share requests", async () => {
  const fetcher = setup();
  const [a, b] = await Promise.all([run("simon riley"), run("Simon Riley")]);
  assert.equal(a.html, b.html);
  const after = fetcher.calls.length;
  await run("simon riley");
  assert.equal(fetcher.calls.length, after, "hit served from cache");
  await run("python");
  const missCalls = fetcher.calls.length;
  await run("python");
  assert.equal(fetcher.calls.length, missCalls, "miss served from cache");
});

test("network failures give no panel and are not cached", async () => {
  const fetcher = setup({ fetcher: fakeFetch({ fail: true }) });
  assert.deepEqual(await run("simon riley"), { title: "", html: "" });
  const calls = fetcher.calls.length;
  await run("simon riley");
  assert.ok(fetcher.calls.length > calls, "failure retried next time");
  setup({ fetcher: fakeFetch({ failHosts: ["callofduty.fandom.com"] }) });
  assert.equal((await run("luke skywalker")).title, "Luke Skywalker", "one broken wiki doesn't block the others");
  setup({ fetcher: null });
  slot.init({ template, signProxyUrl: sign });
  assert.deepEqual(await slot.execute("simon riley", {}), { title: "", html: "" });
});

test("a failing intro request still renders the card", async () => {
  const base = fakeFetch();
  const fetcher = async (url, options) => {
    if (new URL(url).searchParams.get("action") === "parse") throw new Error("down");
    return base(url, options);
  };
  setup({ fetcher });
  assert.equal(summary((await run("simon riley")).html), "Lieutenant Simon Riley is a soldier.");
});

test("everything interpolated is escaped", async () => {
  const evil = '<script>alert(1)</script> {{ t:fandom.name }} "quoted"';
  const wiki = WIKIS["callofduty.fandom.com"];
  wiki.pages[evil] = page(evil, {
    fullurl: 'javascript:alert(1)"',
    thumbnail: { source: "https://evil.com/x.png" },
    pageprops: { fandomdescription: evil, infoboxes: infobox([row(evil, evil)]) },
  });
  wiki.redirects.Evil = evil;
  wiki.general = { ...wiki.general, sitename: evil };
  try {
    setup();
    const { title, html } = await run("Evil");
    assert.equal(title, evil, "the title is plain text for degoog to escape");
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("{{"));
    assert.ok(!html.includes('"quoted"'));
    assert.ok(!html.includes("javascript:"));
    assert.ok(!html.includes("evil.com"));
    assert.match(html, /href="https:\/\/callofduty\.fandom\.com\/wiki\//);
  } finally {
    delete wiki.pages[evil];
    delete wiki.redirects.Evil;
    wiki.general = { ...wiki.general, sitename: "Call of Duty Wiki" };
  }
});

test("full-size image URLs drop only the scaling step", () => {
  assert.equal(
    _internals.originalImage(`${IMG}/0/04/Ghost.jpg/revision/latest/scale-to-width-down/393?cb=1`),
    `${IMG}/0/04/Ghost.jpg/revision/latest?cb=1`,
  );
  assert.equal(_internals.originalImage(`${IMG}/a/b/X.png/revision/latest?cb=2`), `${IMG}/a/b/X.png/revision/latest?cb=2`);
  assert.equal(_internals.originalImage("https://evil.com/x/scale-to-width-down/10"), null);
  assert.equal(_internals.originalImage(null), null);
});

test("text from infobox HTML is decoded and tidied", () => {
  assert.equal(_internals.htmlToText("A<br>B<br/>C"), "A, B, C");
  assert.equal(_internals.htmlToText("M4A1,<br>Knife"), "M4A1, Knife");
  assert.equal(_internals.htmlToText("x<sup>[1]</sup>y"), "xy");
  assert.equal(_internals.htmlToText("&amp;lt; &#x41; &#65; &nbsp;&bogus;"), "&lt; A A &bogus;");
  assert.equal(_internals.htmlToText("<a href='x'>unclosed"), "unclosed");
  assert.equal(_internals.htmlToText("a <"), "a");
});

test("site info builds the favicon from the local file repository", () => {
  const wiki = { host: "callofduty.fandom.com" };
  assert.deepEqual(_internals.siteInfo({ general: WIKIS["callofduty.fandom.com"].general, repos: WIKIS["callofduty.fandom.com"].repos }, wiki), {
    name: "Call of Duty Wiki",
    favicon: "https://static.wikia.nocookie.net/callofduty/images/6/64/Favicon.ico",
  });
  assert.deepEqual(_internals.siteInfo({ general: { favicon: "https://evil.com/f.ico" } }, wiki), { name: "callofduty.fandom.com", favicon: null });
  assert.deepEqual(_internals.siteInfo({}, wiki), { name: "callofduty.fandom.com", favicon: null });
});

test("translates the card for the request locale", async () => {
  setup();
  assert.match((await run("simon riley", { locale: "de-DE" })).html, /<span>Mehr im Call of Duty Wiki<\/span>/);
  assert.match((await run("simon riley", { locale: "fr" })).html, /<span>En savoir plus sur Call of Duty Wiki<\/span>/);
  assert.match((await run("simon riley", { locale: "not a locale!!" })).html, /<span>Read more on Call of Duty Wiki<\/span>/);
});

test("lookups time out instead of hanging", { timeout: 15000 }, async () => {
  setup({ fetcher: fakeFetch({ delayMs: 6000 }) });
  const start = Date.now();
  assert.deepEqual(await run("simon riley"), { title: "", html: "" });
  assert.ok(Date.now() - start < 6000);
});
