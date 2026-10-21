import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Issue #328 — Ranking.jsx race condition in asynchronous state
//
// Switching the period tab quickly re-triggers the effect before the prior
// getRanking() call resolves. Out-of-order resolution used to let a stale
// response overwrite the latest one. This simulates the hardened effect
// (stale-response guard via a per-run `ignore` flag) from Ranking.jsx.
// ---------------------------------------------------------------------------

function makeEntries(tag) {
  return [{ responder: `G${tag}`, total_arrivals: 1 }]
}

function runEffect(getRanking, setRows, setLoading) {
  let ignore = false
  async function load() {
    setLoading(true)
    try {
      const entries = await getRanking()
      if (ignore) return
      const sorted = entries
        .sort((a, b) => b.total_arrivals - a.total_arrivals)
        .slice(0, 20)
      setRows(sorted)
    } catch {
      if (!ignore) setRows([])
    }
    if (!ignore) setLoading(false)
  }
  load()
  return () => {
    ignore = true
  }
}

describe('Ranking effect — stale response guard', () => {
  it('does not let a slow first call overwrite a fast second call', async () => {
    const rows = []
    const setRows = vi.fn((v) => rows.push(v))
    const setLoading = vi.fn()

    let resolveFirst
    const getRanking = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
      .mockImplementationOnce(() => Promise.resolve(makeEntries('fast')))

    // First effect run (slow) — simulates selecting period A
    const cleanupA = runEffect(getRanking, setRows, setLoading)
    // Cleanup runs before the next effect, as React does on dependency change
    cleanupA()
    // Second effect run (fast) — simulates quickly selecting period B
    runEffect(getRanking, setRows, setLoading)

    // Let the fast call resolve first
    await Promise.resolve()
    await Promise.resolve()

    // Now let the slow first call resolve after the fast one already set rows
    resolveFirst(makeEntries('slow'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Only the fast (latest) response should have been committed to state
    expect(setRows).toHaveBeenCalledTimes(1)
    expect(setRows).toHaveBeenCalledWith(makeEntries('fast'))
  })

  it('ignores a stale rejection after cleanup', async () => {
    const setRows = vi.fn()
    const setLoading = vi.fn()

    let rejectFirst
    const getRanking = vi.fn().mockImplementationOnce(
      () => new Promise((_, rej) => { rejectFirst = rej })
    )

    const cleanup = runEffect(getRanking, setRows, setLoading)
    cleanup()
    rejectFirst(new Error('network down'))
    await Promise.resolve()
    await Promise.resolve()

    expect(setRows).not.toHaveBeenCalled()
  })

  it('still commits results when no cleanup has run', async () => {
    const setRows = vi.fn()
    const setLoading = vi.fn()
    const getRanking = vi.fn().mockResolvedValue(makeEntries('only'))

    runEffect(getRanking, setRows, setLoading)
    await Promise.resolve()
    await Promise.resolve()

    expect(setRows).toHaveBeenCalledWith(makeEntries('only'))
  })
})
