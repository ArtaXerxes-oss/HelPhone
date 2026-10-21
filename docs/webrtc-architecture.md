# WebRTC traversal architecture

The client gathers host, server-reflexive (STUN), and relay (TURN) candidates
and records time-to-candidate and total gathering latency. Public STUN alone is
not sufficient for symmetric NAT or restrictive mobile networks; production
must configure authenticated TURN through TURN_URLS, TURN_USERNAME, and
TURN_CREDENTIAL.

A server-reflexive or relay candidate keeps WebRTC. Gathering failure, timeout,
or a relay-required session without a relay selects WebSocket transport. That
fallback is for bounded emergency snapshots, not unconstrained raw video.

The unit benchmark is deterministic. Real latency and success-rate tests belong
in a controlled browser/network matrix because public-server latency and NAT
topology cannot be asserted reliably in CI.
