# AGENTS.md

Guide for agents working in this repository. It holds extensions for [degoog](https://github.com/degoog-org/degoog), a self-hosted search aggregator, and is published as a degoog Store repository.

Read this before writing or changing an extension. The degoog developer docs at https://degoog-org.github.io/docs/developer.html cover the basics but skip much of what is below, which was learned by reading degoog core (v1.1.1) and testing against a live instance.

## Ground rules

- **Work on the checked-out branch.** Commit to whatever branch is checked out, usually `main`. Never create a branch unless the user explicitly asks for one.
- **Commit only when asked, push only when asked.** Use [Conventional Commits](https://www.conventionalcommits.org/) with the extension folder as scope, for example `feat(timestamp): ...` or `fix(timestamp): ...`. Do not add attribution trailers.
- **Never commit instance details.** This repository is meant to be public. Keep LAN addresses, hostnames, passwords, settings tokens and API keys out of every file, including tests, screenshots and this one.
- **Run `npm test` before every commit.** All tests must pass.

## Repository layout

```
package.json            Store manifest (read by degoog) + npm test script
README.md               Human-facing list of extensions
plugins/<name>/         One folder per plugin (see "Plugin anatomy")
tests/<name>*.test.mjs  node:test suites, one or more per extension
```

Other Store types live in sibling top-level folders with the same layout as degoog-org/official-extensions: `engines/`, `themes/`, `transports/`, `autocomplete/`, `shortcuts/` and `favicon/`. Add the matching array to `package.json` when the first one appears.

### Store manifest (`package.json`)

Every extension needs an entry, otherwise the Store never shows it:

```json
{
  "path": "plugins/timestamp",
  "name": "Timestamp",
  "description": "One or two sentences shown on the Store card.",
  "version": "1.0.0",
  "type": "slot",
  "minDegoogVersion": "1.1.0"
}
```

- **`type`** is `slot`, `command` or `interceptor` for plugins. It only labels the Store card. What the module exports decides how it loads.
- **`version`** must be bumped for every change that installs should pick up. The Store shows "update available" whenever the installed version string differs from the repository's.
- **`minDegoogVersion`** only shows a warning on the Store card. It does not block installation.
- **The installed folder** is named `<github-user>-<repo>-<folder>`, lowercased. For the Timestamp plugin that is `<github-user>-degoog-extensions-timestamp`. Renaming an extension's folder therefore orphans every user's settings for it.
- **`repo-image`** (top level, next to `author`) is the repository avatar on the degoog-org/community-extensions showcase (`scripts/indexer/repo.js`). A relative path resolves to the raw file in this repository; absolute `http(s)` and `data:` URLs pass through. This repository uses `repo_image.png` at the root.

## Plugin anatomy

```
plugins/<name>/
  index.js        Entry module. Must be index.js/.ts/.mjs/.cjs, nothing else
  template.html   Optional HTML fragment, available as ctx.template in init()
  style.css       Optional, loaded on every page while the plugin is enabled
  script.js       Optional client script, loaded on every page while enabled
  locales/*.json  Optional translations (en.json at minimum if any)
  author.json     {"name": "<author>", "url": "<author profile URL>"}, same as the other extensions here
  README.md       Shown as in-app documentation and on GitHub
  screenshots/    1.webp, 2.webp, 3.webp shown on the Store card (see "Visual checks")
```

### Choosing the extension type

- **Slot** (`export const slot = {...}`). A panel the user did not explicitly ask for, chosen by `trigger(query)`. Use this for anything "triggered by keywords, not a command". Positions: `at-a-glance`, `above-results`, `below-results`, `full-width-above-results`, `above-sidebar`, `below-sidebar`, `knowledge-panel`. List the allowed ones in `slotPositions` to give users a Position setting.
- **Command** (`export default { name, trigger: "name", execute(args) }`). A `!bang` the user types on purpose. `naturalLanguagePhrases` are off until the user enables them per command, and they route on the query's first word, so for keyword triggers use a slot and keep the command for the bang. One `index.js` can export both (see "Command contract details").
- **Interceptor, search tab, middleware, routes.** See degoog's `src/server/types/extension.ts` for the shapes.

### Slot contract details that are not in the docs

- **Module shape.** The registry accepts `slot`, `slotPlugin` or `default.slot` exports. Validation needs `name`, a valid `position`, and `trigger` and `execute` functions. Export `default { slot }` as well, like the official plugins do, unless the module also has a command: then `default` must be the command.
- **Ids are overwritten.** After loading, degoog sets `slot.id` to the canonical id `<installed-folder>-slot`, for example `<github-user>-degoog-extensions-timestamp-slot`. Settings are stored under that id.
- **Locale lookups for name and settings mostly miss.** degoog looks up `<canonical-id>.name`, `<canonical-id>.description` and `<canonical-id>.settings.<key>.label`. A locale file keyed by a short name like `timestamp` never matches those for Store installs. The English `name`, `description` and `settingsSchema` labels in `index.js` are therefore what users see, so write them properly. Keep the locale `settings` blocks anyway, for parity with the official extensions.
- **Your own strings do translate.** Call `slot.t(key, vars, locale)` (degoog sets `slot.t` from your `locales/`), or put `{{ t:ns.key }}` in returned HTML. Use `context.locale`, which is the first entry of the request's `Accept-Language`. Pick a top-level namespace in your locale files (for example `"timestamp": {...}`) and prefix every key with it.
- **When code runs.** `trigger` runs on every search, so keep it fast and free of network calls. `execute` has a 10-second timeout (`DEGOOG_SLOT_TIMEOUT_MS`). A throw or timeout silently drops the panel. Return `{ title, html }`, and return an empty `html` for no panel.
- **Knowledge panel.** `knowledge-panel` slots are prepended to the sidebar as accordions headed by the panel `title` (`render-sidebar.tsx`), so return a plain-text title. The accordion body (`.degoog-accordion-body`) has no padding, so pad the card yourself there. On phones, sidebar accordions move above the results and start collapsed. degoog's built-in Wikipedia panel uses the same slot.
- **`waitForResults: true`** delays the slot until results exist and passes them in `context.results`. Leave it off for slots that don't need results, so the panel appears immediately.
- **The at-a-glance slot is requested twice.** The client calls `POST /api/slots/glance` before results arrive and again after, so the panel can re-render. Client code must cope with re-mounts.
- **No-JS page.** The `/nojs` page only runs slots with `supportsNojs: true`, and passes `context.nojs`. Leave out JS-only controls in that mode.
- **`isClientExposed`** must be a boolean. Use `false` when all traffic goes through the server. It drives a privacy indicator in settings.
- **Settings.** `settingsSchema` field values arrive in `configure(settings)` as **strings**, toggles included (`"true"`/`"false"`). Parse defensively and clamp. A `type: "list"` field with an `itemSchema` arrives as a JSON string of row objects (`'[{"url":"…","keywords":"…"}]'`, see `list-field-data.ts`), and the same string is what `POST /api/extensions/<id>/settings` takes. Reserved keys: `disabled`, `slotPosition`, `slotSearchTypes`, `priority`, `score`, `outgoingTransport`, `searchTypeOverride`, `theme`, `shortcuts`.
- **`init(ctx)`.** It runs once per loaded module, with `ctx.template`, `ctx.fetch` (proxy-aware), `ctx.useCache(ns, ttlMs)`, `ctx.readFile(name)` (reads a UTF-8 file from the plugin folder, subfolders included), `ctx.signProxyUrl` and `ctx.apiBase`.
- **Keep `index.js` a single file.** degoog imports the entry by `file://` URL (`src/server/extensions/registry-factory.ts`), so `import "./x.js"` resolves. A reload re-imports only the entry, with `?r=<n>` appended, so sibling modules stay cached and go stale.
- **Plugin routes next to a slot.** `export const routes = [{ method, path, handler(request), rateLimit }]` in the same `index.js` (and in `default`). The route loader imports the same URL as the slot registry, so handlers share module state with the slot, including the `ctx.fetch` saved in `init`. Paths match exactly (`src/server/extensions/plugin-routes/registry.ts`), so pass parameters in the query string. Routes answer 403 while the plugin is disabled. `plugins/orbis-patches` serves art this way.
- **`ctx.apiBase` has no base path.** It is `/api/plugin/<installed-folder>` even when `DEGOOG_BASE_URL` has a path (v1.1.1, `plugin-assets.ts`), unlike `signProxyUrl` URLs. Add the path yourself when putting route URLs into HTML.
- **Accept a test clock.** Anything time-dependent should read `context.now` when it is a finite number and `Date.now()` otherwise. degoog never sets it, and tests get deterministic output.

### Command contract details that are not in the docs

Verified against degoog 1.1.1 (`src/server/extensions/commands/registry.ts`, `src/server/routes/extensions/commands.ts`, `src/client/utils/search/actions/search-actions-perform.tsx`).

- **Module shape.** The registry takes `mod.default ?? mod.command ?? mod.Command` and needs `name`, `trigger` and `execute`. A default export that is not a command (such as `{ slot }`) fails validation and the command silently doesn't load.
- **Rendering.** For a bang, `html` replaces the results list, the at-a-glance box, sidebar and slot panels are cleared, and `title` goes above it. With natural language the HTML goes into at-a-glance instead. Wrap it in `<div class="command-result">` like the official commands.
- **Translations.** degoog fills `{{ t:ns.key }}` in `html` but **not** in `title`, and commands get no `context.locale`. Use a plain-text title. Placeholders are inserted unescaped, so keep locale strings free of `<`, `>`, `"` and `&`, and test that.
- **Trigger clashes.** Built-ins load first, then plugin folders in name order, and the first owner of a trigger wins. A later duplicate is dropped with only a debug log. Aliases are **not** de-duplicated, so a later alias silently takes over another plugin's trigger. Check degoog-org/official-extensions before choosing one (its QR generator owns `!qr` and `!qrcode`).
- **Context.** `init(ctx)` gets the same `PluginContext` as slots. `execute(args, context)` gets `signProxyUrl`, `clientIp`, `page`, `searchType` and `nojs`.
- **Slot and command in one module.** The slot, command and route registries each read their own export from the same module, so they share module state. They get separate settings entries (`<folder>-slot`, `<folder>-command`) and `init` runs once per object. `style.css` is registered for both. `script.js` is injected once, with the command's `t` namespace. `plugins/qr-scanner` does this.
- **Testing.** `POST /api/command {"query": "!name args", "type": "web"}` runs a bang and is public.

### Client scripts (`script.js`)

- **Wrapper.** degoog serves the file wrapped as `(function(t){const __PLUGIN_ID__="<installed-folder>";…})(window.scopedT("slots/<id>"))`. So `t("ns.key")` translates with your own locale files, and `__PLUGIN_ID__` builds `/api/plugin/${__PLUGIN_ID__}/...` route URLs. Literal `/plugins/<x>/` and `/api/plugin/<x>/` paths are rewritten to the installed folder.
- **Pages.** It loads on every page, not just when your panel shows. Find panels with a `MutationObserver` and mark them as mounted with a data attribute, so the second glance render is handled correctly.
- **Back-forward cache.** Survive it: pause timers on `pagehide` and resume on `pageshow` when `event.persisted` is true. Never disconnect your observer for good on `pagehide`.
- **Plain-HTTP instances.** On plain-HTTP origins, typical for LAN instances, `navigator.clipboard` is `undefined`. Always keep a fallback that copies through a hidden textarea and `execCommand("copy")`.
- **Labels.** Remember an element's original label before changing it (for example "Copy" to "Copied"). Clear pending reset timers on repeat clicks, or the label sticks.
- **`t(key, vars)`** interpolates `{name}` placeholders from an object and returns the key itself when it is missing (degoog `src/public/t.js`). Treat `t(key) === key` as "no translations" and keep the server's text.
- **Your own paste and drop handling.** degoog's image-search bar listens for `paste`, `drop` and `dragover` on `document` in the capture phase. Listen on `window` in the capture phase instead, act only on events aimed at your panel, and call `preventDefault()` plus `stopImmediatePropagation()` on those.
- **Content Security Policy.** When an admin turns on `blockClientLeaks`, degoog enforces `connect-src 'self'`, so browser `fetch()` to other hosts fails, and so can `fetch("data:…")`. `img-src` and `worker-src` allow `blob:` and `data:`. Decode data URLs yourself with `atob` and route remote images through the server (`src/server/utils/security/content-policy.ts`).
- **Big libraries.** `script.js` is injected as a module on every page, so keep it small. Serve a vendored library from a plugin route via `ctx.readFile`, and load it with a `<script>` tag the first time it is needed. Vendor it unmodified, with its licence, and pin its SHA-256 in a test. `plugins/qr-scanner` serves jsQR this way.
- **Sharing code with `index.js`.** `script.js` cannot import anything. When the browser needs the server's logic, mark the block in both files and add a test that the two copies match. `plugins/timezone` does this with `// <shared-core>` markers.

### Styling

- **Prefix every class** with a short plugin prefix (`tstamp-…`), because `style.css` is global.
- **Use degoog's variables and classes** so themes and light mode keep working: `var(--text-primary)`, `var(--text-secondary)`, `var(--bg-light)`, `var(--bg-hover)`, `var(--border-light)`, `var(--success)`, `var(--text-link)` (result-title blue; `--link-color` is not defined in v1.1.1), `.degoog-badge`, `.degoog-icon-btn`. Font Awesome is available (`fa-regular fa-copy`).
- **Match the surrounding design.** No new borders, blur or transparency unless degoog already uses them nearby. At-a-glance panels already sit inside a padded `degoog-panel`.
- **Check both themes and a 390px width.** Stack label/value grids below roughly 480px.

## Writing triggers

A slot that fires on the wrong query hijacks someone's search, so treat false positives as bugs.

- **Normalise first.** Trim, lowercase, collapse whitespace, strip trailing punctuation, and remove apostrophes (`'‘’`) so `what's` becomes `whats` before tokenising.
- **Split keywords into strong and weak.** Strong keywords (`epoch`, `timestamp`, `unix time`) mean intent on their own. Weak ones (`unix`, `to date`, `human readable`) also need strong evidence in the rest of the query, such as a timestamp-sized number or an explicit unit.
- **Don't let unit words become keywords.** If `epoch ms` is matched as a keyword phrase, the `ms` is lost. Parse units as tokens, including attached forms such as `1700000000ms`.
- **Watch non-ASCII in regex.** `\b` never matches next to `µ`, `μ`, `’` or `→`, because they are not word characters in non-unicode JS regex. Use token or `Map` lookups, or explicit `(?:^|\s)`/`(?=\s|$)` boundaries.
- **Respect bare-input toggles.** Give users a toggle for "bare" triggers, such as a lone number or a lone date, but don't let it disable explicit forms like a keyword or a unit.
- **Check `Date.UTC` years.** It maps years 0 to 99 to 1900 to 1999. Build dates with `new Date(0)` plus `setUTCFullYear(y, m, d)` plus `setUTCHours`, and validate by reading the fields back.
- **Return null when unsure.** It's better to show no panel than a wrong one.
- **Keep `trigger` linear and cheap.** Anyone can send a multi-megabyte query to the public slot endpoints, and `trigger` runs synchronously on every search. An unanchored regex such as `<svg[\s>][\s\S]*<\/svg>` took 0.5 s on 80 KB, and the time grew quadratically. Find markup with `indexOf`/`lastIndexOf`, bound any backward scans, and leave expensive work such as encoding to `execute`. Add a timing test that grows the input 8x.
- **A link is not automatically the thing to act on.** `qr code https://example.com` asks for a code for that site. Treat a URL as an image only when its path has an image extension or the query says scan or read.
- **Consume every token.** For natural-language triggers, classify each token (zone, time, connector, filler and so on) and return null on any unknown word. That rejects `time in a bottle` or `paris time lapse` without a blacklist.
- **Gate short ambiguous words on context.** Two-letter abbreviations such as `et` or `pt` should only count next to a time, a connector or another zone, otherwise `ct scan` and `pt cruiser` trigger. Test that no single-word lookup key equals a grammar word.

## Dates and time zones

Verified on Node 26 and Bun 1.4.4.

- **The server never knows the visitor's zone.** Render with a configurable home zone, which no-JS pages keep, and let `script.js` switch to `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- **Never pass user text as `timeZone`.** In Node `EST` resolves to `America/Panama` and `CET` to `Europe/Brussels`. In Bun they stay fixed legacy zones with no daylight saving time. Map abbreviations through your own table.
- **Node and Bun disagree on zone ids.** Node's `Intl.supportedValuesOf("timeZone")` and `resolvedOptions().timeZone` use old ids such as `Asia/Calcutta` and `Europe/Kiev` and leave out `UTC`. Bun uses `Asia/Kolkata` and `Europe/Kyiv` and includes `UTC`. Both accept either spelling as input, so map old ids to new ones yourself and canonicalise both sides before comparing zones.
- **City names from zone ids include English words**, such as `Easter`, `Wake`, `Christmas` and `Jersey`. Exclude them before matching queries against them.
- **Offset ids** such as `+05:30` are valid `timeZone` values.
- **Abbreviations depend on the locale.** `en-US` gives `EST` but `GMT+1` for Berlin, `en-GB` gives `CET` and `BST`, and only `ja-JP` gives `JST`. Try several locales, then a small fallback table.
- **Find daylight saving changes** by stepping a few days at a time and bisecting to the minute from a minute-aligned start. Some zones move by 30 minutes (`Australia/Lord_Howe`).
- **Plural units** come from `Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "long" })`, which gives `5.5 hours` and `5,5 Stunden` without plural locale keys.

## Security and privacy

degoog runs extensions in-process with no sandbox, and some instances are public. Treat every extension like core code.

- **Escape everything you interpolate into HTML**, attributes included. Escape `&`, `<`, `>` and `"`. Also escape `{{` to `&#123;&#123;`, otherwise degoog's `{{ t:… }}` pass can expand user text.
- **Never put user input into `<script>`** or inline event handlers. Use `data-*` attributes plus `script.js`.
- **Make outgoing requests through `ctx.fetch` or `context.fetch`**, never global `fetch`. Proxy and transport settings then still apply, and the visitor's IP never reaches third parties. Prefer extensions that make no network calls at all.
- **Proxy third-party images.** Slot HTML on the normal page is not rewritten, so a raw `<img src="https://…">` sends the visitor's IP to that host (only `/nojs` runs `proxyHtmlImages`). Use `context.signProxyUrl(url)`, which goes through `/api/proxy/image`. That proxy refuses responses without an image `Content-Type` (`src/server/routes/proxy.ts`), so for hosts that omit it, serve the image from a plugin route that sniffs the magic bytes and only fetches URLs on the expected host.
- **`ctx.fetch` has no private-address guard.** It only applies `DEGOOG_OUTGOING_ALLOWED_HOSTS`, so never fetch a URL the visitor supplied with it. Pass it through `signProxyUrl` instead. degoog's image proxy resolves DNS and refuses private, loopback and link-local addresses on every redirect, caps at 25 MB and only passes images (`src/server/utils/security/ssrf.ts`). The result is same-origin, so a canvas that draws it stays readable. Some hosts refuse the proxy: Wikimedia's upload servers answer it with a 502.
- **When a lookup must go online**, send only the fragment it needs, such as a place name, never the whole query. Do it from `execute`, never from `trigger`. Gate it behind a setting, cache the answers, and say in the README exactly what is sent and where. `plugins/timezone` does this for places that are not built in.
- **Don't log, store or send queries anywhere.** degoog's privacy model allows exactly two places that keep queries: the search cache and the opt-in indexer.
- **Mark secret settings** with `type: "password"` and `secret: true`, so they are never sent to the browser.
- **Plugin routes** (`export const routes`) are public unless you check auth. Never use GET for anything that mutates state.
- **Never offer `signProxyUrl` as a service.** A route that signs any URL it is given turns degoog's image proxy into an open proxy. If a panel must sign URLs the visitor enters, issue a short-lived HMAC token with the panel (`node:crypto` works in Node and Bun), require it in the route, and give admins a setting to turn link fetching off. A bang that signs its argument is public too, so document that. `plugins/qr-scanner` does this.

## Testing

### Unit tests (required)

- **Tooling.** Tests use `node:test` and `node:assert/strict`, with no dependencies. Run them with `npm test` (`node --test tests/`) on Node 20 or newer.
- **Load the plugin like degoog does.** Import `index.js`, set `slot.t` to a small translator over the real `locales/*.json`, and call `slot.init({ template })` with the real `template.html`. Then call `slot.configure()` with the `settingsSchema` defaults as strings.
- **Cover triggers.** Keep a positive list and a negative list. Every bug found in review gets a regression case.
- **Cover rendering.** Assert on `data-*` attributes and field text in the returned HTML, not on exact markup. Check that no `{{` or untranslated `ns.key` strings leak through.
- **Cover locales.** Assert that every locale has the same key set as `en.json`.
- **Test client scripts.** Use `node:vm` with a minimal fake DOM and fake timers. `tests/timestamp-client.test.mjs` is a working example covering mount, copy and back-forward cache behaviour.
- **Check Bun parity.** degoog runs on Bun (`engines.bun` in its package.json). For anything engine-sensitive, such as regex, Intl or BigInt, run `npm install --no-save bun` in a scratch folder and then `<scratch>/node_modules/.bin/bun test tests/<name>.test.mjs`. Bun runs the `node:test` suites unchanged.
- **Test client scripts against real markup.** Render the panel with `execute()` and parse it into the fake DOM, then stub `Date` and the default zone of `Intl.DateTimeFormat` in the `vm` context. `tests/timezone-client.test.mjs` has a small parser for this.

### Testing against a live instance

Read the instance URL and admin password from the git-ignored `.env` at the repository root (`DEGOOG_URL`, which may lack a scheme, and `DEGOOG_PASSWORD`), for example with `node --env-file=.env`. Never print them. If `.env` is missing, ask the user. Never write them into a tracked file.

- **Slots are public endpoints.** Exercise them with `POST /api/slots/glance` for at-a-glance slots, or `POST /api/slots` for other positions. Send the body `{"query": "...", "type": "web"}` and an `Accept-Language` header. `/api/search` and search-only integrations built on it never return slot panels.
- **Send non-ASCII test queries from Node `fetch`**, not Git Bash `curl`. Git Bash re-encodes arguments for native Windows programs, which turns `µ` and `’` into U+FFFD and looks exactly like a server bug.
- **Don't curl `/search?q=` pages.** degoog's CSS bot trap can strike or ban clients that fetch result pages without loading the page CSS. Use the APIs, or a real browser.
- **Admin routes.** Store install and uninstall need a settings token. Get one from `POST /api/settings/auth {"password": "..."}`, send it as the `x-settings-token` header, keep it in a scratch file, never print it, and delete it when done. The Bearer "API key" only covers search endpoints, not admin.

### Sideloading an uncommitted build

The Store installs only from git URLs that support shallow clones (`git clone --depth 1`). A plain static file server (`python -m http.server`) fails with "dumb http transport does not support shallow capabilities".

1. Copy the repository files into a scratch folder, `git init`, commit, then `git clone --bare` into `<root>/<github-user>/<repo>-dev.git`.
2. Serve that bare repository read-only over git's smart HTTP protocol. A small Node server that pipes requests to `git http-backend` (CGI) works: set `GIT_PROJECT_ROOT` and `GIT_HTTP_EXPORT_ALL`, pass the `HTTP_*` headers through, and refuse `git-receive-pack`. Agent sandboxes usually forbid starting LAN-facing servers, so either give the user the command to run, or, with shell access to the host, copy the bare repository into the degoog container and serve it on `127.0.0.1` there (the Store accepts that URL). The official image's git has no `http-backend`, so answer `GET info/refs?service=git-upload-pack` with a `# service=git-upload-pack` pkt-line, a flush and `git upload-pack --stateless-rpc --advertise-refs`, and pipe `POST git-upload-pack` (gunzip it if `Content-Encoding: gzip`) through `git upload-pack --stateless-rpc`. Pass `Git-Protocol` on as `GIT_PROTOCOL`, and skip the service line for protocol v2. Don't stop it with `pkill -f <script>` inside `sh -c`, which matches and kills that shell too.
3. Add it with `POST /api/store/repos {"url"}`, then install with `POST /api/store/install {"repoUrl", "itemPath", "type": "plugin"}`. Because the URL path differs, it installs as a separate plugin (`…-dev-<name>`).
4. **Let the user test.** After your own checks and screenshots, leave the dev install and its git server running, tell the user it is ready, and wait until they say they are done. Don't uninstall it in the same turn. To pick up changes meanwhile, rebuild the bare repository, copy it in again, call `POST /api/store/repos/refresh {"url"}` (otherwise install reuses the cached clone), then uninstall and install.
5. **Then always clean up.** Uninstall with `POST /api/store/uninstall` using the same body, remove the repository with `DELETE /api/store/repos {"url"}`, and confirm the panel, script and CSS are gone. Also stop any server you started in the container and delete its files. Otherwise the panel shows twice once the real install exists.

### Visual checks and Store screenshots

- **Browser.** Use a browser-automation tool if your environment provides one. Otherwise drive a local Chromium headless over `--remote-debugging-pipe`, with a throwaway `--user-data-dir` in the scratch folder. That opens no network port. `--screenshot` combined with `--virtual-time-budget` hangs on degoog's open result stream, so wait for a DOM condition instead, for example `[data-tstamp-card][data-tstamp-mounted="1"]`.
- **What to check.** The panel mounts. Dark and light themes are both right (emulate `prefers-color-scheme`). Nothing overflows at 1280px or at 390px. Interactive bits work: the timers tick, and the copy buttons copy the right text and reset. The console shows no errors from the plugin.
- **Required set.** Every plugin has exactly three screenshots, all of the same query: `1.webp` dark-mode desktop, `2.webp` light-mode desktop, `3.webp` dark-mode mobile. Each shows the search bar, the panel and the first result. The plugin README uses `1.webp`.
- **Desktop format.** About 1600px-wide WebP, the size of the official listings: a 1280×704 viewport at device scale 1.25, captured with `Page.captureScreenshot {format: "webp", quality: 90}`.
- **Mobile format.** A 390×844 viewport at device scale 2 (780×1688 WebP, same capture options), with `Emulation.setDeviceMetricsOverride {mobile: true}`, touch emulation and a mobile user agent, so degoog renders its phone layout. Sidebar panels are collapsed accordions there, so click the panel's `.sidebar-accordion-toggle` before capturing.
- **Set the emulated time zone** to a neutral one (`Emulation.setTimezoneOverride`, for example `America/New_York`), so screenshots don't reveal the user's real zone. Scan every image for anything else personal before committing.

## Documentation

- **Plugin `README.md`.** Write a one-paragraph summary, then a centered screenshot (`<div align="center"><img width="800" alt="…" src="./screenshots/1.webp" /></div>`). Follow with a trigger table of example queries, then one sentence per setting, and close with privacy and no-JS notes. degoog's in-app documentation viewer only shows absolute `http(s)` images, so relative screenshots appear on GitHub only.
- **Root `README.md`.** Add a row per extension to the table.
- **Keep docs in sync with behaviour.** Every trigger example in a README should have a test.

## Release checklist

1. `npm test` passes, and new behaviour has tests.
2. The `version` in `package.json` is bumped. Bump `minDegoogVersion` only if you used newer core APIs.
3. Locales have matching keys. Every user-facing string in `index.js` goes through `slot.t` or `{{ t:… }}`.
4. If the UI changed, it was checked live, in both themes and at mobile width. Refresh the screenshots if needed, keeping the required dark desktop, light desktop and dark mobile set of one query.
5. The user has finished testing the dev sideload, and it is then uninstalled, its repository removed and its server stopped.
6. Commit with a Conventional Commit message. Push only when the user asks. The GitHub repository must be public for the Store to clone it.
7. `AGENTS.md` is updated if this change taught you anything a future agent would need. See below.

## Maintaining this file

This file is part of the codebase, not a one-off note. Every agent that changes the repository is responsible for keeping it accurate.

- **Update it in the same commit** as the change that taught you something. Use the same Conventional Commit, or a separate `docs(agents): …` commit if the lesson stands on its own.
- **Add a section for each new extension type.** Give the first engine, theme, transport, autocomplete provider, shortcut or favicon provider its own `##` section, mirroring "Plugin anatomy". Cover the folder layout and required files, the export shape the degoog registry matches, contract details that are missing from the official docs, how to test it (unit and live), and screenshot conventions. Also add the type's folder to "Repository layout" and its array to the manifest example, and add any type-specific steps to the release checklist.
- **Keep cross-cutting lessons in the shared sections.** Security, testing infrastructure, Store behaviour and git conventions belong under their existing headings, not in a type section.
- **Only record what you verified.** Read degoog's source, or test against a live instance, before writing a claim down. Name the degoog file or route where it helps, and the degoog version when the behaviour may change. Mark anything unverified as such.
- **Correct, don't append.** When degoog changes or a rule here turns out to be wrong, edit or delete the stale text instead of adding a contradicting note. If a code bug caused the mistake, add a regression test too.
- **Keep it generic and public-safe.** No instance URLs, LAN addresses, credentials, personal usernames, time zones, or names of specific agents and tools. Use placeholders such as `<github-user>` and `<instance>`.
- **Keep it short.** Prefer one-line rules with the reason attached over long narratives. Keep each extension's own details in its README, not here.
