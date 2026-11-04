(function () {
  "use strict";

  const CARD_SELECTOR = "[data-qrscan-card]";
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_CODES = 5;
  const COPY_FEEDBACK_MS = 1200;
  // The at-a-glance panel is rendered twice. A scan in the first copy moves to the second copy of the same
  // search within this time.
  const RESTORE_MS = 20000;
  // Finished scans of image links and data URLs kept for re-renders. Each holds an image of up to MAX_BYTES.
  const MAX_JOBS = 8;
  // Longest side, in pixels, of each attempt with jsQR. Big photos are scaled down first, which is faster and
  // often more reliable. Tiny images are scaled up.
  const SCAN_SIZES = [1600, 800, 3000];
  const MIN_SCAN_SIZE = 400;
  const SVG_RENDER_SIZE = 1024;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const states = new WeakMap();
  const originalLabels = new WeakMap();
  const resetTimers = new WeakMap();
  const jobs = new Map();
  let lastScan = null;
  let decoderPromise = null;
  let nativeDetector;

  // The block between the shared-core markers is a verbatim copy of the one in index.js.
  // <shared-core>
  // Kept identical in index.js and script.js; tests/qr-scanner.test.mjs checks that the copies match.
  // Everything in here is linear in the length of its input, because it runs on whole search queries.
  const MIN_BASE64_LENGTH = 32;
  const SVG_PROLOG_WINDOW = 4096;
  const SVG_PROLOG_PARTS = 16;

  /** The image type of decoded leading bytes: PNG, JPEG or GIF, or "". */
  const sniffImageType = (head) => {
    if (head.startsWith("\x89PNG")) return "image/png";
    if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
    if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
    return "";
  };

  /** Raw base64 of a PNG, JPEG or GIF (whitespace and URL-safe characters allowed) → { type, base64 }, else null. */
  const parseBase64Image = (text) => {
    const compact = String(text ?? "").replace(/\s+/g, "");
    if (compact.length < MIN_BASE64_LENGTH || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
    const base64 = compact.replace(/-/g, "+").replace(/_/g, "/");
    let head = "";
    try {
      head = atob(base64.slice(0, 16));
    } catch {
      return null;
    }
    const type = sniffImageType(head);
    return type ? { type, base64 } : null;
  };

  /**
   * Finds SVG markup with plain string searches: from the first <svg tag, widened to take in an XML declaration,
   * comments or a doctype right before it, up to the last </svg>. Returns { start, open, end } (open is where
   * the <svg tag itself starts) or null.
   */
  const findSvgMarkup = (text) => {
    const lower = String(text ?? "").toLowerCase();
    let open = -1;
    for (let i = lower.indexOf("<svg"); i >= 0; i = lower.indexOf("<svg", i + 4)) {
      const next = lower.charAt(i + 4);
      if (next === ">" || /\s/.test(next)) {
        open = i;
        break;
      }
    }
    if (open < 0) return null;
    const close = lower.lastIndexOf("</svg>");
    if (close < open) return null;
    let start = open;
    for (let part = 0; part < SVG_PROLOG_PARTS; part += 1) {
      let end = start;
      while (end > 0 && /\s/.test(lower.charAt(end - 1))) end -= 1;
      if (end === 0 || lower.charAt(end - 1) !== ">") break;
      const from = Math.max(0, end - SVG_PROLOG_WINDOW);
      const recent = lower.slice(from, end);
      const at = Math.max(recent.lastIndexOf("<?xml"), recent.lastIndexOf("<!--"), recent.lastIndexOf("<!doctype"));
      if (at < 0) break;
      const piece = recent.slice(at);
      const complete = piece.startsWith("<!--") ? piece.endsWith("-->") : piece.startsWith("<?xml") ? piece.endsWith("?>") : true;
      if (!complete) break;
      start = from + at;
    }
    return { start, open, end: close + 6 };
  };
  // </shared-core>

  // ---- Helpers ----

  const message = (card, key, vars) => {
    const text = card.getAttribute(`data-qrscan-msg-${key}`) || "";
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
  };

  const part = (card, name) => card.querySelector(`[data-qrscan-${name}]`);

  const stateOf = (card) => {
    let state = states.get(card);
    if (!state) {
      state = { token: 0, running: false, previewUrl: "", blob: null, codes: null };
      states.set(card, state);
    }
    return state;
  };

  const isWebUrl = (text) => {
    if (!/^https?:\/\//i.test(text)) return false;
    try {
      const url = new URL(text);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  };

  const isDataImage = (text) => /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=._+-]+)*,/i.test(text);

  const setStatus = (card, text, kind) => {
    const status = part(card, "status");
    if (!status) return;
    status.textContent = text || "";
    status.setAttribute("data-qrscan-kind", kind || "");
  };

  const wait = () => new Promise((resolve) => window.setTimeout(resolve, 0));

  /** A Blob from a data: URL, decoded here because the page's CSP may block fetch() of data: URLs. */
  const dataUrlBlob = (text) => {
    const comma = text.indexOf(",");
    const match = comma > 0 ? /^data:([^;,]+)((?:;[^;,]*)*)$/i.exec(text.slice(0, comma)) : null;
    if (!match) return null;
    const type = match[1].toLowerCase();
    const body = text.slice(comma + 1);
    try {
      if (/;base64/i.test(match[2])) {
        const binary = atob(body.replace(/\s+/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type });
      }
      return new Blob([decodeURIComponent(body)], { type });
    } catch {
      return null;
    }
  };

  // ---- Pasted image text: SVG markup and raw base64 ----

  /** True when the whole text is SVG markup (with an optional XML declaration, comments or doctype). */
  const isSvgText = (text) => {
    const found = findSvgMarkup(text);
    return Boolean(found) && !text.slice(0, found.start).trim() && !text.slice(found.end).trim();
  };

  /** Raw base64 of a PNG, JPEG or GIF → a data URL, else "". */
  const base64DataUrl = (text) => {
    const parsed = parseBase64Image(text);
    if (!parsed || parsed.base64.length > (MAX_BYTES / 3) * 4 + 4) return "";
    return `data:${parsed.type};base64,${parsed.base64}`;
  };

  const isSvgBlob = (blob) => /svg/i.test(blob.type || "") || /\.svgz?$/i.test(blob.name || "");

  const svgLength = (value) => {
    const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:px)?\s*$/i.exec(value || "");
    const n = match ? Number(match[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  /**
   * Gives the root <svg> explicit pixel dimensions (longest side SVG_RENDER_SIZE) and the namespace an <img>
   * needs. Firefox can't draw an SVG without a width and height onto a canvas, and markup copied from a page
   * often lacks xmlns. Returns the new markup, or null when there is no <svg> tag.
   */
  const sizedSvg = (text) => {
    const found = findSvgMarkup(text);
    if (!found) return null;
    const openAt = found.open;
    const close = text.indexOf(">", openAt);
    if (close < 0) return null;
    let tag = text.slice(openAt, close + 1);
    const attr = (name) => {
      const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
      return match ? (match[1] ?? match[2]) : "";
    };
    const width = svgLength(attr("width"));
    const height = svgLength(attr("height"));
    const box = attr("viewBox").trim().split(/[\s,]+/).map(Number);
    const hasBox = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
    const ratio = hasBox ? box[2] / box[3] : width && height ? width / height : 1;
    const w = ratio >= 1 ? SVG_RENDER_SIZE : Math.max(1, Math.round(SVG_RENDER_SIZE * ratio));
    const h = ratio >= 1 ? Math.max(1, Math.round(SVG_RENDER_SIZE / ratio)) : SVG_RENDER_SIZE;
    tag = tag.replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
    let extra = ` width="${w}" height="${h}"`;
    // Without a viewBox, a new width and height would crop the drawing instead of scaling it.
    if (!hasBox && width && height) extra += ` viewBox="0 0 ${width} ${height}"`;
    if (!/\sxmlns\s*=/i.test(tag)) extra += ` xmlns="${SVG_NS}"`;
    if (/xlink:/i.test(text) && !/\sxmlns:xlink\s*=/i.test(tag)) extra += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    tag = tag.replace(/^<svg/i, `<svg${extra}`);
    return text.slice(0, openAt) + tag + text.slice(close + 1);
  };

  const readText = async (blob) => {
    if (typeof blob.text === "function") return blob.text();
    return new Response(blob).text();
  };

  /** An SVG blob with explicit dimensions, or null when it isn't usable SVG. */
  const prepareSvg = async (blob) => {
    try {
      const sized = sizedSvg(await readText(blob));
      return sized ? new Blob([sized], { type: "image/svg+xml" }) : null;
    } catch {
      return null;
    }
  };

  /** Text the panel knows how to scan: a web URL, a data URL, SVG markup or raw base64 image data. */
  const isScannableText = (text) => isWebUrl(text) || isDataImage(text) || isSvgText(text) || Boolean(base64DataUrl(text));

  // ---- Decoding ----

  const loadImage = (blob) =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("load"));
      };
      img.src = url;
    });

  const getNativeDetector = async () => {
    if (nativeDetector !== undefined) return nativeDetector;
    nativeDetector = null;
    try {
      if (typeof BarcodeDetector === "function") {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (Array.isArray(formats) && formats.includes("qr_code")) {
          nativeDetector = new BarcodeDetector({ formats: ["qr_code"] });
        }
      }
    } catch {
      nativeDetector = null;
    }
    return nativeDetector;
  };

  const loadDecoder = (card) => {
    if (typeof window.jsQR === "function") return Promise.resolve(window.jsQR);
    if (decoderPromise) return decoderPromise;
    const src = card.dataset.qrscanDecoder;
    if (!src) return Promise.reject(new Error("no decoder"));
    decoderPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => {
        if (typeof window.jsQR === "function") resolve(window.jsQR);
        else reject(new Error("decoder"));
      };
      script.onerror = () => reject(new Error("decoder"));
      (document.head || document.body).appendChild(script);
    }).catch((error) => {
      decoderPromise = null;
      throw error;
    });
    return decoderPromise;
  };

  const scanSizes = (width, height) => {
    const longest = Math.max(width, height);
    const sizes = [];
    SCAN_SIZES.forEach((size) => {
      const target = Math.min(longest, size);
      if (!sizes.includes(target)) sizes.push(target);
    });
    if (longest < MIN_SCAN_SIZE) sizes.push(MIN_SCAN_SIZE);
    return sizes;
  };

  /** Runs jsQR over the image at a few sizes, on a white canvas with a quiet zone around it. */
  const decodeWithJsQR = async (jsQR, img) => {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return [];
    for (const size of scanSizes(width, height)) {
      const scale = size / Math.max(width, height);
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const margin = Math.round(Math.max(w, h) * 0.08) + 8;
      const canvas = document.createElement("canvas");
      canvas.width = w + margin * 2;
      canvas.height = h + margin * 2;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return [];
      ctx.imageSmoothingEnabled = scale <= 1;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, margin, margin, w, h);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
      if (found && typeof found.data === "string" && found.data) return [found.data];
      await wait();
    }
    return [];
  };

  const decodeImage = async (card, img) => {
    const detector = await getNativeDetector();
    if (detector) {
      try {
        const found = await detector.detect(img);
        const values = [];
        (found || []).forEach((code) => {
          const value = typeof code?.rawValue === "string" ? code.rawValue : "";
          if (value && !values.includes(value) && values.length < MAX_CODES) values.push(value);
        });
        if (values.length) return values;
      } catch {
        // Fall back to jsQR below.
      }
    }
    return decodeWithJsQR(await loadDecoder(card), img);
  };

  /** Checks, prepares and decodes an image. Resolves to { blob, codes } or { error: <message key> }. */
  const decodeInput = async (card, input) => {
    if (!input) return { error: "loadfailed" };
    if (input.type && !/^image\//i.test(input.type)) return { error: "notimage" };
    if (input.size > MAX_BYTES) return { error: "toolarge" };
    const blob = isSvgBlob(input) ? await prepareSvg(input) : input;
    if (!blob) return { error: "loadfailed" };
    let loaded;
    try {
      loaded = await loadImage(blob);
    } catch {
      return { error: "loadfailed" };
    }
    try {
      return { blob, codes: await decodeImage(card, loaded.img) };
    } catch {
      return { error: "loadfailed" };
    } finally {
      URL.revokeObjectURL(loaded.url);
    }
  };

  // ---- Rendering ----

  const copyText = async (button, value, card) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
      } finally {
        area.remove();
      }
    }
    if (!originalLabels.has(button)) originalLabels.set(button, button.getAttribute("aria-label") || "");
    const original = originalLabels.get(button);
    const copied = message(card, "copied");
    button.classList.add("qrscan-copy--done");
    button.setAttribute("aria-label", copied);
    button.setAttribute("title", copied);
    window.clearTimeout(resetTimers.get(button));
    resetTimers.set(
      button,
      window.setTimeout(() => {
        resetTimers.delete(button);
        button.classList.remove("qrscan-copy--done");
        button.setAttribute("aria-label", original);
        button.setAttribute("title", original);
      }, COPY_FEEDBACK_MS),
    );
  };

  const iconButton = (tag, cls, label, icon) => {
    const el = document.createElement(tag);
    el.className = `degoog-icon-btn ${cls}`;
    el.setAttribute("aria-label", label);
    el.setAttribute("title", label);
    const i = document.createElement("i");
    i.className = icon;
    i.setAttribute("aria-hidden", "true");
    el.appendChild(i);
    return el;
  };

  const codeItem = (card, value) => {
    const item = document.createElement("li");
    item.className = "qrscan-code";
    item.setAttribute("data-qrscan-code", "");
    const text = document.createElement("pre");
    text.className = "qrscan-text";
    text.setAttribute("data-qrscan-text", "");
    text.textContent = value;
    item.appendChild(text);
    const actions = document.createElement("div");
    actions.className = "qrscan-actions";
    if (isWebUrl(value.trim())) {
      const link = iconButton("a", "qrscan-open", message(card, "open"), "fa-solid fa-arrow-up-right-from-square");
      link.setAttribute("href", new URL(value.trim()).href);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer nofollow");
      link.setAttribute("data-qrscan-open", "");
      actions.appendChild(link);
    }
    const copy = iconButton("button", "qrscan-copy", message(card, "copy"), "fa-regular fa-copy");
    copy.setAttribute("type", "button");
    copy.setAttribute("data-qrscan-copy", "");
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyText(copy, value, card);
    });
    actions.appendChild(copy);
    item.appendChild(actions);
    return item;
  };

  const setPreview = (card, blob) => {
    const state = stateOf(card);
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = blob ? URL.createObjectURL(blob) : "";
    const preview = part(card, "preview");
    if (preview) {
      if (state.previewUrl) preview.setAttribute("src", state.previewUrl);
      else preview.removeAttribute?.("src");
    }
  };

  /** Empties the result area and starts a new scan generation, so older scans can no longer write to it. */
  const clearResult = (card) => {
    const state = stateOf(card);
    state.token += 1;
    state.running = false;
    state.blob = null;
    state.codes = null;
    setPreview(card, null);
    const codes = part(card, "codes");
    if (codes) codes.textContent = "";
    const result = part(card, "result");
    if (result) result.hidden = true;
    setStatus(card, "", "");
  };

  const showResult = (card, blob, codes) => {
    const state = stateOf(card);
    state.blob = blob;
    state.codes = codes;
    setPreview(card, blob);
    const list = part(card, "codes");
    if (list) {
      list.textContent = "";
      codes.forEach((value) => list.appendChild(codeItem(card, value)));
    }
    const result = part(card, "result");
    if (result) result.hidden = false;
    if (!codes.length) setStatus(card, message(card, "nocode"), "error");
    else if (codes.length > 1) setStatus(card, message(card, "foundmany", { count: codes.length }), "");
    else setStatus(card, "", "");
  };

  /** Shows a result in a card that may have something else going on, cancelling that first. */
  const showFresh = (card, blob, codes) => {
    clearResult(card);
    showResult(card, blob, codes);
  };

  /** The idle copy of the same search that can take over a scan from a replaced card, or null. */
  const takeoverCard = (key) => {
    if (!key) return null;
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const state = stateOf(card);
      if (
        card.isConnected &&
        card.dataset.qrscanMounted === "1" &&
        card.dataset.qrscanKey === key &&
        !card.dataset.qrscanSrc &&
        !state.codes &&
        !state.running
      ) {
        return card;
      }
    }
    return null;
  };

  /**
   * Shows the outcome of a scan, unless the card has moved on to another one. With `carry`, a finished scan is
   * remembered for the second render of the same search and handed to it if this card was replaced meanwhile.
   */
  const present = (card, token, outcome, carry) => {
    const state = stateOf(card);
    if (state.token !== token) return;
    state.running = false;
    if (outcome.error) {
      setStatus(card, message(card, outcome.error), "error");
      return;
    }
    const target = card.isConnected ? card : carry ? takeoverCard(card.dataset.qrscanKey) : null;
    if (carry) lastScan = { card: target || card, key: card.dataset.qrscanKey || "", blob: outcome.blob, codes: outcome.codes, at: Date.now() };
    if (target === card) showResult(card, outcome.blob, outcome.codes);
    else if (target) showFresh(target, outcome.blob, outcome.codes);
  };

  // ---- Scanning ----

  const scanBlob = async (card, input) => {
    clearResult(card);
    const state = stateOf(card);
    const token = state.token;
    state.running = true;
    setStatus(card, message(card, "decoding"), "");
    present(card, token, await decodeInput(card, input), true);
  };

  const fetchInput = async (src) => {
    if (isDataImage(src)) {
      const blob = dataUrlBlob(src);
      return blob ? { blob } : { error: "loadfailed" };
    }
    let response;
    try {
      response = await fetch(src, { credentials: "same-origin", referrerPolicy: "no-referrer" });
    } catch {
      return { error: "loadfailed" };
    }
    // The plugin's /image route answers 403 once the token issued with the panel has expired.
    if (response?.status === 403 && src.includes("/image?")) return { error: "expired" };
    if (!response || !response.ok) return { error: "loadfailed" };
    try {
      return { blob: await response.blob() };
    } catch {
      return { error: "loadfailed" };
    }
  };

  /** One fetch and decode per source, shared by every card that shows it. Failures are not kept. */
  const sourceJob = (card, src) => {
    const existing = jobs.get(src);
    if (existing) {
      jobs.delete(src);
      jobs.set(src, existing);
      return existing;
    }
    const job = (async () => {
      const fetched = await fetchInput(src);
      return fetched.error ? fetched : decodeInput(card, fetched.blob);
    })();
    if (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);
    jobs.set(src, job);
    job.then((outcome) => {
      if (outcome.error && jobs.get(src) === job) jobs.delete(src);
    });
    return job;
  };

  const scanSource = async (card, src, carry) => {
    clearResult(card);
    const state = stateOf(card);
    const token = state.token;
    state.running = true;
    setStatus(card, message(card, isDataImage(src) ? "decoding" : "loading"), "");
    present(card, token, await sourceJob(card, src), carry);
  };

  /** Scans text: a web URL (through degoog's image proxy), a data URL, SVG markup or raw base64 image data. */
  const scanText = (card, text) => {
    const value = String(text || "").trim();
    const input = part(card, "url");
    if (!value) return;
    if (isSvgText(value)) {
      if (input) input.value = "";
      void scanBlob(card, new Blob([value], { type: "image/svg+xml" }));
      return;
    }
    const data = isDataImage(value) ? value : base64DataUrl(value);
    if (data) {
      if (input) input.value = "";
      void scanBlob(card, dataUrlBlob(data));
      return;
    }
    if (input && input.value !== value) input.value = value;
    const sign = card.dataset.qrscanSign;
    if (!isWebUrl(value)) {
      clearResult(card);
      setStatus(card, message(card, "badurl"), "error");
      return;
    }
    if (!sign) {
      clearResult(card);
      setStatus(card, message(card, "urlsoff"), "error");
      return;
    }
    const joiner = sign.includes("?") ? "&" : "?";
    void scanSource(card, `${sign}${joiner}url=${encodeURIComponent(value)}`, true);
  };

  // ---- Clipboard and drag and drop ----

  const imageFile = (transfer) => {
    if (!transfer) return null;
    const files = Array.from(transfer.files || []);
    const file = files.find((f) => /^image\//i.test(f.type || "")) || files[0];
    if (file) return file;
    for (const item of Array.from(transfer.items || [])) {
      if (item.kind === "file") {
        const found = item.getAsFile?.();
        if (found) return found;
      }
    }
    return null;
  };

  /** Text from a drop or paste: the first URL of a uri-list, otherwise plain text or SVG markup. */
  const transferText = (transfer) => {
    if (!transfer?.getData) return "";
    const read = (type) => {
      try {
        return String(transfer.getData(type) || "");
      } catch {
        return "";
      }
    };
    const list = read("text/uri-list")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    return (list || read("text/plain") || read("image/svg+xml")).trim();
  };

  const hasPayload = (transfer) => {
    const types = Array.from(transfer?.types || []);
    return ["Files", "text/uri-list", "text/plain", "image/svg+xml"].some((type) => types.includes(type));
  };

  const mountedCard = (node) => {
    const card = node?.closest?.(CARD_SELECTOR);
    return card && card.dataset.qrscanMounted === "1" ? card : null;
  };

  const claim = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
  };

  const setDragOver = (card, on) => {
    const zone = part(card, "drop");
    if (!zone) return;
    if (on) zone.classList.add("qrscan-drop--over");
    else zone.classList.remove("qrscan-drop--over");
  };

  const onDragOver = (event) => {
    const card = mountedCard(event.target);
    if (!card || !hasPayload(event.dataTransfer)) return;
    claim(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragOver(card, true);
  };

  const onDragLeave = (event) => {
    const card = mountedCard(event.target);
    if (!card) return;
    const next = event.relatedTarget;
    if (next && card.contains?.(next)) return;
    setDragOver(card, false);
  };

  const onDrop = (event) => {
    const card = mountedCard(event.target);
    if (!card) return;
    claim(event);
    setDragOver(card, false);
    const file = imageFile(event.dataTransfer);
    if (file) {
      void scanBlob(card, file);
      return;
    }
    const text = transferText(event.dataTransfer);
    if (text) scanText(card, text);
  };

  /** The only scanner on the page, for an image pasted while nothing in particular has focus. */
  const soleCard = () => {
    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR)).filter(
      (card) => card.isConnected && card.dataset.qrscanMounted === "1",
    );
    return cards.length === 1 ? cards[0] : null;
  };

  const onPaste = (event) => {
    const active = document.activeElement;
    const card = mountedCard(active);
    if (!card) {
      // Nothing focused and one scanner on the page: take images and image data, but leave URLs to the page.
      const idle = !active || active === document.body || active === document.documentElement;
      const sole = idle ? soleCard() : null;
      if (!sole) return;
      const file = imageFile(event.clipboardData);
      if (file) {
        claim(event);
        void scanBlob(sole, file);
        return;
      }
      const text = transferText(event.clipboardData);
      if (text && !isWebUrl(text) && isScannableText(text)) {
        claim(event);
        scanText(sole, text);
      }
      return;
    }
    const file = imageFile(event.clipboardData);
    if (file) {
      claim(event);
      void scanBlob(card, file);
      return;
    }
    const text = transferText(event.clipboardData);
    if (isScannableText(text)) {
      claim(event);
      scanText(card, text);
      return;
    }
    // Ordinary text typed into the URL field is left alone. Anywhere else in the panel it can't be scanned.
    if (active === part(card, "url")) return;
    if (text) {
      claim(event);
      clearResult(card);
      setStatus(card, message(card, "badurl"), "error");
    }
  };

  // ---- Mounting ----

  const mount = (card) => {
    if (card.dataset.qrscanMounted === "1") return;
    card.dataset.qrscanMounted = "1";
    const zone = part(card, "drop");
    const file = part(card, "file");
    const input = part(card, "url");
    const scan = part(card, "scan");
    const reset = part(card, "reset");

    const browse = () => file?.click?.();
    zone?.addEventListener("click", (event) => {
      if (event.target === file) return;
      event.preventDefault();
      browse();
    });
    zone?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      browse();
    });
    file?.addEventListener("click", (event) => event.stopPropagation());
    file?.addEventListener("change", () => {
      const chosen = file.files?.[0];
      if (chosen) void scanBlob(card, chosen);
      file.value = "";
    });
    input?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      scanText(card, input.value);
    });
    scan?.addEventListener("click", (event) => {
      event.preventDefault();
      scanText(card, input?.value);
    });
    reset?.addEventListener("click", (event) => {
      event.preventDefault();
      clearResult(card);
      if (input) input.value = "";
      zone?.focus?.();
    });

    const src = card.dataset.qrscanSrc;
    if (src) {
      // Both glance renders carry the same source, so each scans it; sourceJob makes that one fetch and decode.
      void scanSource(card, src, false);
      return;
    }
    const key = card.dataset.qrscanKey || "";
    if (lastScan && key && lastScan.key === key && !lastScan.card.isConnected && Date.now() - lastScan.at < RESTORE_MS) {
      lastScan.card = card;
      showFresh(card, lastScan.blob, lastScan.codes);
    }
  };

  /** Frees the preview of cards that left the page. */
  const release = (root) => {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    const cards = root.matches?.(CARD_SELECTOR) ? [root] : Array.from(root.querySelectorAll?.(CARD_SELECTOR) || []);
    cards.forEach((card) => {
      const state = states.get(card);
      if (!state || card.isConnected || !state.previewUrl) return;
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = "";
    });
  };

  const scanTree = (root) => {
    if (!root || (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE)) return;
    if (root.matches?.(CARD_SELECTOR)) mount(root);
    root.querySelectorAll?.(CARD_SELECTOR).forEach(mount);
  };

  const init = () => {
    scanTree(document);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        (record.removedNodes || []).forEach(release);
        (record.addedNodes || []).forEach(scanTree);
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // Capture on window runs before degoog's own image-search listeners on document.
    window.addEventListener("dragenter", onDragOver, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("paste", onPaste, true);
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) scanTree(document);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
