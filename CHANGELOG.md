# Changelog

## 4.1.0 (2026-10-12)

### Added

- Temperature, humidity and smoke sensors are exposed in HomeKit, one
  accessory per device (e.g. "Corridor Smoke Detector" for a connected smoke
  detector measuring all three), with the device's battery level and low
  battery warning. Readings follow Flexom sensor events and the periodic
  refresh. HomeKit notifies you when smoke is detected. Set `sensors` to
  `false`, or exclude a zone's sensors, to hide them.
- A sensor device Flexom lost contact with is flagged as faulty and inactive
  in HomeKit, and shows "No response" in the Home app, until it reports again.

## 4.0.0 (2026-10-11)

### Breaking changes

- Requires Node.js 22 or 24, and Homebridge 1.8 or later (Homebridge 2 supported).
- The unsupported "Show Flexom Things" option was removed.

### Fixed

- The WebSocket now reliably reconnects after network drops (dead connections
  are detected through heartbeats) and refreshes its token before reconnecting.
- Recovers from Flexom authentication API outages (5xx, 4xx) without restarting
  Homebridge: logins are retried with backoff, startup and each zone setup are
  retried until they succeed, and accessories show "No response" meanwhile.
- Fixed a failed Hemis login never being retried after a successful Ubiant login.
- Window coverings stay in sync with HomeKit: the target is kept while moving,
  the movement state follows position updates, moves from wall switches are
  followed, and a shutter stopping slightly off target shows the target.
- Accessories are no longer removed from HomeKit (losing their rooms, scenes
  and automations) when Flexom temporarily reports incomplete data: setup is
  retried, and accessories Flexom stops reporting are kept, showing "No
  response". Only configuration changes remove accessories.
- A missing or invalid `tolerance` setting defaults to 0.05, instead of
  breaking window coverings.
- Error logs now include the error message and HTTP status.
- Failed commands no longer cause unhandled promise rejections.

### Changed

- Nothing is written to the log (and so to disk) when receiving events, sending
  commands or answering HomeKit reads, sparing Raspberry Pi SD cards. Details
  are logged with Homebridge debug mode (`-D`).
- HomeKit reads are answered from memory instead of polling the Flexom API.
- Commands are only sent once changes stop: after 300 ms for lights, and 3 s
  for window coverings, as the Home app sends positions whenever a slider drag
  pauses. HomeKit shows the new target immediately.
- Built-in Flexom client replaces `@rsauget/flexom-lib`: no more global
  `WebSocket` override, and `@stomp/stompjs` is the only runtime dependency.

### Added

- Each zone's light and each of its window coverings are now separate HomeKit
  accessories (e.g. "Lounge Light", "Lounge Shutter 1", "Lounge Shutter 2"),
  so each can have its own name and room. Existing accessories are kept for
  lights and for zones with a single window covering. Set
  `separateAccessories` to `false` to keep them grouped.
- Window coverings are driven and read per device instead of per zone: each
  blind of a zone can be moved on its own, and positions come from the
  device's position motor. Venetian blinds used to show the average of their
  position and slat orientation (e.g. 50% when fully open).
- Venetian blinds: closing fully from HomeKit also closes the slats (dark
  room); any other position opens them.
- Zones with several lights (each with its own wall switch) now expose one
  HomeKit light per device ("Bathroom Light 1", "Bathroom Light 2"), each
  switched and read on its own, instead of a single light switching them all.
  The first light keeps the existing accessory; zones with a single light are
  unchanged.

- Periodic state refresh from the Flexom API (default every 15 minutes,
  configurable in seconds, 0 to disable) to fix missed events, e.g. a light
  switched with a wall switch.
