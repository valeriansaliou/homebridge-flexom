# Homebridge Flexom plugin

This Homebridge plugin exposes Flexom smart homes to Apple HomeKit.

⚠️  **This is a fork of [@rsauget/homebridge-flexom](https://github.com/rsauget/homebridge-flexom) containing improvements for venetian blinds, WebSocket connectivity, and other fixes.**

## Features

- Flexom Zones (i.e. rooms) appear in HomeKit as light and window covering accessories, with one accessory per roller shutter or venetian blind.
- Venetian blinds: closing fully also closes the slats (dark room); any other position opens them, to see outside.
- Changes made outside HomeKit (wall switches, Flexom app) are reflected live through the Flexom WebSocket, and every zone is periodically refreshed from the Flexom API in case an event was missed.
- Recovers on its own from network drops and Flexom API outages, without restarting Homebridge.
- Never removes an accessory from HomeKit because Flexom stopped reporting it (only configuration changes do), so an API glitch cannot wipe your rooms, scenes and automations. To remove the accessory of a device you removed from Flexom, use "Remove Single Cached Accessory" in the Homebridge UI settings.
- Nothing is written to the Homebridge log during normal operation (events, commands), sparing Raspberry Pi SD cards. Use Homebridge debug mode (`-D`) to see details.

## Requirements

- Node.js 22 or 24
- Homebridge 1.8 or later (Homebridge 2 supported)

## Install

- Build the `tgz` archive locally
- Copy it to your Homebridge server in `/tmp`
- Enter `hb-shell`
- Run: `npm install /tmp/[archive_name].tgz`
- Restart Homebridge to reload the plugin

## Configuration

| Option                          | Default | Description                                                                                              |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `email`, `password`             |         | Flexom account credentials                                                                               |
| `zones`                         | `true`  | Expose Flexom Zones as accessories                                                                       |
| `tolerance`                     | `0.05`  | How far (0-1) a window covering can stop from its target and still be considered there                   |
| `refreshInterval`               | `5`     | Minutes between state refreshes from the Flexom API, `0` to disable                                      |
| `excludeZones`, `excludedZones` |         | Disable the light and/or window control of some zones (zone id: accessory serial number in the Home app) |

## Development

Requires Node.js 22 or later.

```sh
npm install
npm run lint        # ESLint
npm run typecheck   # TypeScript
npm test            # Vitest unit tests
npm run build       # compile to dist/
npm run test:smoke  # load the build with the real WebSocket library
```

To run the plugin in a local Homebridge that restarts on every change, with its own storage folder (create `config.json` there with a `Flexom` platform, and make sure the bridge port is not used by another instance):

```sh
HOMEBRIDGE_STORAGE=~/.homebridge-flexom-dev npm run watch
```

Homebridge runs in insecure mode (`-I`), so characteristics can be read and set with `curl` without pairing, using the bridge PIN as `Authorization` header.
