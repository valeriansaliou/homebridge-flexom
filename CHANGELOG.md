# Changelog

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
- Error logs now include the error message and HTTP status.
- Failed commands no longer cause unhandled promise rejections.

### Changed

- Nothing is written to the log (and so to disk) when receiving events, sending
  commands or answering HomeKit reads, sparing Raspberry Pi SD cards. Details
  are logged with Homebridge debug mode (`-D`).
- HomeKit reads are answered from memory instead of polling the Flexom API.
- Commands are sent after 300 ms instead of 1 s; dragging a slider still sends
  only the final value.
- Built-in Flexom client replaces `@rsauget/flexom-lib`: no more global
  `WebSocket` override, and `@stomp/stompjs` is the only runtime dependency.

### Added

- Periodic state refresh from the Flexom API (default every 15 minutes,
  configurable in seconds, 0 to disable) to fix missed events, e.g. a light
  switched with a wall switch.
