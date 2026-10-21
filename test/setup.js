// HelPhone Test Environment Setup & Cross-Realm Polyfills

if (typeof Symbol !== 'undefined' && Symbol.hasInstance && typeof Uint8Array !== 'undefined') {
  try {
    Object.defineProperty(Uint8Array, Symbol.hasInstance, {
      value(instance) {
        return (
          instance !== null &&
          typeof instance === 'object' &&
          (ArrayBuffer.isView(instance) ||
            instance.constructor?.name === 'Uint8Array' ||
            instance.constructor?.name === 'Buffer' ||
            Object.prototype.toString.call(instance) === '[object Uint8Array]')
        )
      },
      configurable: true,
    })
  } catch (e) {
    // Ignore if non-configurable
  }
}

// Attempt to load jest-dom matchers
try {
  await import("@testing-library/jest-dom")
} catch {
  // @testing-library/dom peer not installed
}

import { beforeAll, afterEach, afterAll } from "vitest";
import { server } from "../src/mocks/server.js";

// MSW intercepts network requests at the request layer (fetch/XHR), so tests
// no longer depend on ad-hoc `vi.spyOn(global, 'fetch')` mocks per-file for
// backend API / Horizon / Soroban RPC calls. Individual tests can still
// override a handler for one case via `server.use(...)`.
beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
