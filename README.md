<p align="center">

<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge Flexom plugin

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![Downloads](https://img.shields.io/npm/dt/@rsauget/homebridge-flexom)](https://www.npmjs.com/package/@rsauget/homebridge-flexom)
[![Version](https://img.shields.io/npm/v/@rsauget/homebridge-flexom)](https://www.npmjs.com/package/@rsauget/homebridge-flexom)
[![GitHub issues](https://img.shields.io/github/issues/rsauget/homebridge-flexom)](https://github.com/rsauget/homebridge-flexom/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/rsauget/homebridge-flexom)](https://github.com/rsauget/homebridge-flexom/pulls)
[![GitHub Workflow Status](https://img.shields.io/github/workflow/status/rsauget/homebridge-flexom/Build%20and%20Lint)](https://github.com/rsauget/homebridge-flexom)

This Homebridge plugin exposes Flexom smart homes to Apple HomeKit.

## Features

- Flexom Zones (i.e. rooms) appear as HomeKit accessories with light and window covering (rolling shutter) controls.
- Changes made outside HomeKit (wall switches, Flexom app) are reflected live through the Flexom WebSocket, and every zone is periodically refreshed from the Flexom API in case an event was missed.
- Recovers on its own from network drops and Flexom API outages, without restarting Homebridge.
- Nothing is written to the Homebridge log during normal operation (events, commands), sparing Raspberry Pi SD cards. Use Homebridge debug mode (`-D`) to see details.

## Requirements

- Node.js 22 or 24
- Homebridge 1.8 or later (Homebridge 2 supported)

## Install

The recommended way to install this plugin is through [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x).
You will find it easily by searching `@rsauget/homebridge-flexom`.
For other installation methods, please refer to the [Homebridge documentation](https://github.com/homebridge/homebridge/wiki).

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
