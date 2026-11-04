# degoog-extensions

Extensions for [degoog](https://github.com/degoog-org/degoog) search.

## Install

1. Open **Settings → Store** on your degoog instance.
2. Add this repository: `https://github.com/EthanC/degoog-extensions`
3. Install the extension you want from the list.

## Extensions

### Plugins

| Name | Type | Description |
| --- | --- | --- |
| [Timestamp](plugins/timestamp) | slot | Converts Unix timestamps into human readable UTC and local dates, and dates back into timestamps. Triggers on bare timestamps, ISO dates and keywords such as `epoch` or `unix time`. |
| [Time zone](plugins/timezone) | slot | Current time anywhere, time zone conversions and daylight saving dates, from plain questions such as `time in tokyo`, `5pm ET to PT` or `when do the clocks change`. |
| [Orbis Patches](plugins/orbis-patches) | slot | Looks up PlayStation 4 title IDs such as `CUSA04762` or `CUSA-04762` on ORBISPatches and shows the game’s name, art and a link to its patch page. |
| [Prospero Patches](plugins/prospero-patches) | slot | Looks up PlayStation 5 title IDs such as `PPSA01628` or `PPSA-01628` on PROSPEROPatches and shows the game’s name, art and a link to its patch page. |
| [QR Code Scanner](plugins/qr-scanner) | slot, command | Reads QR codes from an image you browse for, paste, drag in or link to, from searches such as `qr code reader` or the `!qrscan` bang. Images are decoded in your browser. |

## Development

Tests run on Node 20 or newer, no dependencies required:

```sh
npm test
```

Each extension lives in its own folder with an `index.js` entry, an `author.json`, optional `template.html`, `style.css`, `script.js`, `locales/` and a `README.md` that the Store shows as documentation. The root `package.json` is the Store manifest.
