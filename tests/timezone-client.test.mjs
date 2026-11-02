import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const pluginDir = path.resolve("plugins/timezone");
const SCRIPT = await readFile(path.join(pluginDir, "script.js"), "utf8");
const template = await readFile(path.join(pluginDir, "template.html"), "utf8");
const en = JSON.parse(await readFile(path.join(pluginDir, "locales", "en.json"), "utf8"));

const lookup = (bank, key) =>
  key.split(".").reduce((cur, part) => (cur && typeof cur === "object" ? cur[part] : undefined), bank);

// Mirrors degoog's scopedT: dotted lookup, {name} interpolation, the key itself when missing.
const translate = (key, vars) => {
  const value = lookup(en, key);
  if (typeof value !== "string") return key;
  if (!vars) return value;
  return value.replace(/\{([^}]+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
};

const { slot } = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
slot.t = (key, vars) => translate(key, vars);
slot.init({ template });
const defaults = Object.fromEntries(slot.settingsSchema.map((field) => [field.key, field.default]));
const configure = (overrides = {}) => slot.configure({ ...defaults, homeZone: "America/New_York", ...overrides });
configure();

const NOW = Date.parse("2026-11-01T12:00:00Z");
const render = async (query, { now = NOW, ...settings } = {}) => {
  configure(settings);
  try {
    return (await slot.execute(query, { locale: "en-US", now })).html;
  } finally {
    configure();
  }
};

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const matchesSelector = (el, selector) => {
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
  const attr = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (!attr) throw new Error(`unsupported selector ${selector}`);
  if (!el.attributes.has(attr[1])) return false;
  return attr[2] === undefined || el.attributes.get(attr[1]) === attr[2];
};

class FakeElement {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map(Object.entries(attrs));
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.ownText = "";
    this.hidden = "hidden" in attrs;
    this.style = {};
    this.dataset = new Proxy(
      {},
      {
        get: (_, key) => this.attributes.get(`data-${kebab(String(key))}`),
        set: (_, key, value) => {
          this.attributes.set(`data-${kebab(String(key))}`, String(value));
          return true;
        },
      },
    );
    const classes = () => new Set((this.attributes.get("class") || "").split(/\s+/).filter(Boolean));
    this.classList = {
      contains: (name) => classes().has(name),
      add: (name) => this.attributes.set("class", [...classes().add(name)].join(" ")),
      remove: (name) => {
        const next = classes();
        next.delete(name);
        this.attributes.set("class", [...next].join(" "));
      },
    };
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.children.forEach((child) => {
      child.parentElement = null;
    });
    this.children = [];
    this.ownText = String(value);
  }

  get className() {
    return this.attributes.get("class") || "";
  }

  set className(value) {
    this.attributes.set("class", String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }

  select() {}

  get isConnected() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node.isRoot === true;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    let node = this;
    while (node && !node.isRoot) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
}

const decode = (text) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#123;/g, "{")
    .replace(/&amp;/g, "&");

// Enough HTML parsing for the plugin's own well-formed markup.
const parseCard = (html) => {
  const holder = new FakeElement("div");
  const stack = [holder];
  for (const match of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    const [, closing, tag, rawAttrs, text] = match;
    const current = stack[stack.length - 1];
    if (text !== undefined) {
      if (text.trim()) {
        if (current.children.length) {
          const node = new FakeElement("#text");
          node.ownText = decode(text);
          current.appendChild(node);
        } else {
          current.ownText += decode(text);
        }
      }
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const attr of rawAttrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = decode(attr[2] ?? "");
    const el = new FakeElement(tag, attrs);
    current.appendChild(el);
    stack.push(el);
  }
  return holder.children[0];
};

const createEnvironment = ({ zone = "America/New_York", now = NOW, translations = true, clipboard = true } = {}) => {
  const root = new FakeElement("html");
  root.isRoot = true;
  const clock = { now };
  let nextTimer = 1;
  const timeouts = new Map();
  const intervals = new Map();
  const windowListeners = new Map();
  const observers = [];
  const copied = [];
  const execCommands = [];

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.active = false;
      observers.push(this);
    }

    observe() {
      this.active = true;
    }

    disconnect() {
      this.active = false;
    }
  }

  const RealDTF = Intl.DateTimeFormat;
  function DateTimeFormat(locale, options) {
    return new RealDTF(locale, options && options.timeZone ? options : { ...options, timeZone: zone });
  }
  DateTimeFormat.supportedLocalesOf = RealDTF.supportedLocalesOf;
  const FakeIntl = Object.create(Intl);
  FakeIntl.DateTimeFormat = DateTimeFormat;

  class FakeDate extends Date {
    static now() {
      return clock.now;
    }
  }

  const window = {
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn, ms) => {
      const id = nextTimer++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    addEventListener: (type, fn, options) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push({ fn, once: options?.once === true });
    },
  };

  const document = {
    nodeType: 9,
    readyState: "complete",
    documentElement: root,
    body: root,
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    createElement: (tag) => new FakeElement(tag),
    execCommand: (name) => {
      execCommands.push(name);
      return true;
    },
    addEventListener() {},
  };

  const context = vm.createContext({
    window,
    document,
    navigator: clipboard ? { clipboard: { writeText: async (text) => copied.push(text) } } : {},
    Node: { ELEMENT_NODE: 1, DOCUMENT_NODE: 9 },
    MutationObserver: FakeMutationObserver,
    Intl: FakeIntl,
    Date: FakeDate,
    t: translations ? translate : (key) => key,
  });

  return {
    root,
    clock,
    copied,
    execCommands,
    timeouts,
    intervals,
    load: () => vm.runInContext(SCRIPT, context),
    fireWindow: (type, event = {}) => {
      const list = windowListeners.get(type) ?? [];
      windowListeners.set(type, list.filter((entry) => !entry.once));
      list.forEach((entry) => entry.fn(event));
    },
    runTimeouts: () => {
      const pending = [...timeouts.entries()];
      timeouts.clear();
      pending.forEach(([, { fn }]) => fn());
    },
    runIntervals: () => [...intervals.values()].forEach(({ fn }) => fn()),
    addNode: (node) => {
      root.appendChild(node);
      observers.filter((o) => o.active).forEach((o) => o.callback([{ addedNodes: [node] }]));
    },
  };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const texts = (card) =>
  card.querySelectorAll("[data-tz-fmt]").map((el) => `${el.dataset.tzFmt}:${el.textContent}`);

const row = (card, role, zone) =>
  card
    .querySelectorAll("[data-tz-row]")
    .find((el) => el.dataset.tzRole === role && (zone === undefined || el.dataset.tzZone === zone));

const field = (scope, kind) => scope.querySelector(`[data-tz-fmt="${kind}"]`)?.textContent;

const mounted = async (query, envOptions = {}, renderOptions = {}) => {
  const env = createEnvironment(envOptions);
  const card = parseCard(await render(query, renderOptions));
  const server = texts(card);
  env.root.appendChild(card);
  env.load();
  return { env, card, server };
};

test("the browser formats every field exactly like the server", async () => {
  for (const query of ["current time melbourne", "5pm ET to PT, CET and tokyo", "ET to sydney", "what time is it in the usa"]) {
    const { card, server } = await mounted(query);
    assert.equal(card.dataset.tzMounted, "1", query);
    assert.deepEqual(texts(card), server, query);
  }
});

test("the live clock ticks every second and stops when the panel is gone", async () => {
  const { env, card } = await mounted("current time melbourne");
  const clock = card.querySelector(".tz-clock");
  assert.equal(clock.textContent, "11:00:00 PM");
  assert.equal(env.intervals.size, 1);
  env.clock.now += 61000;
  env.runIntervals();
  assert.equal(clock.textContent, "11:01:01 PM");
  const home = row(card, "home");
  assert.equal(field(home, "time"), "7:01 AM");
  assert.equal(home.querySelector("[data-tz-copy]").dataset.tzCopy, "7:01 AM EST, Sun, Nov 1");
  card.remove();
  env.runIntervals();
  assert.equal(env.intervals.size, 0);
});

test("the home row becomes the visitor's own zone and is tagged as theirs", async () => {
  const { card } = await mounted("current time melbourne", { zone: "Europe/Berlin" });
  const home = row(card, "home");
  assert.equal(home.dataset.tzZone, "Europe/Berlin");
  assert.equal(field(home, "label"), "Berlin");
  assert.equal(field(home, "time"), "1:00 PM");
  assert.equal(home.querySelector("[data-tz-tag]").textContent, "you");
  assert.equal(home.hidden, false);
  assert.equal(card.querySelector('[data-tz-fmt="rel"]').textContent, "10 hours ahead of Berlin");
  assert.equal(row(card, "local").hidden, true);
});

test("asking for the time with no zone answers for the visitor's zone", async () => {
  const { card } = await mounted("what time is it", { zone: "Asia/Tokyo" });
  assert.equal(card.dataset.tzZone, "Asia/Tokyo");
  assert.equal(card.querySelector(".tz-clock").textContent, "9:00:00 PM");
  assert.equal(card.querySelector('[data-tz-fmt="long"]').textContent, "Japan Standard Time");
  assert.equal(card.querySelector('[data-tz-fmt="dst"]').textContent, "Not observed");
  assert.equal(card.querySelector('[data-tz-fmt="label"]').textContent, "Tokyo");
});

test("conversions add the visitor's local time when it is not already listed", async () => {
  const { card } = await mounted("5pm ET to PT", { zone: "Europe/Berlin" });
  const local = row(card, "local");
  assert.equal(local.hidden, false);
  assert.equal(local.dataset.tzZone, "Europe/Berlin");
  assert.equal(field(local, "label"), "Berlin");
  assert.equal(field(local, "time"), "11:00 PM");
  assert.equal(field(local, "rel"), "6 hours ahead of Eastern Time");
  assert.equal(local.querySelector("[data-tz-tag]").textContent, "you");

  const same = await mounted("5pm ET to PT", { zone: "America/Los_Angeles" });
  assert.equal(row(same.card, "local").hidden, true);
  const target = row(same.card, "target", "America/Los_Angeles");
  assert.equal(target.querySelector("[data-tz-tag]").hidden, false);
  assert.equal(target.querySelector("[data-tz-tag]").textContent, "you");
});

test("a conversion from the home zone is recomputed from the visitor's zone", async () => {
  const { card } = await mounted("5pm to tokyo", { zone: "Europe/London" });
  assert.equal(card.dataset.tzAt, String(Date.parse("2026-11-01T17:00:00Z")));
  const source = row(card, "source");
  assert.equal(source.dataset.tzZone, "Europe/London");
  assert.equal(field(source, "time"), "5:00 PM");
  const tokyo = row(card, "target", "Asia/Tokyo");
  assert.equal(field(tokyo, "time"), "2:00 AM");
  assert.equal(field(tokyo, "rel"), "9 hours ahead of London");
  assert.equal(card.querySelector(".tz-clock").textContent, "2:00 AM");
});

test("a daylight saving question with no zone is answered for the visitor's zone", async () => {
  const { card } = await mounted(
    "when does dst end",
    { zone: "America/New_York", now: Date.parse("2026-10-31T12:00:00Z") },
    { now: Date.parse("2026-10-31T12:00:00Z"), homeZone: "UTC" },
  );
  assert.equal(card.dataset.tzZone, "America/New_York");
  assert.equal(card.querySelector("[data-tz-dst-headline]").textContent, "Clocks go back 1 hour on Sunday, November 1, 2026");
  assert.equal(card.querySelector(".tz-badge").textContent, "New York");
  const rows = card.querySelectorAll('[data-tz-row="dst"]');
  assert.deepEqual(
    rows.map((el) => `${el.querySelector(".tz-label").textContent}|${el.querySelector(".tz-text").textContent}`),
    [
      "Next change|Sun, Nov 1, 2026 · Clocks go back 1 hour",
      "After that|Sun, Mar 14, 2027 · Clocks go forward 1 hour",
      "Right now|Daylight saving time · UTC−4, EDT",
    ],
  );
});

test("explicit zones are never retargeted", async () => {
  const { card } = await mounted("dst tokyo", { zone: "America/New_York" });
  assert.equal(card.dataset.tzZone, "Asia/Tokyo");
  assert.equal(card.querySelector("[data-tz-dst-headline]").textContent, "Tokyo does not use daylight saving time");
});

test("without translations the panel keeps the server's zone and text", async () => {
  const { card, server } = await mounted("current time melbourne", { zone: "Europe/Berlin", translations: false });
  const home = row(card, "home");
  assert.equal(home.dataset.tzZone, "America/New_York");
  assert.equal(home.querySelector("[data-tz-tag]").textContent, "home");
  const local = row(card, "local");
  assert.deepEqual(texts(card).slice(0, -8), server.slice(0, -8));
  assert.equal(local.hidden, false);
  assert.equal(field(local, "time"), "1:00 PM");
  assert.equal(field(local, "rel"), "");
  assert.equal(local.querySelector("[data-tz-tag]").hidden, true);
});

test("the browser zone setting keeps the panel on the home zone", async () => {
  const { card } = await mounted("what time is it", { zone: "Asia/Tokyo" }, { browserZone: "false" });
  assert.equal(card.dataset.tzZone, "America/New_York");
  assert.equal(card.querySelector(".tz-clock").textContent, "7:00:00 AM");
});

test("copy falls back to execCommand and restores the label after rapid clicks", async () => {
  const { env, card } = await mounted("5pm ET to PT", { clipboard: false });
  const button = row(card, "target", "America/Los_Angeles").querySelector("[data-tz-copy]");
  assert.equal(button.dataset.tzCopy, "2:00 PM PST, Sun, Nov 1");
  button.dispatch("click");
  await flush();
  button.dispatch("click");
  await flush();
  assert.deepEqual(env.execCommands, ["copy", "copy"]);
  assert.equal(button.getAttribute("aria-label"), "Copied");
  assert.ok(button.classList.contains("tz-copy--done"));
  assert.equal(env.timeouts.size, 1);
  env.runTimeouts();
  assert.equal(button.getAttribute("aria-label"), "Copy");
  assert.ok(!button.classList.contains("tz-copy--done"));
});

test("copy uses the clipboard API when it exists", async () => {
  const { env, card } = await mounted("5pm ET to PT");
  row(card, "source").querySelector("[data-tz-copy]").dispatch("click");
  await flush();
  assert.deepEqual(env.copied, ["5:00 PM EST, Sun, Nov 1"]);
});

test("the ticker pauses for the back-forward cache and picks up re-rendered panels", async () => {
  const { env, card } = await mounted("current time melbourne");
  env.fireWindow("pagehide");
  assert.equal(env.intervals.size, 0);
  env.clock.now += 5000;
  env.fireWindow("pageshow", { persisted: true });
  assert.equal(env.intervals.size, 1);
  assert.equal(card.querySelector(".tz-clock").textContent, "11:00:05 PM");

  const second = parseCard(await render("current time melbourne"));
  env.addNode(second);
  assert.equal(second.dataset.tzMounted, "1");
  env.clock.now += 1000;
  env.runIntervals();
  assert.equal(second.querySelector(".tz-clock").textContent, "11:00:06 PM");
  assert.equal(card.querySelector(".tz-clock").textContent, "11:00:06 PM");
});

test("static panels do not start a ticker", async () => {
  const { env } = await mounted("5pm ET to PT");
  assert.equal(env.intervals.size, 0);
});
