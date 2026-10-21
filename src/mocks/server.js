import { setupServer } from "msw/node";
import { handlers } from "./handlers.js";

// Node-side MSW server for Vitest (jsdom environment, no Service Worker
// available). Started/stopped in test/setup.js.
export const server = setupServer(...handlers);
