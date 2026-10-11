// Loads the built WebSocket client with the real (ESM-only) stompjs package,
// which unit tests mock, and checks that it tries to connect and stops cleanly.
const { createWsClient } = require('../dist/flexom/ws.js');

const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop };

(async () => {
  let attempts = 0;
  const ws = await createWsClient({
    wsUrl: 'ws://127.0.0.1:9',
    buildingId: 'smoke-test',
    getToken: async () => {
      attempts += 1;
      return 'token';
    },
    onEvent: noop,
    onConnect: noop,
    onStompError: noop,
    logger,
  });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await ws.disconnect();
  if (attempts < 2)
    throw new Error(`expected reconnect attempts, got ${attempts}`);
  console.log(`Smoke test OK (${attempts} connection attempts)`);
})().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
