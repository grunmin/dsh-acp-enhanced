#!/usr/bin/env node
/**
 * Unit tests for lib/stored-titles.js — the `session/list` stored-title reader.
 *
 * This is the regression guard for the 0.1.7 list stall: `session/list` used to
 * probe `persistence.stat(id)` and then decode the log **per stored session**,
 * which turned a 274-session store into a 60-second RPC (0.1.5: 2.5s) that the
 * client's 30-second wire timeout killed. A boot-time smoke test cannot see it
 * — a scratch `DSH_HOME` has a handful of sessions, so even an unbounded
 * implementation finishes in milliseconds.
 *
 * The reader is dependency-injected for exactly that reason: the fake below
 * counts every load and its `stat()` throws, so "the list path never calls
 * `stat()`" and "the read count is bounded by the budget, not the corpus" are
 * both observable without a harness, a model or a profile.
 */
import { StoredTitleReader, rankTitleCandidates, titleCacheKey, DEFAULT_MAX_BYTES } from '../lib/stored-titles.js'

let failed = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

/** `n` snapshots of `sizeBytes` each, ids `s0…s(n-1)`, all at revision 1. */
const snapshots = (n, sizeBytes = 1024) => Array.from({ length: n }, (_, i) => ({
  header: { id: `s${i}`, cwd: '/w' },
  revision: '1',
  sizeBytes,
}))

/**
 * A persistence stand-in with the two members the reader is allowed to touch:
 * `list()` (once per request) and a log read. `stat()` throws, so any code path
 * that reaches for it fails the test rather than passing quietly.
 */
function fakePersistence({ titles = {}, loadMs = 5 } = {}) {
  const state = { listCalls: 0, statCalls: 0, loads: [], failed: new Set() }
  return {
    state,
    persistence: {
      async list() {
        state.listCalls += 1
        return []
      },
      async stat(id) {
        state.statCalls += 1
        throw new Error(`stat() is not part of the list contract (id=${id})`)
      },
      async loadTitle(snapshot) {
        state.loads.push(snapshot.header.id)
        if (state.failed.has(snapshot.header.id)) throw new Error(`unreadable ${snapshot.header.id}`)
        return titles[snapshot.header.id]
      },
    },
    loadMs,
  }
}

/** A deterministic clock that only advances when a load runs. */
function fakeClock(stepMs) {
  let t = 1_000
  return { now: () => t, advance: () => { t += stepMs } }
}

function makeReader({ titles, loadMs, cacheLimit, onTitle, stopped } = {}) {
  const fake = fakePersistence({ titles, loadMs })
  const clock = fakeClock(loadMs ?? 5)
  const reader = new StoredTitleReader({
    loadTitle: async (snapshot) => {
      const title = await fake.persistence.loadTitle(snapshot)
      clock.advance()
      return title
    },
    now: clock.now,
    onTitle,
    stopped,
    cacheLimit,
  })
  return { reader, fake, clock }
}

// ── titles land on the right entries ────────────────────────────────────────

{
  const snaps = snapshots(4)
  const { reader, fake } = makeReader({ titles: { s0: 'alpha', s2: 'gamma' } })
  const { titles, complete } = await reader.collect(snaps, 1_000)
  check('a titled log is reported at its own index',
    titles.get(0) === 'alpha' && titles.get(2) === 'gamma',
    JSON.stringify([...titles]))
  check('an untitled log is absent from the map, not null', titles.has(1) === false && titles.has(3) === false)
  check('the pass reports itself complete when the budget covers the corpus', complete === true)
  check('the whole corpus is read exactly once', fake.state.loads.length === 4, `loads=${fake.state.loads.join(',')}`)
}

// ── the list path never probes with stat() ──────────────────────────────────

{
  const { reader, fake } = makeReader({ titles: { s0: 'alpha' } })
  await reader.collect(snapshots(3), 1_000)
  check('collect() never calls persistence.stat()', fake.state.statCalls === 0,
    `statCalls=${fake.state.statCalls}`)
}

// ── the budget bounds the work; the corpus size does not ────────────────────

{
  const snaps = snapshots(500)
  const { reader, fake } = makeReader({ titles: { s0: 'alpha' }, loadMs: 5 })
  // 5ms per load, 50ms of budget ≈ 10 loads.
  const { titles, complete } = await reader.collect(snaps, 50)
  check('a 500-session corpus is not read in full inside the budget',
    fake.state.loads.length < 20, `loads=${fake.state.loads.length}`)
  check('an unfinished pass reports complete=false so the caller can defer it', complete === false)
  check('the budget still returns the titles it did reach', titles.get(0) === 'alpha')
}

{
  // The cost tracks the budget, not N: ten times the sessions, same budget.
  const small = makeReader({ titles: {}, loadMs: 5 })
  const large = makeReader({ titles: {}, loadMs: 5 })
  await small.reader.collect(snapshots(50), 100)
  await large.reader.collect(snapshots(5_000), 100)
  check('10x the corpus at the same budget does not multiply the reads',
    large.fake.state.loads.length <= small.fake.state.loads.length + 2,
    `small=${small.fake.state.loads.length} large=${large.fake.state.loads.length}`)
}

// ── most recent first, so a short budget decorates the recency head ─────────

{
  const snaps = [
    { header: { id: 'old', createdAt: 100 }, revision: '1', sizeBytes: 500_000, updatedAt: 100 },
    { header: { id: 'newest', createdAt: 300 }, revision: '1', sizeBytes: 500_000, updatedAt: 300 },
    { header: { id: 'middle', createdAt: 200 }, revision: '1', sizeBytes: 500_000, updatedAt: 200 },
  ]
  const { reader, fake } = makeReader({ titles: {}, loadMs: 5 })
  // The fake clock advances 5ms per load and the budget check is a start-time
  // gate, so a 5ms budget admits only the first candidate.
  await reader.collect(snaps, 5)
  check('the ranking reads the most recently updated log first',
    fake.state.loads.join(',') === 'newest', `loads=${fake.state.loads.join(',')}`)
  check('the ranking order is most-recent-first',
    rankTitleCandidates(snaps).map((r) => r.snapshot.header.id).join(',') === 'newest,middle,old')
  check('the ranking falls back to the header createdAt',
    rankTitleCandidates([{ header: { id: 'a', createdAt: 1 }, revision: '1' }, { header: { id: 'b', createdAt: 9 }, revision: '1' }])
      .map((r) => r.snapshot.header.id).join(',') === 'b,a')
  check('the ranking is total and stable for equal timestamps',
    rankTitleCandidates([{ header: { id: 'z' }, revision: '1' }, { header: { id: 'a' }, revision: '1' }])
      .map((r) => r.snapshot.header.id).join(',') === 'a,z')
}

// ── the size guard skips a log instead of decoding it ───────────────────────

{
  const oversized = { header: { id: 'huge' }, revision: '1', sizeBytes: DEFAULT_MAX_BYTES + 1 }
  const { reader, fake } = makeReader({ titles: {} })
  const { complete } = await reader.collect([oversized], 1_000)
  check('an oversized log is never loaded', fake.state.loads.length === 0)
  // The guard dropped the only candidate: nothing was read, and nothing is left
  // for the deferred pass to reach either.
  check('an oversized log leaves nothing for the deferred pass to read', complete === false)
  check('rankTitleCandidates drops entries above the guard',
    rankTitleCandidates([oversized, { header: { id: 'ok' }, revision: '1', sizeBytes: 10 }]).length === 1)
  check('an absent sizeBytes is allowed through (older list() shapes)',
    rankTitleCandidates([{ header: { id: 'x' }, revision: '1' }]).length === 1)
}

// ── caching: by revision, negative results included ─────────────────────────

{
  const snaps = snapshots(2)
  const { reader, fake } = makeReader({ titles: { s0: 'alpha' } })
  await reader.collect(snaps, 1_000)
  await reader.collect(snaps, 1_000)
  check('a second pass over an unchanged corpus reads nothing', fake.state.loads.length === 2,
    `loads=${fake.state.loads.join(',')}`)
}

{
  const { reader, fake } = makeReader({ titles: {} })
  await reader.collect(snapshots(1), 1_000)
  await reader.collect(snapshots(1), 1_000)
  check('a cached "no title" is not re-read', fake.state.loads.length === 1,
    `loads=${fake.state.loads.join(',')}`)
  check('revision is the cache key component', titleCacheKey({ header: { id: 's0' }, revision: '9' }) === 's0@9')
}

{
  const { reader, fake } = makeReader({ titles: { s0: 'alpha' } })
  const before = snapshots(1)
  await reader.collect(before, 1_000)
  // Same id, new revision: the stored content moved, so the title must be re-read.
  await reader.collect([{ header: { id: 's0' }, revision: '2', sizeBytes: 1024 }], 1_000)
  check('a new revision misses the cache and re-reads the log', fake.state.loads.length === 2,
    `loads=${fake.state.loads.join(',')}`)
}

{
  const { reader } = makeReader({ titles: { s0: 'alpha' } })
  const fresh = [{ header: { id: 's0' }, revision: '1', sizeBytes: 1024 }]
  await reader.collect(fresh, 1_000)
  check('the cache serves the title on a re-list', (await reader.collect(fresh, 1_000)).titles.get(0) === 'alpha')
  check('the cache did not grow a second entry for the same key', reader.cache.size === 1,
    `cache=${reader.cache.size}`)
}

// ── failures are per-log, never per-request ─────────────────────────────────

{
  const { reader, fake } = makeReader({ titles: { s1: 'beta' } })
  fake.state.failed.add('s0')
  const { titles } = await reader.collect(snapshots(2), 1_000)
  check('an unreadable log does not fail the pass', titles.get(1) === 'beta')
  check('an unreadable log yields no title for itself', titles.has(0) === false)
}

{
  const { reader, fake } = makeReader({ titles: { s0: 'alpha' } })
  fake.state.failed.add('s0')
  await reader.collect(snapshots(1), 1_000)
  fake.state.failed.delete('s0')
  const { titles } = await reader.collect(snapshots(1), 1_000)
  check('a read failure is not cached, so a later pass can recover',
    titles.get(0) === 'alpha' && fake.state.loads.length === 2,
    `loads=${fake.state.loads.join(',')}`)
}

// ── the deferred pass: fills the rest and reports each title once ───────────

{
  const snaps = snapshots(6)
  const reported = []
  const { reader, fake } = makeReader({
    titles: { s0: 'a', s1: 'b', s2: 'c', s3: 'd', s4: 'e', s5: 'f' },
    loadMs: 5,
    onTitle: (snapshot, title) => reported.push(`${snapshot.header.id}=${title}`),
  })
  // 5ms per load, 22ms of budget: the per-load budget check admits five loads
  // (the last one starts below the deadline), leaving s5 to the deferred pass.
  const { complete } = await reader.collect(snaps, 22)
  check('the first pass is incomplete before the deferred work', complete === false)
  check('the first pass filled exactly what the budget covered',
    reader.cache.size === 5, `cache=${reader.cache.size}`)
  await reader.resolveRemaining(snaps)
  check('the deferred pass reports only the titles the first pass missed',
    reported.join(',') === 's5=f', `reported=${reported.join(',')}`)
  const before = fake.state.loads.length
  await reader.resolveRemaining(snaps)
  check('a second deferred pass re-reads nothing', fake.state.loads.length === before)
  check('the deferred pass does not re-report titles', reported.length === 1)
}

{
  // Two overlapping deferred passes must not double-read the shared corpus.
  const snaps = snapshots(8)
  const { reader, fake } = makeReader({ titles: {}, loadMs: 2 })
  await Promise.all([reader.resolveRemaining(snaps), reader.resolveRemaining(snaps)])
  check('overlapping deferred passes read each log once', fake.state.loads.length === 8,
    `loads=${fake.state.loads.length}`)
}

{
  const snaps = snapshots(5)
  const { reader, fake } = makeReader({ titles: {}, loadMs: 2, stopped: () => true })
  await reader.resolveRemaining(snaps)
  check('a stopping bridge abandons the deferred pass immediately', fake.state.loads.length === 0)
}

// ── the cache is bounded ────────────────────────────────────────────────────

{
  const { reader } = makeReader({ titles: {}, cacheLimit: 4 })
  await reader.collect(snapshots(10), 10_000)
  check('the title cache never exceeds its limit', reader.cache.size === 4, `size=${reader.cache.size}`)
  const keys = [...reader.cache.keys()]
  check('eviction drops the least-recently-used keys first',
    keys.join(',') === 's6@1,s7@1,s8@1,s9@1', `keys=${keys.join(',')}`)
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
