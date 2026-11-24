import { initializeTelemetry, registerSamplingEngine } from "./telemetry.js";
import { OtelSamplingEngine } from "./lib/otelSamplingEngine.js";

// #759: configure quota sampling from the documented OTEL_* settings before
// the SDK starts, so instrumented HTTP/Express spans go through the engine.
const engine = OtelSamplingEngine.fromEnvironment();
registerSamplingEngine(engine);
initializeTelemetry({ samplingEngine: engine });
