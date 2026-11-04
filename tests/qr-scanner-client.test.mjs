import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const pluginDir = path.resolve("plugins/qr-scanner");
const SCRIPT = await readFile(path.join(pluginDir, "script.js"), "utf8");
const DECODER = await readFile(path.join(pluginDir, "vendor", "jsQR.js"), "utf8");
const template = await readFile(path.join(pluginDir, "template.html"), "utf8");
const en = JSON.parse(await readFile(path.join(pluginDir, "locales", "en.json"), "utf8"));
const fixture = async (name) =>
  (await readFile(path.resolve("tests/fixtures/qr-scanner", `${name}.txt`), "utf8")).trim().split("\n");

const lookup = (bank, key) =>
  key.split(".").reduce((cur, part) => (cur && typeof cur === "object" ? cur[part] : undefined), bank);
const translate = (key) => (typeof lookup(en, key) === "string" ? lookup(en, key) : key);

const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
const { slot } = mod;
const API_BASE = "/api/plugin/example-degoog-extensions-qr-scanner";
const signProxyUrl = (url) => `/api/proxy/image?url=${encodeURIComponent(url)}&sig=test`;
slot.t = translate;
slot.init({ template, apiBase: API_BASE, signProxyUrl });
slot.configure({ bareQr: "true" });
const render = async (query) => (await slot.execute(query, { locale: "en" })).html;
const commandHtml = async (args) =>
  (await mod.default.execute(args, { signProxyUrl })).html.replace(/\{\{\s*t:([\w.]+)\s*\}\}/g, (_, key) =>
    translate(key),
  );

// ---- A small fake DOM ----

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const VOID = new Set(["input", "img", "br"]);

const matchesSelector = (el, selector) => {
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
  const attr = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (!attr) throw new Error(`unsupported selector ${selector}`);
  if (!el.attributes.has(attr[1])) return false;
  return attr[2] === undefined || el.attributes.get(attr[1]) === attr[2];
};

class FakeElement {
  constructor(tag, attrs = {}, env = null) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map(Object.entries(attrs));
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.ownText = "";
    this.hidden = "hidden" in attrs;
    this.style = {};
    this.env = env;
    this.value = attrs.value ?? "";
    this.clicks = 0;
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

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    this.env?.onAppend?.(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }

  contains(node) {
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }

  select() {}

  focus() {
    if (this.env) this.env.document.activeElement = this;
  }

  click() {
    this.clicks += 1;
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
    const full = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this.listeners.get(type) ?? []) fn(full);
    return full;
  }
}

const decodeEntities = (text) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#123;/g, "{")
    .replace(/&amp;/g, "&");

// Enough HTML parsing for the plugin's own well-formed markup.
const parseHtml = (html, env) => {
  const holder = new FakeElement("div", {}, env);
  const stack = [holder];
  for (const match of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    const [, closing, tag, rawAttrs, text] = match;
    const current = stack[stack.length - 1];
    if (text !== undefined) {
      if (text.trim()) current.ownText += decodeEntities(text);
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const attr of rawAttrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = decodeEntities(attr[2] ?? "");
    const el = new FakeElement(tag, attrs, env);
    current.appendChild(el);
    if (!VOID.has(tag.toLowerCase())) stack.push(el);
  }
  return holder.children[0];
};

// ---- Fake images, blobs and canvas ----

/**
 * RGBA pixels of a QR matrix, `px` pixels per module. By default there is no quiet zone, which the script
 * adds. `quiet` adds that many light modules around it, which turn dark when `invert` is set.
 */
const qrPixels = (rows, { px = 4, invert = false, quiet = 0 } = {}) => {
  const n = rows.length + quiet * 2;
  const width = n * px;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const my = Math.floor(y / px) - quiet;
      const mx = Math.floor(x / px) - quiet;
      const dark = rows[my]?.[mx] === "1";
      const value = dark !== invert ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { width, height: width, data };
};

/** SVG markup of a QR matrix: one <rect> per dark module, a viewBox and no width or height. */
const qrSvg = (rows, { size = false, xmlns = true } = {}) => {
  const n = rows.length;
  const rects = [];
  rows.forEach((row, y) =>
    [...row].forEach((bit, x) => {
      if (bit === "1") rects.push(`<rect x="${x + 4}" y="${y + 4}" width="1" height="1"/>`);
    }),
  );
  const attrs = [xmlns ? 'xmlns="http://www.w3.org/2000/svg"' : "", size ? `width="${n + 8}" height="${n + 8}"` : `viewBox="0 0 ${n + 8} ${n + 8}"`];
  return `<svg ${attrs.filter(Boolean).join(" ")}><rect width="100%" height="100%" fill="#fff"/>${rects.join("")}</svg>`;
};

/**
 * A tiny rasterizer for qrSvg() output. Like Firefox, it refuses SVGs without a pixel width and height, and
 * like any <img>, SVGs without the SVG namespace.
 */
const rasterSvg = (text) => {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0] || "";
  const num = (name) => Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(root)?.[1]);
  const width = num("width");
  const height = num("height");
  if (!width || !height || !root.includes('xmlns="http://www.w3.org/2000/svg"')) return null;
  const box = /viewBox="([^"]+)"/.exec(root)?.[1].split(/\s+/).map(Number) ?? [0, 0, width, height];
  const sx = width / box[2];
  const sy = height / box[3];
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const rect of text.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1"\/>/g)) {
    const x0 = Math.round(Number(rect[1]) * sx);
    const y0 = Math.round(Number(rect[2]) * sy);
    const x1 = Math.round((Number(rect[1]) + 1) * sx);
    const y1 = Math.round((Number(rect[2]) + 1) * sy);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return { width, height, data };
};

const blank = (size = 64) => ({ width: size, height: size, data: new Uint8ClampedArray(size * size * 4).fill(255) });

class FakeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.buffer = null;
  }

  ensure() {
    const { width, height } = this.canvas;
    if (!this.buffer || this.buffer.length !== width * height * 4) this.buffer = new Uint8ClampedArray(width * height * 4);
  }

  fillRect(x, y, w, h) {
    this.ensure();
    const { width } = this.canvas;
    for (let row = y; row < y + h; row += 1) {
      for (let col = x; col < x + w; col += 1) {
        const i = (row * width + col) * 4;
        this.buffer[i] = this.buffer[i + 1] = this.buffer[i + 2] = this.buffer[i + 3] = 255;
      }
    }
  }

  drawImage(img, dx, dy, dw, dh) {
    this.ensure();
    const src = img.pixels;
    const { width } = this.canvas;
    for (let y = 0; y < dh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dw));
        const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dh));
        const si = (sy * src.width + sx) * 4;
        const di = ((dy + y) * width + dx + x) * 4;
        this.buffer[di] = src.data[si];
        this.buffer[di + 1] = src.data[si + 1];
        this.buffer[di + 2] = src.data[si + 2];
        this.buffer[di + 3] = 255;
      }
    }
  }

  getImageData(x, y, w, h) {
    this.ensure();
    return { data: this.buffer, width: w, height: h };
  }
}

const createEnvironment = ({ clipboard = true, fetchImpl, barcodeDetector = null, pixelsForBytes } = {}) => {
  const env = { onAppend: null };
  const root = new FakeElement("html", {}, env);
  root.isRoot = true;
  const head = new FakeElement("head", {}, env);
  const body = new FakeElement("body", {}, env);
  root.appendChild(head);
  root.appendChild(body);
  let nextTimer = 1;
  const timeouts = new Map();
  const windowListeners = new Map();
  const observers = [];
  const copied = [];
  const execCommands = [];
  const fetches = [];
  const scripts = [];
  const blobUrls = new Map();
  const svgSeen = [];
  const revoked = [];
  let blobCount = 0;

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

  class FakeBlob {
    constructor(parts = [], options = {}) {
      this.parts = parts;
      this.type = String(options.type || "");
      this.size = parts.reduce((sum, p) => sum + (p.length ?? p.byteLength ?? 0), 0);
      this.pixels = null;
    }

    async text() {
      return this.parts.map((p) => (typeof p === "string" ? p : new TextDecoder().decode(p))).join("");
    }
  }

  const blobText = (blob) =>
    blob.parts.map((p) => (typeof p === "string" ? p : String.fromCharCode(...(p || [])))).join("");

  const blobPixels = (blob) => {
    if (blob.pixels) return blob.pixels;
    const text = blobText(blob);
    if (/svg/.test(blob.type)) {
      svgSeen.push(text);
      return rasterSvg(text);
    }
    return pixelsForBytes?.(text) ?? null;
  };

  class FakeImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this.pixels = null;
    }

    set src(url) {
      this._src = url;
      setImmediate(() => {
        const blob = blobUrls.get(url);
        const pixels = blob ? blobPixels(blob) : null;
        if (!pixels) {
          this.onerror?.();
          return;
        }
        this.pixels = pixels;
        this.naturalWidth = pixels.width;
        this.naturalHeight = pixels.height;
        this.onload?.();
      });
    }

    get src() {
      return this._src;
    }
  }

  const window = {
    setTimeout: (fn, ms) => {
      if (!ms) {
        setImmediate(fn);
        return 0;
      }
      const id = nextTimer++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    addEventListener: (type, fn, capture) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push({ fn, capture: capture === true || capture?.capture === true });
    },
  };

  const document = {
    nodeType: 9,
    readyState: "complete",
    documentElement: root,
    head,
    body,
    activeElement: body,
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    createElement: (tag) => {
      const el = new FakeElement(tag, {}, env);
      if (tag === "canvas") {
        el.width = 0;
        el.height = 0;
        el.getContext = () => (el.ctx ??= new FakeCanvasContext(el));
      }
      return el;
    },
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
    Image: FakeImage,
    Blob: FakeBlob,
    URL: Object.assign(
      class extends URL {},
      {
        createObjectURL: (blob) => {
          const url = `blob:fake/${(blobCount += 1)}`;
          blobUrls.set(url, blob);
          return url;
        },
        revokeObjectURL: (url) => {
          revoked.push(url);
        },
      },
    ),
    atob: (text) => Buffer.from(text, "base64").toString("latin1"),
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return fetchImpl ? fetchImpl(url, FakeBlob) : { ok: false, status: 404 };
    },
    BarcodeDetector: barcodeDetector ?? undefined,
    t: translate,
  });
  window.self = window;

  // Loading the decoder: run the vendored jsQR in this context when its <script> is appended.
  env.onAppend = (el) => {
    if (el.tagName !== "SCRIPT") return;
    scripts.push(el.getAttribute?.("src") ?? el.src);
    setImmediate(() => {
      vm.runInContext(`(function(){ var self = window; ${DECODER}\n}).call(window)`, context);
      el.onload?.();
    });
  };
  env.document = document;

  return {
    root,
    body,
    document,
    window,
    context,
    copied,
    execCommands,
    fetches,
    scripts,
    revoked,
    timeouts,
    svgSeen,
    FakeBlob,
    load: () => vm.runInContext(SCRIPT, context),
    fireWindow: (type, event = {}) => {
      const calls = { prevented: false, stopped: false };
      const full = {
        preventDefault: () => {
          calls.prevented = true;
        },
        stopPropagation: () => {
          calls.stopped = true;
        },
        stopImmediatePropagation: () => {
          calls.stopped = true;
        },
        ...event,
      };
      for (const entry of windowListeners.get(type) ?? []) entry.fn(full);
      return calls;
    },
    runTimeouts: () => {
      const pending = [...timeouts.values()];
      timeouts.clear();
      pending.forEach(({ fn }) => fn());
    },
    windowListeners,
    addHtml: (html) => {
      const holder = parseHtml(html, env);
      body.appendChild(holder);
      observers.filter((o) => o.active).forEach((o) => o.callback([{ addedNodes: [holder] }]));
      return holder.matches("[data-qrscan-card]") ? holder : holder.querySelector("[data-qrscan-card]");
    },
    removeNode: (node) => {
      node.remove();
      observers.filter((o) => o.active).forEach((o) => o.callback([{ addedNodes: [], removedNodes: [node] }]));
    },
  };
};

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const until = async (check, label) => {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
};

const status = (card) => card.querySelector("[data-qrscan-status]");
const codes = (card) => card.querySelectorAll("[data-qrscan-text]").map((el) => el.textContent);
const resultShown = (card) => card.querySelector("[data-qrscan-result]").hidden === false;
const fileBlob = (env, pixels, type = "image/png") => {
  const blob = new env.FakeBlob(["x"], { type });
  blob.pixels = pixels;
  return blob;
};
const chooseFile = (card, blob) => {
  const input = card.querySelector("[data-qrscan-file]");
  input.files = [blob];
  input.dispatch("change");
  return input;
};

const URL_QR = await fixture("example-url");
const TEXT_QR = await fixture("plain-text");

// ---- Tests ----

test("mounts once and leaves the panel idle without a source", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr code scanner"));
  assert.equal(card.dataset.qrscanMounted, "1");
  assert.equal(status(card).textContent, "");
  assert.equal(resultShown(card), false);
  assert.equal(env.fetches.length, 0);
  assert.equal(env.scripts.length, 0, "the decoder is only loaded when needed");
  // Registers capture-phase listeners on window, ahead of degoog's own document listeners.
  for (const type of ["dragover", "drop", "paste"]) {
    assert.ok(env.windowListeners.get(type)?.every((entry) => entry.capture), type);
  }
});

test("clicking the drop zone or pressing Enter opens the file dialog", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr"));
  const zone = card.querySelector("[data-qrscan-drop]");
  const input = card.querySelector("[data-qrscan-file]");
  zone.dispatch("click");
  zone.dispatch("keydown", { key: "Enter" });
  zone.dispatch("keydown", { key: " " });
  zone.dispatch("keydown", { key: "a" });
  assert.equal(input.clicks, 3);
});

test("decodes a chosen file with jsQR and shows the link", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr code reader"));
  const input = chooseFile(card, fileBlob(env, qrPixels(URL_QR)));
  assert.equal(input.value, "", "the input is reset so the same file can be picked again");
  await until(() => resultShown(card), "result");
  assert.deepEqual(codes(card), ["https://example.com"]);
  assert.equal(status(card).textContent, "");
  const link = card.querySelector("[data-qrscan-open]");
  assert.equal(link.getAttribute("href"), "https://example.com/");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer nofollow");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(card.querySelector("[data-qrscan-preview]").getAttribute("src"), /^blob:/);
  assert.deepEqual(env.scripts, [`${API_BASE}/decoder.js?v=1.0.0`]);
});

test("decodes inverted codes and plain text without a link", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  chooseFile(card, fileBlob(env, qrPixels(TEXT_QR, { invert: true, quiet: 4 })));
  await until(() => resultShown(card), "result");
  assert.deepEqual(codes(card), ["Hello from degoog! Ünïcödé ✓"]);
  assert.equal(card.querySelector("[data-qrscan-open]"), null);
});

test("scales tiny images up before decoding", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  chooseFile(card, fileBlob(env, qrPixels(URL_QR, { px: 1 })));
  await until(() => resultShown(card), "result");
  assert.deepEqual(codes(card), ["https://example.com"]);
});

test("reports images without a QR code, non-images and huge files", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  chooseFile(card, fileBlob(env, blank()));
  await until(() => status(card).textContent === en.qrscan.status.noCode, "no code");
  assert.equal(status(card).getAttribute("data-qrscan-kind"), "error");
  assert.equal(resultShown(card), true, "the preview stays visible");
  assert.deepEqual(codes(card), []);

  chooseFile(card, fileBlob(env, blank(), "text/plain"));
  await settle();
  assert.equal(status(card).textContent, en.qrscan.status.notImage);
  assert.equal(resultShown(card), false);

  const big = fileBlob(env, blank());
  big.size = 26 * 1024 * 1024;
  chooseFile(card, big);
  await settle();
  assert.equal(status(card).textContent, en.qrscan.status.tooLarge);

  chooseFile(card, new env.FakeBlob(["not decodable"], { type: "image/png" }));
  await until(() => status(card).textContent === en.qrscan.status.loadFailed, "load failure");
});

test("uses BarcodeDetector when it supports QR codes and lists several codes", async () => {
  class FakeDetector {
    static async getSupportedFormats() {
      return ["qr_code", "ean_13"];
    }

    async detect() {
      return [{ rawValue: "first" }, { rawValue: "second" }, { rawValue: "first" }];
    }
  }
  const env = createEnvironment({ barcodeDetector: FakeDetector });
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  chooseFile(card, fileBlob(env, blank()));
  await until(() => resultShown(card), "result");
  assert.deepEqual(codes(card), ["first", "second"]);
  assert.equal(status(card).textContent, "Found 2 QR codes.");
  assert.equal(env.scripts.length, 0, "jsQR is not needed");
});

test("falls back to jsQR when BarcodeDetector finds nothing", async () => {
  class EmptyDetector {
    static async getSupportedFormats() {
      return ["qr_code"];
    }

    async detect() {
      return [];
    }
  }
  const env = createEnvironment({ barcodeDetector: EmptyDetector });
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  chooseFile(card, fileBlob(env, qrPixels(URL_QR)));
  await until(() => resultShown(card), "result");
  assert.deepEqual(codes(card), ["https://example.com"]);
});

test("scans the image URL from the query through the signed proxy", async () => {
  const env = createEnvironment({
    fetchImpl: (url, Blob) => {
      const blob = new Blob(["x"], { type: "image/png" });
      blob.pixels = qrPixels(URL_QR);
      return { ok: true, status: 200, blob: async () => blob };
    },
  });
  env.load();
  const card = env.addHtml(await render("qr https://example.com/Code.png"));
  await until(() => resultShown(card), "result");
  assert.equal(env.fetches[0].url, signProxyUrl("https://example.com/Code.png"));
  assert.equal(env.fetches[0].options.credentials, "same-origin");
  assert.deepEqual(codes(card), ["https://example.com"]);
});

test("the bang panel scans its URL too", async () => {
  const env = createEnvironment({
    fetchImpl: (url, Blob) => {
      const blob = new Blob(["x"], { type: "image/png" });
      blob.pixels = qrPixels(TEXT_QR);
      return { ok: true, status: 200, blob: async () => blob };
    },
  });
  env.load();
  const card = env.addHtml(await commandHtml("https://example.com/text.png"));
  await until(() => resultShown(card), "result");
  assert.deepEqual(codes(card), ["Hello from degoog! Ünïcödé ✓"]);
});

test("a failed download shows an error", async () => {
  const env = createEnvironment({ fetchImpl: () => ({ ok: false, status: 415 }) });
  env.load();
  const card = env.addHtml(await render("scan qr https://example.com/page.html"));
  await until(() => status(card).textContent === en.qrscan.status.loadFailed, "error");
  assert.equal(resultShown(card), false);
});

test("decodes data URLs locally without fetching", async () => {
  const env = createEnvironment({ pixelsForBytes: (text) => (text === "QR:url" ? qrPixels(URL_QR) : null) });
  env.load();
  const data = `data:image/png;base64,${Buffer.from("QR:url").toString("base64")}`;
  const card = env.addHtml(await render(`qr ${data}`));
  await until(() => resultShown(card), "result");
  assert.deepEqual(codes(card), ["https://example.com"]);
  assert.equal(env.fetches.length, 0);
});

test("scans a URL typed into the field on Enter or the Scan button", async () => {
  const env = createEnvironment({
    fetchImpl: (url, Blob) => {
      const blob = new Blob(["x"], { type: "image/png" });
      blob.pixels = qrPixels(URL_QR);
      return { ok: true, status: 200, blob: async () => blob };
    },
  });
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  const input = card.querySelector("[data-qrscan-url]");
  input.value = "  https://example.com/a b.png ";
  let stopped = false;
  input.dispatch("keydown", { key: "Enter", stopPropagation: () => (stopped = true) });
  assert.equal(stopped, true, "Enter does not reach page shortcuts");
  await until(() => resultShown(card), "result");
  assert.equal(env.fetches[0].url, `${card.dataset.qrscanSign}&url=${encodeURIComponent("https://example.com/a b.png")}`);

  input.value = "javascript:alert(1)";
  card.querySelector("[data-qrscan-scan]").dispatch("click");
  assert.equal(status(card).textContent, en.qrscan.status.badUrl);
  assert.equal(resultShown(card), false);
  assert.equal(env.fetches.length, 1);
});

test("paste is only claimed when the panel has focus, or it is the only panel and nothing has focus", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  const image = fileBlob(env, qrPixels(URL_QR));
  const clipboardData = { files: [image], getData: () => "" };

  // Focus in the search box: never ours.
  const searchBox = env.document.createElement("input");
  env.body.appendChild(searchBox);
  env.document.activeElement = searchBox;
  let calls = env.fireWindow("paste", { clipboardData });
  assert.deepEqual(calls, { prevented: false, stopped: false });
  assert.equal(resultShown(card), false);

  // Nothing focused and a single panel: the image goes to it.
  env.document.activeElement = env.body;
  calls = env.fireWindow("paste", { clipboardData });
  assert.equal(calls.prevented && calls.stopped, true);
  await until(() => resultShown(card), "result");

  // Text pasted while nothing is focused is left to the page.
  calls = env.fireWindow("paste", { clipboardData: { files: [], getData: () => "https://example.com/x.png" } });
  assert.equal(calls.prevented, false);
});

test("paste into the panel takes images and URLs, and leaves other typing in the URL field alone", async () => {
  const env = createEnvironment({
    fetchImpl: (url, Blob) => {
      const blob = new Blob(["x"], { type: "image/png" });
      blob.pixels = qrPixels(TEXT_QR);
      return { ok: true, status: 200, blob: async () => blob };
    },
  });
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  const zone = card.querySelector("[data-qrscan-drop]");
  const input = card.querySelector("[data-qrscan-url]");

  zone.focus();
  let calls = env.fireWindow("paste", { clipboardData: { files: [], getData: () => "https://example.com/t.png" } });
  assert.equal(calls.prevented, true);
  assert.equal(input.value, "https://example.com/t.png");
  await until(() => resultShown(card), "result");
  assert.deepEqual(codes(card), ["Hello from degoog! Ünïcödé ✓"]);

  zone.focus();
  calls = env.fireWindow("paste", { clipboardData: { files: [], getData: () => "hello" } });
  assert.equal(calls.prevented, true);
  assert.equal(status(card).textContent, en.qrscan.status.badUrl);

  input.focus();
  calls = env.fireWindow("paste", { clipboardData: { files: [], getData: () => "half a thought" } });
  assert.deepEqual(calls, { prevented: false, stopped: false });
});

test("drops on the panel are claimed before degoog's image search sees them", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  const zone = card.querySelector("[data-qrscan-drop]");
  const dataTransfer = { types: ["Files"], files: [fileBlob(env, qrPixels(URL_QR))], getData: () => "" };

  let calls = env.fireWindow("dragover", { target: zone, dataTransfer });
  assert.equal(calls.prevented && calls.stopped, true);
  assert.equal(dataTransfer.dropEffect, "copy");
  assert.ok(zone.classList.contains("qrscan-drop--over"));

  env.fireWindow("dragleave", { target: zone, relatedTarget: card.querySelector("[data-qrscan-url]") });
  assert.ok(zone.classList.contains("qrscan-drop--over"), "moving within the card keeps the highlight");
  env.fireWindow("dragleave", { target: zone, relatedTarget: env.body });
  assert.ok(!zone.classList.contains("qrscan-drop--over"));

  calls = env.fireWindow("drop", { target: zone, dataTransfer });
  assert.equal(calls.prevented && calls.stopped, true);
  await until(() => resultShown(card), "result");
  assert.deepEqual(codes(card), ["https://example.com"]);

  // Drops elsewhere on the page are not ours.
  calls = env.fireWindow("drop", { target: env.body, dataTransfer });
  assert.deepEqual(calls, { prevented: false, stopped: false });
});

test("dropping an image from another tab uses its URL", async () => {
  const env = createEnvironment({
    fetchImpl: (url, Blob) => {
      const blob = new Blob(["x"], { type: "image/png" });
      blob.pixels = qrPixels(URL_QR);
      return { ok: true, status: 200, blob: async () => blob };
    },
  });
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  const dataTransfer = {
    types: ["text/uri-list", "text/plain"],
    files: [],
    getData: (type) => (type === "text/uri-list" ? "# comment\r\nhttps://example.com/drag.png" : ""),
  };
  env.fireWindow("drop", { target: card.querySelector("[data-qrscan-drop]"), dataTransfer });
  await until(() => resultShown(card), "result");
  assert.equal(env.fetches[0].url, `${card.dataset.qrscanSign}&url=${encodeURIComponent("https://example.com/drag.png")}`);
});

test("copies results with the clipboard API or the execCommand fallback, and resets the label", async () => {
  for (const clipboard of [true, false]) {
    const env = createEnvironment({ clipboard });
    env.load();
    const card = env.addHtml(await render("qr scanner"));
    chooseFile(card, fileBlob(env, qrPixels(URL_QR)));
    await until(() => resultShown(card), "result");
    const button = card.querySelector("[data-qrscan-copy]");
    assert.equal(button.getAttribute("aria-label"), "Copy");
    button.dispatch("click");
    await settle(5);
    button.dispatch("click");
    await settle(5);
    if (clipboard) assert.deepEqual(env.copied, ["https://example.com", "https://example.com"]);
    else assert.deepEqual(env.execCommands, ["copy", "copy"]);
    assert.equal(button.getAttribute("aria-label"), "Copied");
    assert.equal(env.timeouts.size, 1, "a repeat click replaces the pending reset");
    env.runTimeouts();
    assert.equal(button.getAttribute("aria-label"), "Copy");
    assert.ok(!button.classList.contains("qrscan-copy--done"));
  }
});

test("Scan another image clears the result", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  chooseFile(card, fileBlob(env, qrPixels(URL_QR)));
  await until(() => resultShown(card), "result");
  const preview = card.querySelector("[data-qrscan-preview]").getAttribute("src");
  card.querySelector("[data-qrscan-reset]").dispatch("click");
  assert.equal(resultShown(card), false);
  assert.deepEqual(codes(card), []);
  assert.ok(env.revoked.includes(preview));
  assert.equal(env.document.activeElement, card.querySelector("[data-qrscan-drop]"));
});

test("a scan carries over to the second at-a-glance render", async () => {
  const env = createEnvironment();
  env.load();
  const first = env.addHtml(await render("qr scanner"));
  chooseFile(first, fileBlob(env, qrPixels(URL_QR)));
  await until(() => resultShown(first), "result");

  env.removeNode(first);
  const second = env.addHtml(await render("qr scanner"));
  assert.equal(resultShown(second), true);
  assert.deepEqual(codes(second), ["https://example.com"]);
});

test("a scan still running when the panel is replaced lands in the new panel", async () => {
  const env = createEnvironment();
  env.load();
  const first = env.addHtml(await render("qr scanner"));
  chooseFile(first, fileBlob(env, qrPixels(URL_QR)));
  env.removeNode(first);
  const second = env.addHtml(await render("qr scanner"));
  await until(() => resultShown(second), "result in the new panel");
  assert.deepEqual(codes(second), ["https://example.com"]);
});

test("remounted panels with the same source reuse the result", async () => {
  let downloads = 0;
  const env = createEnvironment({
    fetchImpl: (url, Blob) => {
      downloads += 1;
      const blob = new Blob(["x"], { type: "image/png" });
      blob.pixels = qrPixels(URL_QR);
      return { ok: true, status: 200, blob: async () => blob };
    },
  });
  env.load();
  const html = await render("qr https://example.com/Code.png");
  const first = env.addHtml(html);
  await until(() => resultShown(first), "first result");
  env.removeNode(first);
  const second = env.addHtml(html);
  await settle();
  assert.equal(resultShown(second), true);
  assert.equal(downloads, 1);
});

test("rescans the page after the back-forward cache restores it", async () => {
  const env = createEnvironment();
  env.load();
  env.fireWindow("pageshow", { persisted: true });
  const card = env.addHtml(await render("qr"));
  assert.equal(card.dataset.qrscanMounted, "1");
  env.fireWindow("pageshow", { persisted: true });
  assert.equal(card.dataset.qrscanMounted, "1");
});

// ---- Pasted SVG markup and base64 ----

const URL_SVG = qrSvg(URL_QR);
const b64 = (text) => Buffer.from(text, "latin1").toString("base64");
const imageBytes = (magic) => `${magic}${"\0".repeat(24)}QR:url`;
const withQrBytes = { pixelsForBytes: (text) => (text.includes("QR:url") ? qrPixels(URL_QR) : null) };

test("decodes SVG markup pasted into the panel, giving it a size and namespace first", async () => {
  for (const svg of [URL_SVG, qrSvg(URL_QR, { xmlns: false }), qrSvg(URL_QR, { size: true })]) {
    const env = createEnvironment();
    env.load();
    const card = env.addHtml(await render("qr scanner"));
    card.querySelector("[data-qrscan-drop]").focus();
    const calls = env.fireWindow("paste", { clipboardData: { files: [], getData: (t) => (t === "text/plain" ? svg : "") } });
    assert.equal(calls.prevented && calls.stopped, true);
    await until(() => resultShown(card), "result");
    assert.deepEqual(codes(card), ["https://example.com"]);
    const drawn = env.svgSeen.at(-1);
    assert.match(drawn, /^<svg width="1024" height="1024"/);
    assert.match(drawn, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    if (!svg.includes("viewBox")) assert.match(drawn, /viewBox="0 0 33 33"/, "a sized SVG keeps its scale");
  }
});

test("keeps the aspect ratio of wide SVGs", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  card.querySelector("[data-qrscan-drop]").focus();
  const wide = URL_SVG.replace(/viewBox="0 0 33 33"/, 'viewBox="0 0 66 33"');
  env.fireWindow("paste", { clipboardData: { files: [], getData: () => wide } });
  await until(() => env.svgSeen.length > 0, "svg drawn");
  assert.match(env.svgSeen[0], /^<svg width="1024" height="512"/);
});

test("accepts SVG with an XML declaration, as an SVG file, as a data URL and as a drop", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  const input = card.querySelector("[data-qrscan-url]");

  input.value = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by a generator -->\n${URL_SVG}`;
  input.dispatch("keydown", { key: "Enter" });
  await until(() => resultShown(card), "declaration result");
  assert.equal(input.value, "", "markup is not left in the URL field");

  card.querySelector("[data-qrscan-reset]").dispatch("click");
  chooseFile(card, new env.FakeBlob([URL_SVG], { type: "image/svg+xml" }));
  await until(() => resultShown(card), "file result");

  card.querySelector("[data-qrscan-reset]").dispatch("click");
  input.value = `data:image/svg+xml;base64,${Buffer.from(URL_SVG).toString("base64")}`;
  card.querySelector("[data-qrscan-scan]").dispatch("click");
  await until(() => resultShown(card), "data URL result");

  card.querySelector("[data-qrscan-reset]").dispatch("click");
  const dataTransfer = { types: ["text/plain"], files: [], getData: (t) => (t === "text/plain" ? URL_SVG : "") };
  env.fireWindow("drop", { target: card.querySelector("[data-qrscan-drop]"), dataTransfer });
  await until(() => resultShown(card), "drop result");
  assert.deepEqual(codes(card), ["https://example.com"]);
  assert.equal(env.fetches.length, 0, "nothing is fetched");
});

test("decodes raw base64 PNG, JPEG and GIF data", async () => {
  const samples = {
    "image/png": imageBytes("\x89PNG\r\n\x1a\n"),
    "image/jpeg": imageBytes("\xff\xd8\xff\xe0"),
    "image/gif": imageBytes("GIF89a"),
    "image/gif87": imageBytes("GIF87a"),
  };
  for (const [label, bytes] of Object.entries(samples)) {
    const env = createEnvironment(withQrBytes);
    env.load();
    const card = env.addHtml(await render("qr scanner"));
    card.querySelector("[data-qrscan-url]").focus();
    const text = b64(bytes).replace(/(.{20})/g, "$1\n");
    const clipboardData = { files: [], getData: (type) => (type === "text/plain" ? text : "") };
    const calls = env.fireWindow("paste", { clipboardData });
    assert.equal(calls.prevented, true, label);
    await until(() => resultShown(card), label);
    assert.deepEqual(codes(card), ["https://example.com"], label);
  }
});

test("accepts URL-safe base64 and base64 typed into the URL field", async () => {
  const env = createEnvironment(withQrBytes);
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  const input = card.querySelector("[data-qrscan-url]");
  input.value = b64(imageBytes("\xff\xd8\xff\xe0") + "\xfb\xff").replace(/\+/g, "-").replace(/\//g, "_");
  input.dispatch("keydown", { key: "Enter" });
  await until(() => resultShown(card), "result");
  assert.equal(input.value, "");
});

test("pastes image data while nothing has focus, but not plain text or URLs", async () => {
  const env = createEnvironment(withQrBytes);
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  env.document.activeElement = env.body;
  let calls = env.fireWindow("paste", { clipboardData: { files: [], getData: () => b64(imageBytes("GIF89a")) } });
  assert.equal(calls.prevented, true);
  await until(() => resultShown(card), "result");
  calls = env.fireWindow("paste", { clipboardData: { files: [], getData: () => "just some words" } });
  assert.equal(calls.prevented, false);
});

test("rejects text that only looks like image data", async () => {
  const env = createEnvironment(withQrBytes);
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  const input = card.querySelector("[data-qrscan-url]");
  for (const value of [
    b64("This is a long piece of plain text, not an image."),
    b64("\x89PNG").slice(0, 8),
    "<svg><g>never closed",
    "<html><svg></svg></html>",
  ]) {
    input.value = value;
    card.querySelector("[data-qrscan-scan]").dispatch("click");
    await settle(5);
    assert.equal(status(card).textContent, en.qrscan.status.badUrl, value);
    assert.equal(resultShown(card), false, value);
  }
  // SVG without the closing tag pasted into the URL field is left to the field.
  input.focus();
  const calls = env.fireWindow("paste", { clipboardData: { files: [], getData: () => "<svg width=" } });
  assert.equal(calls.prevented, false);
});

test("an SVG that cannot be drawn reports a load failure", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  chooseFile(card, new env.FakeBlob(["<svg"], { type: "image/svg+xml" }));
  await until(() => status(card).textContent === en.qrscan.status.loadFailed, "load failure");
});

test("the panel scans SVG and base64 given in the search or the bang", async () => {
  const env = createEnvironment(withQrBytes);
  env.load();
  const fromQuery = env.addHtml(await render(`scan qr ${URL_SVG}`));
  await until(() => resultShown(fromQuery), "query svg");
  assert.deepEqual(codes(fromQuery), ["https://example.com"]);
  env.removeNode(fromQuery);
  const fromBang = env.addHtml(await commandHtml(b64(imageBytes("\x89PNG\r\n\x1a\n"))));
  await until(() => resultShown(fromBang), "bang base64");
  assert.deepEqual(codes(fromBang), ["https://example.com"]);
  assert.equal(env.fetches.length, 0);
});

// ---- Review regressions ----

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const imageResponse = (Blob, rows) => {
  const blob = new Blob(["x"], { type: "image/png" });
  blob.pixels = qrPixels(rows);
  return { ok: true, status: 200, blob: async () => blob };
};

const typeUrl = (card, url) => {
  const input = card.querySelector("[data-qrscan-url]");
  input.value = url;
  input.dispatch("keydown", { key: "Enter" });
};

test("a slow scan never overwrites a newer result shown from the cache", async () => {
  const slow = deferred();
  const env = createEnvironment({
    fetchImpl: (url, Blob) => (url.includes("slow.png") ? slow.promise.then(() => imageResponse(Blob, TEXT_QR)) : imageResponse(Blob, URL_QR)),
  });
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  typeUrl(card, "https://example.com/fast.png");
  await until(() => resultShown(card), "first fast result");
  typeUrl(card, "https://example.com/slow.png");
  await settle();
  typeUrl(card, "https://example.com/fast.png");
  await until(() => resultShown(card), "cached fast result");
  slow.resolve();
  await settle();
  assert.deepEqual(codes(card), ["https://example.com"]);
  // The cached result also counts as the latest scan for the second render.
  env.removeNode(card);
  const second = env.addHtml(await render("qr scanner"));
  assert.deepEqual(codes(second), ["https://example.com"]);
});

test("both glance renders share one download and decode of the query's image", async () => {
  const gate = deferred();
  const env = createEnvironment({ fetchImpl: (url, Blob) => gate.promise.then(() => imageResponse(Blob, URL_QR)) });
  env.load();
  const html = await render("qr https://example.com/Code.png");
  const first = env.addHtml(html);
  await settle(5);
  env.removeNode(first);
  const second = env.addHtml(html);
  gate.resolve();
  await until(() => resultShown(second), "second render result");
  assert.equal(env.fetches.length, 1);
  assert.deepEqual(codes(second), ["https://example.com"]);
});

test("failed downloads are not cached, so trying again fetches again", async () => {
  let fail = true;
  const env = createEnvironment({ fetchImpl: (url, Blob) => (fail ? { ok: false, status: 502 } : imageResponse(Blob, URL_QR)) });
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  typeUrl(card, "https://example.com/a.png");
  await until(() => status(card).textContent === en.qrscan.status.loadFailed, "failure");
  fail = false;
  typeUrl(card, "https://example.com/a.png");
  await until(() => resultShown(card), "retry result");
  assert.equal(env.fetches.length, 2);
});

test("only a few finished scans are kept", async () => {
  const env = createEnvironment({ fetchImpl: (url, Blob) => imageResponse(Blob, URL_QR) });
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  for (let i = 0; i < 10; i += 1) {
    typeUrl(card, `https://example.com/${i}.png`);
    await until(() => resultShown(card), `scan ${i}`);
  }
  assert.equal(env.fetches.length, 10);
  typeUrl(card, "https://example.com/9.png");
  await until(() => resultShown(card), "recent scan");
  assert.equal(env.fetches.length, 10, "a recent scan comes from the cache");
  typeUrl(card, "https://example.com/0.png");
  await until(() => resultShown(card), "old scan");
  assert.equal(env.fetches.length, 11, "the oldest scans were dropped");
});

test("a removed panel frees its preview", async () => {
  const env = createEnvironment();
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  chooseFile(card, fileBlob(env, qrPixels(URL_QR)));
  await until(() => resultShown(card), "result");
  const preview = card.querySelector("[data-qrscan-preview]").getAttribute("src");
  env.removeNode(card);
  assert.ok(env.revoked.includes(preview));
});

test("a scan only carries over to the second render of the same search", async () => {
  const env = createEnvironment();
  env.load();
  const first = env.addHtml(await render("qr scanner"));
  chooseFile(first, fileBlob(env, qrPixels(URL_QR)));
  await until(() => resultShown(first), "result");
  env.removeNode(first);
  const other = env.addHtml(await render("scan qr code"));
  assert.equal(resultShown(other), false, "a different search starts empty");
  env.removeNode(other);
  const same = env.addHtml(await render("qr scanner"));
  assert.equal(resultShown(same), true);
  assert.deepEqual(codes(same), ["https://example.com"]);
});

test("an expired panel says to search again", async () => {
  const env = createEnvironment({ fetchImpl: () => ({ ok: false, status: 403 }) });
  env.load();
  const card = env.addHtml(await render("qr scanner"));
  typeUrl(card, "https://example.com/a.png");
  await until(() => status(card).textContent === en.qrscan.status.expired, "expired");
});

test("with image links turned off, a pasted link explains why it isn't scanned", async () => {
  slot.configure({ bareQr: "true", imageUrls: "false" });
  try {
    const env = createEnvironment();
    env.load();
    const card = env.addHtml(await render("qr scanner"));
    typeUrl(card, "https://example.com/a.png");
    assert.equal(status(card).textContent, en.qrscan.status.urlsOff);
    assert.equal(env.fetches.length, 0);
  } finally {
    slot.configure({ bareQr: "true", imageUrls: "true" });
  }
});
