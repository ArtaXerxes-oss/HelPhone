# Browser security architecture

HelPhone requires cross-origin isolation for SharedArrayBuffer-backed,
multithreaded proving. Development, preview, and Express responses send COOP
same-origin and COEP credentialless. The worker explicitly falls back to one
thread when crossOriginIsolated or SharedArrayBuffer is unavailable.

credentialless is selected because Mapbox styles, vector tiles, workers, and
images span multiple origins. It strips credentials from no-CORS subresources
instead of requiring every response to carry CORP. Mapbox requests remain CORS
requests and the wrapper reports isolation state after map load. If a target
Safari release lacks credentialless isolation, proving remains functional in
single-thread mode; do not switch globally to require-corp without proxying and
auditing every third-party asset.

Verify crossOriginIsolated and SharedArrayBuffer in the supported Chrome,
Firefox, and Safari browser matrix after deployment. The /health response
headers provide a quick production smoke check.
