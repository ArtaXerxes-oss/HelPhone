/**
 * ZK proof-generation strategy (#86).
 *
 * `generateLocationProof` in `zk.js` used to branch between server-side and
 * browser-side proving with an inline `if (proverUrl) { … } else { … }`.
 * This file pulls that decision into a small strategy: a common
 * {@link ProofGenerator} shape, two concrete implementations
 * ({@link ServerProver}, {@link BrowserProver}), and a selector.
 *
 * The concrete proving work still lives in `zk.js` — the provers are thin
 * adapters that hold the runtime context (prover URL, fallback flag) and
 * call back into the implementation functions passed to their constructors.
 * Behaviour, error messages and the single-flight lock are unchanged; only
 * the dispatch is restructured.
 */

/**
 * @typedef {object} ProofResult
 * @property {Uint8Array} proof
 * @property {Uint8Array} publicInputsBytes
 * @property {Uint8Array} publicInputsPrefix
 * @property {string} nullifier
 * @property {object} zone
 */

/**
 * Common interface every prover implements.
 *
 * `isAvailable()` is a cheap, synchronous check of whether this strategy is
 * even eligible for the current runtime (a configured URL, an opt-in flag).
 * It is **not** a network health check — a `ServerProver` can be "available"
 * and still fail in `generate()` if the server is down; the caller decides
 * whether to fall through to the next prover on that failure.
 *
 * `generate(opts)` runs the proof and resolves a {@link ProofResult}, or
 * rejects with a caller-facing `Error`.
 */
export class ProofGenerator {
  /** @returns {string} stable identifier, e.g. `'server'` / `'browser'` */
  get name() {
    throw new Error('ProofGenerator.name is abstract')
  }

  /** @returns {boolean} */
  isAvailable() {
    throw new Error('ProofGenerator.isAvailable() is abstract')
  }

  /**
   * @param {object} _opts
   * @returns {Promise<ProofResult>}
   */
  async generate(_opts) {
    throw new Error('ProofGenerator.generate() is abstract')
  }
}

/**
 * Proves via the remote ZK prover server (health check + `/prove`).
 *
 * Always eligible when a `proverUrl` is configured; a dead server surfaces
 * as a rejection from {@link generate}, at which point the dispatcher in
 * `zk.js` decides whether {@link BrowserProver} may take over.
 */
export class ServerProver extends ProofGenerator {
  /**
   * @param {{ proverUrl: string, request: (opts: object) => Promise<ProofResult> }} deps
   *   `request` is `zk.js`'s `_requestServerProof` (health check included).
   */
  constructor({ proverUrl, request }) {
    super()
    this.proverUrl = proverUrl
    this._request = request
  }

  get name() {
    return 'server'
  }

  isAvailable() {
    return Boolean(this.proverUrl)
  }

  generate(opts) {
    return this._request({ ...opts, proverUrl: this.proverUrl })
  }
}

/**
 * Proves in-browser with Noir + Barretenberg.
 *
 * Only eligible when `VITE_ZK_BROWSER_FALLBACK === 'true'` *as a fallback
 * after a server failure*; when there is no server configured at all it runs
 * unconditionally (matching the previous behaviour, where a missing
 * `VITE_ZK_PROVER_URL` fell straight through to browser proving). The
 * `run` implementation keeps the existing single-flight lock so a second
 * concurrent call awaits the first proof rather than starting another.
 */
export class BrowserProver extends ProofGenerator {
  /**
   * @param {{ allowed: boolean, run: (opts: object) => Promise<ProofResult> }} deps
   *   `run` is `zk.js`'s lock-wrapped browser proof runner.
   */
  constructor({ allowed, run }) {
    super()
    this._allowed = Boolean(allowed)
    this._run = run
  }

  get name() {
    return 'browser'
  }

  isAvailable() {
    return this._allowed
  }

  generate(opts) {
    return this._run(opts)
  }
}

/**
 * Builds the ordered prover list for the current runtime: `ServerProver`
 * first when a URL is configured, then `BrowserProver`. `zk.js` walks this
 * list, trying the server and (subject to `BrowserProver.isAvailable()`)
 * falling through to the browser.
 *
 * @param {{
 *   proverUrl: string,
 *   allowBrowserFallback: boolean,
 *   requestServerProof: (opts: object) => Promise<ProofResult>,
 *   runBrowserProof: (opts: object) => Promise<ProofResult>,
 * }} ctx
 * @returns {ProofGenerator[]}
 */
export function selectProvers({
  proverUrl,
  allowBrowserFallback,
  requestServerProof,
  runBrowserProof,
}) {
  const provers = []
  if (proverUrl) {
    provers.push(new ServerProver({ proverUrl, request: requestServerProof }))
  }
  provers.push(
    new BrowserProver({ allowed: allowBrowserFallback, run: runBrowserProof }),
  )
  return provers
}
