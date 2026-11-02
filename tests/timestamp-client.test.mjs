import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const SCRIPT = await readFile(path.resolve("plugins/timestamp/script.js"), "utf8");

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const matchesSelector = (el, selector) => {
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
  const attr = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (!attr) throw new Error(`unsupported selector ${selector}`);
  if (!el.attributes.has(attr[1])) return false;
  return attr[2] === undefined || el.attributes.get(attr[1]) === attr[2];
};

class FakeElement {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map(Object.entries(attrs));
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.textContent = "";
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
    children.forEach((child) => this.appendChild(child));
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

const createEnvironment = () => {
  const root = new FakeElement("html");
  root.isRoot = true;
  let nextTimer = 1;
  const timeouts = new Map();
  const intervals = new Map();
  const windowListeners = new Map();
  const observers = [];
  const clipboard = [];

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
    addEventListener() {},
  };

  const context = vm.createContext({
    window,
    document,
    navigator: { clipboard: { writeText: async (text) => clipboard.push(text) } },
    Node: { ELEMENT_NODE: 1, DOCUMENT_NODE: 9 },
    MutationObserver: FakeMutationObserver,
    t: (key) => (key === "timestamp.copied" ? "Copied" : key),
  });

  return {
    root,
    clipboard,
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

const staticCard = () => {
  const button = new FakeElement("button", {
    "data-tstamp-copy": "2023-11-14T22:13:20Z",
    "aria-label": "Copy",
    title: "Copy",
    class: "tstamp-copy",
  });
  const card = new FakeElement(
    "div",
    {
      "data-tstamp-card": "",
      "data-tstamp-mode": "number",
      "data-tstamp-ms": "1700000000000",
      "data-tstamp-live": "false",
      "data-tstamp-clock": "auto",
    },
    [
      new FakeElement("div", { "data-tstamp-sub": "" }),
      new FakeElement("div", { class: "tstamp-row" }, [
        new FakeElement("dd", { class: "tstamp-value" }, [
          new FakeElement("span", { "data-tstamp-field": "iso" }),
          button,
        ]),
      ]),
    ],
  );
  return { card, button };
};

const liveCard = () => {
  const seconds = new FakeElement("span", { "data-tstamp-field": "seconds" });
  seconds.textContent = "0";
  const card = new FakeElement(
    "div",
    {
      "data-tstamp-card": "",
      "data-tstamp-mode": "now",
      "data-tstamp-ms": "1",
      "data-tstamp-live": "true",
      "data-tstamp-clock": "auto",
    },
    [seconds],
  );
  return { card, seconds };
};

test("copy button copies its value and restores the original label after rapid clicks", async () => {
  const env = createEnvironment();
  const { card, button } = staticCard();
  env.root.appendChild(card);
  env.load();

  button.dispatch("click");
  await flush();
  assert.equal(button.getAttribute("aria-label"), "Copied");
  button.dispatch("click");
  await flush();
  assert.equal(button.getAttribute("aria-label"), "Copied");
  assert.deepEqual(env.clipboard, ["2023-11-14T22:13:20Z", "2023-11-14T22:13:20Z"]);
  assert.equal(env.timeouts.size, 1, "the first reset timer is replaced, not stacked");

  env.runTimeouts();
  assert.equal(button.getAttribute("aria-label"), "Copy");
  assert.equal(button.getAttribute("title"), "Copy");
  assert.equal(button.classList.contains("tstamp-copy--done"), false);

  button.dispatch("click");
  await flush();
  env.runTimeouts();
  assert.equal(button.getAttribute("aria-label"), "Copy");
});

test("live cards keep ticking after the page is restored from the back-forward cache", () => {
  const env = createEnvironment();
  const { card, seconds } = liveCard();
  env.root.appendChild(card);
  env.load();

  assert.equal(env.intervals.size, 1);
  const initial = Number(seconds.textContent);
  assert.ok(Math.abs(initial - Date.now() / 1000) < 5);

  env.fireWindow("pagehide", { persisted: true });
  assert.equal(env.intervals.size, 0, "ticker pauses while hidden");

  seconds.textContent = "stale";
  env.fireWindow("pageshow", { persisted: true });
  assert.equal(env.intervals.size, 1, "ticker restarts on restore");
  assert.notEqual(seconds.textContent, "stale", "restore refreshes immediately");

  seconds.textContent = "stale";
  env.runIntervals();
  assert.notEqual(seconds.textContent, "stale");

  const { card: later } = liveCard();
  env.addNode(later);
  assert.equal(later.dataset.tstampMounted, "1", "observer still mounts new cards");
});

test("ticker stops once every card has left the page", () => {
  const env = createEnvironment();
  const { card } = liveCard();
  env.root.appendChild(card);
  env.load();
  assert.equal(env.intervals.size, 1);
  card.remove();
  env.runIntervals();
  assert.equal(env.intervals.size, 0);
});
