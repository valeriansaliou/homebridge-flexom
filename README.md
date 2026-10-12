# Homebridge Flexom plugin

This Homebridge plugin exposes Flexom smart homes to Apple HomeKit.

## This is a forked library!

This is a fork of [@rsauget/homebridge-flexom](https://github.com/rsauget/homebridge-flexom). Changes made since the fork:

- One HomeKit accessory per device: each light, roller shutter and venetian blind of a zone is driven and read on its own, instead of the whole zone at once.
- Lights and window coverings are separate accessories, so each can have its own name and room (`separateAccessories` option).
- Venetian blinds show their actual position (they used to average position and slat orientation, e.g. 50% when fully open), and closing fully also closes the slats.
- Window coverings stay in sync with HomeKit: the target is kept while moving, moves from wall switches and the Flexom app are followed, and commands are only sent once the Home app slider is released.
- Zone states are periodically refreshed from the Flexom API, in case a WebSocket event was missed.
- Automatic recovery from network drops, WebSocket disconnections and Flexom API outages, without restarting Homebridge.
- Accessories are never removed from HomeKit because Flexom temporarily reported incomplete data, preserving their rooms, scenes and automations.
- Nothing is written to the log during normal operation, sparing Raspberry Pi SD cards; HomeKit reads are answered from memory.
- Built-in Flexom client replacing `@rsauget/flexom-lib`, with `@stomp/stompjs` as the only runtime dependency.
- Modernized toolchain: Node.js 22/24, Homebridge 2 support, TypeScript 6, ESLint 10, Vitest, and a test suite.

See the [changelog](CHANGELOG.md) for details.

## Features

- Flexom Zones (i.e. rooms) appear in HomeKit as light and window covering accessories, with one accessory per light, roller shutter or venetian blind.
- Venetian blinds: closing fully also closes the slats (dark room); any other position opens them, to see outside.
- Changes made outside HomeKit (wall switches, Flexom app) are reflected live through the Flexom WebSocket, and every zone is periodically refreshed from the Flexom API in case an event was missed.
- Recovers on its own from network drops and Flexom API outages, without restarting Homebridge.
- Never removes an accessory from HomeKit because Flexom stopped reporting it (only configuration changes do), so an API glitch cannot wipe your rooms, scenes and automations. To remove the accessory of a device you removed from Flexom, use "Remove Single Cached Accessory" in the Homebridge UI settings.
- Nothing is written to the Homebridge log during normal operation (events, commands), sparing Raspberry Pi SD cards. Use Homebridge debug mode (`-D`) to see details.

## Requirements

- Node.js 22 or 24
- Homebridge 1.8 or later (Homebridge 2 supported)

## Install

- Build the plugin archive locally: `npm run build && npm pack`
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
