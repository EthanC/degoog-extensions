(function () {
  "use strict";

  // The block between the shared-core markers is a verbatim copy of the one
  // in index.js, so the browser formats exactly like the server.
  // <shared-core>
  const DAY_MS = 86400000;
  const MINUTE_MS = 60000;
  const TRANSITION_STEP_MS = 4 * DAY_MS;
  const FIXED_ZONE_RX = /^([+-])(\d{2}):(\d{2})$/;
  const LETTER_ABBR_RX = /^[A-Z]{2,5}$/;
  const OFFSET_NAME_RX = /^(?:GMT|UTC)(?:[+\-−]|$)/;
  const ABBR_LOCALES = ["en-US", "en-CA", "en-GB", "en-AU", "en-IN", "en-ZA", "en-SG", "ja-JP"];
  const KNOWN_ABBR = {
    "Asia/Seoul": ["KST"],
    "Asia/Shanghai": ["CST"],
    "Asia/Taipei": ["CST"],
    "Asia/Hong_Kong": ["HKT"],
    "Asia/Manila": ["PHT"],
    "Asia/Karachi": ["PKT"],
    "Asia/Bangkok": ["ICT"],
    "Asia/Ho_Chi_Minh": ["ICT"],
    "Asia/Saigon": ["ICT"],
    "Asia/Jakarta": ["WIB"],
    "Asia/Makassar": ["WITA"],
    "Asia/Jayapura": ["WIT"],
    "Asia/Kuala_Lumpur": ["MYT"],
    "Asia/Kathmandu": ["NPT"],
    "Asia/Katmandu": ["NPT"],
    "Asia/Yangon": ["MMT"],
    "Asia/Rangoon": ["MMT"],
    "Asia/Riyadh": ["AST"],
    "Asia/Tehran": ["IRST"],
    "Asia/Jerusalem": ["IST", "IDT"],
    "Europe/Dublin": ["GMT", "IST"],
    "Europe/Moscow": ["MSK"],
    "Europe/Istanbul": ["TRT"],
    "Africa/Cairo": ["EET", "EEST"],
    "Africa/Lagos": ["WAT"],
    "Africa/Nairobi": ["EAT"],
    "Africa/Maputo": ["CAT"],
    "America/Sao_Paulo": ["BRT"],
    "America/Argentina/Buenos_Aires": ["ART"],
    "America/Santiago": ["CLT", "CLST"],
    "America/Bogota": ["COT"],
    "America/Lima": ["PET"],
  };
  const CITY_LABELS = {
    UTC: "UTC",
    "Etc/UTC": "UTC",
    "Asia/Calcutta": "Kolkata",
    "Asia/Saigon": "Ho Chi Minh City",
    "Asia/Ho_Chi_Minh": "Ho Chi Minh City",
    "Asia/Rangoon": "Yangon",
    "Asia/Katmandu": "Kathmandu",
    "Europe/Kiev": "Kyiv",
    "America/Godthab": "Nuuk",
    "Atlantic/Faeroe": "Faroe Islands",
    "Atlantic/Faroe": "Faroe Islands",
    "Pacific/Truk": "Chuuk",
    "Pacific/Ponape": "Pohnpei",
    "Pacific/Enderbury": "Kanton",
    "America/St_Johns": "St. John’s",
    "America/Indiana/Indianapolis": "Indianapolis",
  };
  const DATE_STYLES = {
    full: { weekday: "long", year: "numeric", month: "long", day: "numeric" },
    medium: { weekday: "short", year: "numeric", month: "short", day: "numeric" },
    short: { weekday: "short", month: "short", day: "numeric" },
  };
  const RELATIVE_UNITS = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.34524],
    ["month", 12],
    ["year", Infinity],
  ];
  const OFFSET_PARTS = {
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  };

  const dtfCache = new Map();
  const offsetFormatters = new Map();
  const abbrCache = new Map();
  const canonCache = new Map();
  const transitionCache = new Map();

  const _remember = (cache, key, value, limit) => {
    if (cache.size >= limit) cache.delete(cache.keys().next().value);
    cache.set(key, value);
    return value;
  };

  const _dtf = (locale, options) => {
    const key = `${locale}|${JSON.stringify(options)}`;
    return dtfCache.get(key) || _remember(dtfCache, key, new Intl.DateTimeFormat(locale, options), 400);
  };

  const _utcMs = (year, monthIndex, day, hours = 0, minutes = 0, seconds = 0) => {
    const date = new Date(0);
    date.setUTCFullYear(year, monthIndex, day);
    date.setUTCHours(hours, minutes, seconds, 0);
    return date.getTime();
  };

  const _fixedOffset = (zone) => {
    const match = FIXED_ZONE_RX.exec(String(zone || ""));
    if (!match) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
  };

  const _canon = (zone) => {
    if (!zone || _fixedOffset(zone) !== null) return zone || "";
    if (canonCache.has(zone)) return canonCache.get(zone);
    let id = zone;
    try {
      id = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      id = zone;
    }
    if (id === "Etc/UTC" || id === "Etc/GMT" || id === "GMT") id = "UTC";
    return _remember(canonCache, zone, id, 200);
  };

  const _offsetAt = (zone, ms) => {
    const fixed = _fixedOffset(zone);
    if (fixed !== null) return fixed;
    let formatter = offsetFormatters.get(zone);
    if (!formatter) {
      formatter = _remember(
        offsetFormatters,
        zone,
        new Intl.DateTimeFormat("en-US", { ...OFFSET_PARTS, timeZone: zone }),
        200,
      );
    }
    const parts = formatter.formatToParts(new Date(ms));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const wall = _utcMs(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return Math.round((wall - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
  };

  const _zoneParts = (zone, ms) => {
    const date = new Date(ms + _offsetAt(zone, ms) * MINUTE_MS);
    return {
      y: date.getUTCFullYear(),
      m: date.getUTCMonth() + 1,
      d: date.getUTCDate(),
      h: date.getUTCHours(),
      mi: date.getUTCMinutes(),
      wd: date.getUTCDay(),
    };
  };

  const _hourOptions = (clock) => {
    if (clock === "12h") return { hour12: true };
    if (clock === "24h") return { hourCycle: "h23" };
    return {};
  };

  const _format = (zone, ms, locale, options) => {
    const fixed = _fixedOffset(zone);
    const date = new Date(fixed === null ? ms : ms + fixed * MINUTE_MS);
    return _dtf(locale, { ...options, timeZone: fixed === null ? zone : "UTC" }).format(date);
  };

  const _fmtTime = (zone, ms, locale, clock, seconds) =>
    _format(zone, ms, locale, {
      hour: "numeric",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      ..._hourOptions(clock),
    });

  const _fmtDate = (zone, ms, locale, style) => _format(zone, ms, locale, DATE_STYLES[style] || DATE_STYLES.short);

  const _fmtOffset = (minutes) => {
    const abs = Math.abs(minutes);
    const rest = abs % 60;
    return `UTC${minutes < 0 ? "−" : "+"}${Math.floor(abs / 60)}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
  };

  const _isDst = (zone, ms) => {
    if (_fixedOffset(zone) !== null) return false;
    const year = new Date(ms).getUTCFullYear();
    const january = _offsetAt(zone, _utcMs(year, 0, 1));
    const july = _offsetAt(zone, _utcMs(year, 6, 1));
    if (january === july) return false;
    return _offsetAt(zone, ms) > Math.min(january, july);
  };

  const _zoneName = (zone, ms, locale, style) => {
    try {
      const name = _dtf(locale, { timeZone: zone, timeZoneName: style })
        .formatToParts(new Date(ms))
        .find((part) => part.type === "timeZoneName")?.value;
      return name && !OFFSET_NAME_RX.test(name) ? name : "";
    } catch {
      return "";
    }
  };

  const _abbrFor = (zone, ms, locale) => {
    if (!zone || _fixedOffset(zone) !== null) return "";
    if (_canon(zone) === "UTC") return "UTC";
    const dst = _isDst(zone, ms);
    const key = `${zone}|${dst}|${locale}`;
    if (abbrCache.has(key)) return abbrCache.get(key);
    let found = "";
    for (const candidate of [locale, ...ABBR_LOCALES]) {
      try {
        const name = _dtf(candidate, { timeZone: zone, timeZoneName: "short" })
          .formatToParts(new Date(ms))
          .find((part) => part.type === "timeZoneName")?.value;
        if (name && LETTER_ABBR_RX.test(name)) {
          found = name;
          break;
        }
      } catch {
        // Unknown locale or zone: try the next one.
      }
    }
    if (!found) {
      const known = KNOWN_ABBR[zone] || KNOWN_ABBR[_canon(zone)];
      if (known) found = known[dst ? 1 : 0] || known[0];
    }
    return _remember(abbrCache, key, found, 400);
  };

  const _longName = (zone, ms, locale) => {
    const fixed = _fixedOffset(zone);
    if (fixed !== null) return _fmtOffset(fixed);
    return _zoneName(zone, ms, locale, "long");
  };

  const _cityLabel = (zone) => {
    const fixed = _fixedOffset(zone);
    if (fixed !== null) return _fmtOffset(fixed);
    if (!zone) return "";
    return CITY_LABELS[zone] || zone.split("/").pop().replace(/_/g, " ");
  };

  const _amount = (minutes, locale) => {
    const abs = Math.abs(minutes);
    const unit = abs % 60 === 0 || abs > 60 ? "hour" : "minute";
    const value = unit === "hour" ? abs / 60 : abs;
    try {
      return new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "long",
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      return `${value} ${unit === "hour" ? "h" : "min"}`;
    }
  };

  const _relText = (zone, base, ms, locale, baseLabel, tr) => {
    const delta = _offsetAt(zone, ms) - _offsetAt(base, ms);
    if (!delta) return tr("diff.same", { zone: baseLabel });
    return tr(delta > 0 ? "diff.ahead" : "diff.behind", { amount: _amount(delta, locale), zone: baseLabel });
  };

  const _headRel = (zone, base, ms, locale, label, baseLabel, tr) => {
    const delta = _offsetAt(zone, ms) - _offsetAt(base, ms);
    if (!delta) return tr("diff.headSame", { zone: label, base: baseLabel });
    return tr(delta > 0 ? "diff.headAhead" : "diff.headBehind", {
      zone: label,
      base: baseLabel,
      amount: _amount(delta, locale),
    });
  };

  const _dayShift = (zone, base, ms, locale) => {
    const a = _zoneParts(zone, ms);
    const b = _zoneParts(base, ms);
    const days = Math.round((_utcMs(a.y, a.m - 1, a.d) - _utcMs(b.y, b.m - 1, b.d)) / DAY_MS);
    if (!days) return "";
    let text;
    try {
      text = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "long" }).format(Math.abs(days));
    } catch {
      text = `${Math.abs(days)} d`;
    }
    return `${days > 0 ? "+" : "−"}${text}`;
  };

  const _scanTransitions = (zone, from, to) => {
    if (!zone || _fixedOffset(zone) !== null || _canon(zone) === "UTC") return [];
    const key = `${zone}|${from}|${to}`;
    if (transitionCache.has(key)) return transitionCache.get(key);
    const found = [];
    let t = Math.floor(from / MINUTE_MS) * MINUTE_MS;
    let previous = _offsetAt(zone, t);
    while (t < to) {
      const next = t + TRANSITION_STEP_MS;
      const offset = _offsetAt(zone, next);
      if (offset !== previous) {
        let lo = t;
        let hi = next;
        while (hi - lo > MINUTE_MS) {
          const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
          if (_offsetAt(zone, mid) === previous) lo = mid;
          else hi = mid;
        }
        found.push({ at: hi, from: previous, to: _offsetAt(zone, hi) });
        previous = offset;
      }
      t = next;
    }
    return _remember(transitionCache, key, found, 64);
  };

  const _windowTransitions = (zone, now) => {
    const day = Math.floor(now / DAY_MS) * DAY_MS;
    return _scanTransitions(zone, day - 400 * DAY_MS, day + 560 * DAY_MS);
  };

  const _yearTransitions = (zone, year) =>
    _scanTransitions(zone, _utcMs(year, 0, 1) - 2 * DAY_MS, _utcMs(year + 1, 0, 1) + 2 * DAY_MS).filter(
      (change) => _zoneParts(zone, change.at).y === year,
    );

  const _formatRelative = (ms, now, locale) => {
    let value = (ms - now) / 1000;
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    for (const [unit, next] of RELATIVE_UNITS) {
      if (Math.abs(value) < next) return rtf.format(Math.round(value), unit);
      value /= next;
    }
    return rtf.format(Math.round(value), "year");
  };

  const _dstLine = (zone, ms, locale, tr) => {
    const next = _windowTransitions(zone, ms).find((change) => change.at > ms);
    if (!next) return tr("dst.notObserved");
    const date = _fmtDate(zone, next.at, locale, "medium");
    return tr(next.to < next.from ? "dst.until" : "dst.starts", { date });
  };

  const _changeText = (change, locale, tr) =>
    tr(change.to > change.from ? "dst.forward" : "dst.back", { amount: _amount(change.to - change.from, locale) });

  const _shiftText = (change, locale, clock, tr) =>
    tr("dst.localShift", {
      from: _fmtTime("UTC", change.at + change.from * MINUTE_MS, locale, clock, false),
      to: _fmtTime("UTC", change.at + change.to * MINUTE_MS, locale, clock, false),
    });

  const _zoneSummary = (zone, ms, locale) =>
    [_fmtOffset(_offsetAt(zone, ms)), _abbrFor(zone, ms, locale)].filter(Boolean).join(", ");

  const _dstModel = (zone, label, now, opts, locale, clock, tr) => {
    const summary = _zoneSummary(zone, now, locale);
    const nowRow = {
      label: tr("labels.now"),
      value: `${tr(_isDst(zone, now) ? "dst.inEffect" : "dst.standard")} · ${summary}`,
    };
    const dated = (change) => `${_fmtDate(zone, change.at, locale, "medium")} · ${_changeText(change, locale, tr)}`;

    if (opts.year) {
      const year = String(opts.year);
      const changes = _yearTransitions(zone, opts.year);
      if (!changes.length) {
        return { headline: tr("dst.noneYear", { zone: label, year }), sub: tr("dst.allYear", { offset: summary }), rows: [] };
      }
      return {
        headline: tr("dst.yearTitle", { zone: label, year }),
        sub: "",
        rows: changes.map((change) => ({
          label: _fmtDate(zone, change.at, locale, "medium"),
          value: `${_changeText(change, locale, tr)} · ${_shiftText(change, locale, clock, tr)}`,
        })),
      };
    }

    const changes = _windowTransitions(zone, now);
    const future = changes.filter((change) => change.at > now);
    const past = changes.filter((change) => change.at <= now);
    if (!future.length) {
      return {
        headline: tr(opts.status ? "dst.statusNone" : "dst.none", { zone: label }),
        sub: tr("dst.allYear", { offset: summary }),
        rows: [],
      };
    }

    if (opts.status) {
      const rows = [nowRow];
      if (past.length) rows.push({ label: tr("labels.since"), value: dated(past[past.length - 1]) });
      rows.push({ label: tr("labels.next"), value: dated(future[0]) });
      return {
        headline: tr(_isDst(zone, now) ? "dst.statusYes" : "dst.statusNo", { zone: label }),
        sub: "",
        rows,
      };
    }

    const wanted =
      opts.direction === "forward"
        ? future.find((change) => change.to > change.from)
        : opts.direction === "back"
          ? future.find((change) => change.to < change.from)
          : future[0];
    const pick = wanted || future[0];
    return {
      headline: tr("dst.headline", {
        change: _changeText(pick, locale, tr),
        date: _fmtDate(zone, pick.at, locale, "full"),
      }),
      sub: `${_shiftText(pick, locale, clock, tr)} · ${_formatRelative(pick.at, now, locale)}`,
      rows: [
        ...future.slice(0, 2).map((change, index) => ({
          label: tr(index ? "labels.then" : "labels.next"),
          value: dated(change),
        })),
        nowRow,
      ],
    };
  };

  const _localToInstant = (zone, year, month, day, hour, minute) => {
    const wall = _utcMs(year, month - 1, day, hour, minute);
    const fixed = _fixedOffset(zone);
    if (fixed !== null) return { ms: wall - fixed * MINUTE_MS, kind: "normal" };
    const before = _offsetAt(zone, wall - DAY_MS);
    const after = _offsetAt(zone, wall + DAY_MS);
    const early = wall - before * MINUTE_MS;
    const earlyOk = _offsetAt(zone, early) === before;
    if (before === after) return { ms: early, kind: "normal" };
    const late = wall - after * MINUTE_MS;
    const lateOk = _offsetAt(zone, late) === after;
    if (earlyOk && lateOk && early !== late) {
      return { ms: Math.min(early, late), kind: "ambiguous", gap: Math.abs(before - after) };
    }
    if (earlyOk) return { ms: early, kind: "normal" };
    if (lateOk) return { ms: late, kind: "normal" };
    return { ms: early, kind: "gap", gap: Math.abs(before - after) };
  };

  const _resolveDate = (spec, zone, now, hour, minute) => {
    const today = _zoneParts(zone, now);
    const base = _utcMs(today.y, today.m - 1, today.d);
    const read = (ms) => {
      const date = new Date(ms);
      return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
    };
    const [kind, a = "", b = "", c = ""] = String(spec || "rel:0").split(":");
    if (kind === "rel") return read(base + Number(a) * DAY_MS);
    if (kind === "wd") {
      let delta = (Number(a) - today.wd + 7) % 7;
      if (delta === 0 && (b === "1" || hour * 60 + minute <= today.h * 60 + today.mi)) delta = 7;
      return read(base + delta * DAY_MS);
    }
    if (kind === "abs") {
      const month = Number(b);
      const day = Number(c);
      let year = a ? Number(a) : today.y;
      if (!a && (month < today.m || (month === today.m && day < today.d))) year += 1;
      const check = read(_utcMs(year, month - 1, day));
      return check.y === year && check.m === month && check.d === day ? check : null;
    }
    return null;
  };

  const TRANSLATED_FORMATS = new Set(["rel", "headrel", "dst"]);

  const _fmtValue = (kind, c, tr) => {
    switch (kind) {
      case "time":
        return _fmtTime(c.zone, c.at, c.locale, c.clock, c.sec);
      case "date":
        return _fmtDate(c.zone, c.at, c.locale, c.style);
      case "abbr":
        return _abbrFor(c.zone, c.at, c.locale);
      case "offset":
        return _fmtOffset(_offsetAt(c.zone, c.at));
      case "long":
        return _longName(c.zone, c.at, c.locale);
      case "label":
        return c.label || _cityLabel(c.zone);
      case "rel":
        return _relText(c.zone, c.base, c.at, c.locale, c.baseLabel || _cityLabel(c.base), tr);
      case "headrel":
        return _headRel(c.zone, c.base, c.at, c.locale, c.label || _cityLabel(c.zone), c.baseLabel || _cityLabel(c.base), tr);
      case "day":
        return _dayShift(c.zone, c.base, c.at, c.locale);
      case "dst":
        return _dstLine(c.zone, c.at, c.locale, tr);
      default:
        return null;
    }
  };

  const _copyValue = (time, abbr, date) => `${[time, abbr].filter(Boolean).join(" ")}${date ? `, ${date}` : ""}`;
  // </shared-core>

  const CARD_SELECTOR = "[data-tz-card]";
  const COPY_FEEDBACK_MS = 1200;

  const cards = new Set();
  const originalLabels = new WeakMap();
  const resetTimers = new WeakMap();
  let tickerId = 0;

  const tr = (key, vars) => (typeof t === "function" ? String(t(`timezone.${key}`, vars)) : `timezone.${key}`);
  const translated = () => tr("copy") !== "timezone.copy";

  const browserZone = () => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      return zone ? _canon(zone) : "";
    } catch {
      return "";
    }
  };

  const setText = (el, text) => {
    if (el && el.textContent !== text) el.textContent = text;
  };

  const readAt = (el) => {
    const raw = el.closest("[data-tz-at]")?.dataset.tzAt;
    return !raw || raw === "now" ? Date.now() : Number(raw);
  };

  const contextFor = (el, card) => {
    const holder = el.closest("[data-tz-zone]");
    return {
      zone: holder?.dataset.tzZone || "",
      label: holder?.dataset.tzLabel || "",
      at: readAt(el),
      locale: card.dataset.tzLocale || undefined,
      clock: card.dataset.tzClock || "auto",
      sec: el.dataset.tzSec === "1",
      style: el.dataset.tzStyle || "short",
      base: el.dataset.tzBase || "",
      baseLabel: el.dataset.tzBaseLabel || "",
    };
  };

  const NEEDS_BASE = new Set(["rel", "headrel", "day"]);

  const refresh = (card) => {
    const hasT = translated();
    card.querySelectorAll("[data-tz-fmt]").forEach((el) => {
      const kind = el.dataset.tzFmt;
      if (!hasT && TRANSLATED_FORMATS.has(kind)) return;
      const c = contextFor(el, card);
      if (!c.zone || (NEEDS_BASE.has(kind) && !c.base)) return;
      try {
        const text = _fmtValue(kind, c, tr);
        if (text !== null) setText(el, text);
      } catch {
        // Keep the server's text for this element.
      }
    });
    card.querySelectorAll("[data-tz-copy-scope]").forEach((scope) => {
      const button = scope.querySelector("[data-tz-copy]");
      if (!button) return;
      const pick = (kind) => scope.querySelector(`[data-tz-fmt="${kind}"]`)?.textContent || "";
      button.dataset.tzCopy = _copyValue(pick("time"), pick("abbr"), pick("date"));
    });
  };

  const homeBound = (card) =>
    [card, ...card.querySelectorAll('[data-tz-home="1"]')].filter((el) => el.dataset.tzHome === "1");

  const retarget = (card, browser) => {
    let moved = false;
    homeBound(card).forEach((el) => {
      if (_canon(el.dataset.tzZone) === browser) return;
      el.dataset.tzZone = browser;
      el.dataset.tzLabel = _cityLabel(browser);
      moved = true;
    });
    card.querySelectorAll('[data-tz-base-home="1"]').forEach((el) => {
      if (_canon(el.dataset.tzBase) === browser) return;
      el.dataset.tzBase = browser;
      el.dataset.tzBaseLabel = _cityLabel(browser);
    });
    return moved;
  };

  const recomputeInstant = (card, zone) => {
    const [hour, minute] = String(card.dataset.tzWall || "").split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
    const date = _resolveDate(card.dataset.tzDate, zone, Date.now(), hour, minute);
    if (!date) return;
    card.dataset.tzAt = String(_localToInstant(zone, date.y, date.m, date.d, hour, minute).ms);
  };

  const buildDstRow = ({ label, value }) => {
    const row = document.createElement("div");
    row.className = "tz-row";
    row.setAttribute("data-tz-row", "dst");
    const term = document.createElement("dt");
    term.className = "tz-label";
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.className = "tz-value";
    const text = document.createElement("span");
    text.className = "tz-text";
    text.textContent = value;
    detail.appendChild(text);
    row.appendChild(term);
    row.appendChild(detail);
    return row;
  };

  const rebuildDst = (card) => {
    const model = _dstModel(
      card.dataset.tzZone,
      card.dataset.tzLabel,
      Date.now(),
      {
        year: Number(card.dataset.tzYear) || 0,
        direction: card.dataset.tzDir || "any",
        status: card.dataset.tzStatus === "1",
      },
      card.dataset.tzLocale || undefined,
      card.dataset.tzClock || "auto",
      tr,
    );
    setText(card.querySelector("[data-tz-dst-headline]"), model.headline);
    setText(card.querySelector("[data-tz-dst-sub]"), model.sub);
    const list = card.querySelector(".tz-rows");
    if (!list) return;
    list.textContent = "";
    model.rows.forEach((row) => list.appendChild(buildDstRow(row)));
  };

  const showTag = (row, text) => {
    const tag = row.querySelector("[data-tz-tag]");
    if (!tag) return;
    if (text) setText(tag, text);
    tag.hidden = !text;
  };

  const syncRows = (card, browser) => {
    const hasT = translated();
    const rows = [...card.querySelectorAll("[data-tz-row]")];
    const zoneRows = rows.filter((row) => row.dataset.tzRow === "zone");
    const rootZone = _canon(card.dataset.tzZone);

    zoneRows.forEach((row) => {
      if (!hasT) return;
      if (browser && _canon(row.dataset.tzZone) === browser) showTag(row, tr("labels.you"));
      else if (row.dataset.tzHome === "1") showTag(row, tr("labels.home"));
      else showTag(row, "");
    });

    if (card.dataset.tzMode === "now") {
      const explicit = new Set(
        zoneRows.filter((row) => row.dataset.tzHome !== "1").map((row) => _canon(row.dataset.tzZone)),
      );
      if (card.dataset.tzHome !== "1") explicit.add(rootZone);
      zoneRows
        .filter((row) => row.dataset.tzRole === "home")
        .forEach((row) => {
          row.hidden = explicit.has(_canon(row.dataset.tzZone));
        });
    }
    rows
      .filter((row) => row.dataset.tzRow === "diff")
      .forEach((row) => {
        const rel = row.querySelector('[data-tz-fmt="rel"]');
        row.hidden = !rel || _canon(rel.dataset.tzBase) === rootZone;
      });

    const local = card.querySelector('[data-tz-row="local"]');
    if (!local) return;
    const shown = new Set(zoneRows.filter((row) => !row.hidden).map((row) => _canon(row.dataset.tzZone)));
    shown.add(rootZone);
    if (browser && !shown.has(browser)) {
      local.dataset.tzZone = browser;
      local.dataset.tzLabel = _cityLabel(browser);
      local.hidden = false;
      local.classList.remove("tz-row--pending");
      if (hasT) showTag(local, tr("labels.you"));
    } else {
      local.hidden = true;
    }
  };

  const copyText = async (button) => {
    const value = button.dataset.tzCopy || "";
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
    const copied = tr("copied");
    button.classList.add("tz-copy--done");
    button.setAttribute("aria-label", copied);
    button.setAttribute("title", copied);
    window.clearTimeout(resetTimers.get(button));
    resetTimers.set(
      button,
      window.setTimeout(() => {
        resetTimers.delete(button);
        button.classList.remove("tz-copy--done");
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

  const tick = () => {
    cards.forEach((card) => {
      if (!card.isConnected) {
        cards.delete(card);
        return;
      }
      refresh(card);
    });
    if (!cards.size) stopTicker();
  };

  const startTicker = () => {
    if (!tickerId && cards.size) tickerId = window.setInterval(tick, 1000);
  };

  const mount = (card) => {
    if (card.dataset.tzMounted === "1") return;
    card.dataset.tzMounted = "1";
    const browser = card.dataset.tzBrowser === "1" ? browserZone() : "";
    try {
      if (browser && translated() && retarget(card, browser)) {
        if (card.dataset.tzMode === "convert" && card.dataset.tzHome === "1") recomputeInstant(card, browser);
        if (card.dataset.tzMode === "dst" && card.dataset.tzHome === "1") rebuildDst(card);
        card.querySelectorAll("[data-tz-home-note]").forEach((note) => {
          note.hidden = true;
        });
      }
      syncRows(card, browser);
      refresh(card);
    } catch {
      // Leave the server-rendered panel as it is.
    }
    card.querySelectorAll("[data-tz-copy]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyText(button);
      });
    });
    if (card.dataset.tzAt !== "now") return;
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
