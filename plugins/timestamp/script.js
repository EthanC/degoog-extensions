(function () {
  "use strict";

  const CARD_SELECTOR = "[data-tstamp-card]";
  const COPY_FEEDBACK_MS = 1200;
  const RELATIVE_UNITS = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.34524],
    ["month", 12],
    ["year", Infinity],
  ];

  const cards = new Set();
  const originalLabels = new WeakMap();
  const resetTimers = new WeakMap();
  let tickerId = 0;

  const translate = (key) => (typeof t === "function" ? t(key) : key);

  const cardMs = (card) => {
    const raw = card.dataset.tstampMs;
    return raw === undefined || raw === "" ? NaN : Number(raw);
  };

  const hourOptions = (mode) => {
    if (mode === "12h") return { hour12: true };
    if (mode === "24h") return { hour12: false };
    return {};
  };

  const formatZone = (date, zone, mode) => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: zone || undefined,
        dateStyle: "full",
        timeStyle: "long",
        ...hourOptions(mode),
      }).format(date);
    } catch {
      return date.toUTCString();
    }
  };

  const localZoneLabel = (date) => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      const offset =
        new Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset" })
          .formatToParts(date)
          .find((part) => part.type === "timeZoneName")?.value || "";
      return [zone.replace(/_/g, " "), offset].filter(Boolean).join(" · ");
    } catch {
      return "";
    }
  };

  const formatRelative = (ms) => {
    let value = (ms - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    for (const [unit, next] of RELATIVE_UNITS) {
      if (Math.abs(value) < next) return rtf.format(Math.round(value), unit);
      value /= next;
    }
    return rtf.format(Math.round(value), "year");
  };

  const isoString = (date) => date.toISOString().replace(/\.000Z$/, "Z");

  const setText = (el, text) => {
    if (el && el.textContent !== text) el.textContent = text;
  };

  const setCopyValue = (el, value) => {
    const button = el?.parentElement?.querySelector("[data-tstamp-copy]");
    if (button) button.dataset.tstampCopy = value;
  };

  const fillLocal = (card, date) => {
    const mode = card.dataset.tstampClock || "auto";
    const local = formatZone(date, "", mode);
    card.querySelectorAll('[data-tstamp-field="local"]').forEach((el) => {
      setText(el, local);
      setCopyValue(el, local);
      const row = el.closest(".tstamp-row");
      if (row && row.hidden) {
        row.hidden = false;
        row.classList.remove("tstamp-row--pending");
        const label = row.querySelector(".tstamp-label");
        const zoneLabel = localZoneLabel(date);
        if (label && zoneLabel) label.title = zoneLabel;
      }
    });
  };

  const fillLive = (card, now) => {
    const date = new Date(now);
    const mode = card.dataset.tstampClock || "auto";
    const seconds = String(Math.floor(now / 1000));
    const millis = String(now);
    const iso = isoString(date);
    card.dataset.tstampMs = millis;
    card.querySelectorAll("[data-tstamp-field]").forEach((el) => {
      const field = el.dataset.tstampField;
      let text = null;
      if (field === "seconds") text = seconds;
      else if (field === "millis") text = millis;
      else if (field === "iso") text = iso;
      else if (field === "zone") text = formatZone(date, el.dataset.tstampZone, mode);
      if (text === null) return;
      setText(el, text);
      setCopyValue(el, text);
    });
    fillLocal(card, date);
  };

  const refreshRelative = (card) => {
    const sub = card.querySelector("[data-tstamp-sub]");
    const ms = cardMs(card);
    if (!sub || !Number.isFinite(ms) || card.dataset.tstampLive === "true") return;
    const parts = sub.textContent.split(" · ");
    if (parts.length < 2) return;
    parts[0] = formatRelative(ms);
    setText(sub, parts.join(" · "));
  };

  const copyText = async (button) => {
    const value = button.dataset.tstampCopy || "";
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
    if (!originalLabels.has(button)) {
      originalLabels.set(button, button.getAttribute("aria-label") || "");
    }
    const original = originalLabels.get(button);
    const copied = translate("timestamp.copied");
    button.classList.add("tstamp-copy--done");
    button.setAttribute("aria-label", copied);
    button.setAttribute("title", copied);
    window.clearTimeout(resetTimers.get(button));
    resetTimers.set(
      button,
      window.setTimeout(() => {
        resetTimers.delete(button);
        button.classList.remove("tstamp-copy--done");
        button.setAttribute("aria-label", original);
        button.setAttribute("title", original);
      }, COPY_FEEDBACK_MS),
    );
  };

  const stopTicker = () => {
    if (!tickerId) return;
    window.clearInterval(tickerId);
    tickerId = 0;
  };

  const startTicker = () => {
    if (!tickerId && cards.size) tickerId = window.setInterval(tick, 1000);
  };

  const tick = () => {
    const now = Date.now();
    cards.forEach((card) => {
      if (!card.isConnected) {
        cards.delete(card);
        return;
      }
      if (card.dataset.tstampLive === "true") fillLive(card, now);
      else refreshRelative(card);
    });
    if (!cards.size) stopTicker();
  };

  const mount = (card) => {
    if (card.dataset.tstampMounted === "1") return;
    card.dataset.tstampMounted = "1";
    const ms = cardMs(card);
    if (card.dataset.tstampLive === "true") {
      fillLive(card, Date.now());
    } else if (Number.isFinite(ms)) {
      fillLocal(card, new Date(ms));
    }
    card.querySelectorAll("[data-tstamp-copy]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyText(button);
      });
    });
    if (!Number.isFinite(ms)) return;
    cards.add(card);
    startTicker();
  };

  const scan = (root) => {
    if (!root || (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE)) return;
    if (root.matches?.(CARD_SELECTOR)) mount(root);
    root.querySelectorAll?.(CARD_SELECTOR).forEach(mount);
  };

  const init = () => {
    scan(document);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach(scan));
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("pagehide", stopTicker);
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      scan(document);
      tick();
      startTicker();
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
