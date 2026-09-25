/**
 * Stored-session title resolution for `session/list`.
 *
 * Pure and dependency-injected on purpose. The behaviour this module exists to
 * pin — "a stored-session list never reads more logs than its budget allows,
 * and never falls back on a per-session `stat()`" — is a property of *how many
 * times* the persistence layer is called, which a boot-time smoke test cannot
 * observe on a scratch home (a fresh store has a handful of sessions, so even
 * an unbounded implementation finishes in milliseconds). The caller passes its
 * own `loadTitle` and clock so a test can count the reads exactly, and the
 * suite also pins (source-level) that the bridge itself never re-probes the
 * corpus with `stat()`.
 *
 * Why it is shaped this way:
 *
 * - `session/list` reports one title per entry, and the only source of a title
 *   is the session's own event log (`session/title` rows). Reading one log is
 *   one `open()` + a full decode.
 * - dsh 0.1.5 does that in ~9ms per log; 0.1.7 in ~217ms (measured on the same
 *   274-session store), so a corpus-sized read is the difference between 2.5s
 *   and a minute — and the ACP wire timeout is 30s.
 * - `persistence.stat(id)` is **not** a cheap size probe on 0.1.7: it folds in
 *   `historicalCorpusRevision` (a walk of every generation artifact, stat'd and
 *   hashed, uncached) for older-format logs. `list()` reports `sizeBytes` and
 *   `revision` for the whole corpus in one pass, which is where the size guard
 *   and the cache key come from instead.
 *
 * So the contract is: one `list()` per request, then at most the budget's worth
 * of `open()` reads, most recently updated first. Anything the budget does not
 * reach is handed to {@link StoredTitleReader#resolveRemaining}, which keeps
 * filling the cache off the request path.
 */

/** Bound on decoded titles held in one process (the list path touches every
 *  stored session, so the map must not grow with the corpus forever). */
export const DEFAULT_CACHE_LIMIT = 512

/** Per-log guard, applied to a `list()` snapshot's `sizeBytes`: a log this
 *  large is skipped rather than decoded for a sidebar label. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** Default `session/list` title budget (`DSH_ACP_LIST_BUDGET_MS`, ms). */
export const DEFAULT_BUDGET_MS = 2_500

/**
 * Parse a `DSH_ACP_LIST_BUDGET_MS`-style value into a usable budget.
 *
 * Deliberately strict: `Number('abc')` is `NaN`, and a `NaN` deadline makes the
 * per-candidate gate (`now >= deadline`) fire **never**, silently restoring the
 * unbounded corpus read this module exists to prevent; `Number('')` is `0`,
 * which starves the inline response of every title. Anything the caller cannot
 * turn into a finite non-negative number falls back to `defaultMs`.
 */
export function budgetFrom(value, defaultMs = DEFAULT_BUDGET_MS) {
  if (typeof value !== 'string' || value.trim() === '') return defaultMs
  const budget = Number(value)
  return Number.isFinite(budget) && budget >= 0 ? budget : defaultMs
}

/**
 * Order snapshots for title reads, most recently updated first.
 *
 * `session/list` is what fills an editor's session sidebar, which shows recent
 * activity; a budget smaller than the corpus must therefore decorate the
 * recency head. Cheapest-log-first was tried and measured worse: on a real
 * 301-session store the budget went to whichever old shells happened to be
 * tiny, so the inline response carried **no** titles while the sessions a user
 * actually looks at stayed bare. `updatedAt` here is the same timestamp the
 * list response reports, so titles arrive in the order the client renders.
 *
 * Entries above `maxBytes` are dropped entirely: their title is not worth a
 * decode.
 */
export function rankTitleCandidates(snapshots, maxBytes = DEFAULT_MAX_BYTES) {
  return snapshots
    .map((snapshot, index) => ({ snapshot, index }))
    .filter(({ snapshot }) => snapshot.sizeBytes === undefined || snapshot.sizeBytes <= maxBytes)
    .sort((a, b) => {
      const at = a.snapshot.updatedAt ?? a.snapshot.header.createdAt ?? 0
      const bt = b.snapshot.updatedAt ?? b.snapshot.header.createdAt ?? 0
      if (at !== bt) return bt - at
      // A total, stable order: two snapshots can share a millisecond, and the
      // tests pin this order.
      return String(a.snapshot.header.id).localeCompare(String(b.snapshot.header.id))
    })
}

/** The persistence layer's own content identity for a snapshot, used as the
 *  cache key: it changes when the stored content does, so a log that gained a
 *  title under an already-cached key is a miss, not a stale hit. */
export function titleCacheKey(snapshot) {
  return `${snapshot.header.id}@${snapshot.revision ?? 'unknown'}`
}

export class StoredTitleReader {
  /**
   * @param {object} deps
   * @param {(snapshot: object) => Promise<string|undefined>} deps.loadTitle
   *   Resolve one snapshot's last stored title. Must not be given a snapshot
   *   whose `sizeBytes` exceeds the guard.
   * @param {() => number} [deps.now] Clock, injectable for budget tests.
   * @param {(snapshot: object, title: string) => void} [deps.onTitle]
   *   Called for each title the deferred pass resolves (the bridge publishes
   *   it as `session_info_update`).
   * @param {() => boolean} [deps.stopped] Asked between deferred reads; lets a
   *   shutting-down bridge abandon the pass.
   * @param {number} [deps.cacheLimit]
   * @param {number} [deps.maxBytes]
   */
  constructor({ loadTitle, now = () => Date.now(), onTitle, stopped = () => false, cacheLimit = DEFAULT_CACHE_LIMIT, maxBytes = DEFAULT_MAX_BYTES }) {
    this.loadTitle = loadTitle
    this.now = now
    this.onTitle = onTitle
    this.stopped = stopped
    this.cacheLimit = cacheLimit
    this.maxBytes = maxBytes
    /** `id@revision` → title, or `false` for a cached "read, no title". */
    this.cache = new Map()
    /** Keys with a read in flight, so two callers never read one log twice. */
    this.inflight = new Set()
    /** Snapshots queued for the deferred pass, keyed like the cache. */
    this.pending = new Map()
    this.deferredRunning = false
  }

  /** Move `key` to the most-recently-used end and evict past the limit. */
  #remember(key, title) {
    this.cache.delete(key)
    this.cache.set(key, title === undefined ? false : title)
    while (this.cache.size > this.cacheLimit) {
      this.cache.delete(this.cache.keys().next().value)
    }
  }

  /**
   * One log's title, through the cache. A negative result is cached: asking
   * again must not re-read a log that has no title.
   */
  async #resolve(snapshot) {
    const key = titleCacheKey(snapshot)
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)
      return cached === false ? undefined : cached
    }
    if (this.inflight.has(key)) return undefined
    this.inflight.add(key)
    try {
      const title = await this.loadTitle(snapshot)
      this.#remember(key, title)
      return title
    } catch {
      // A corrupt or unreadable log vetoes its own title, never the caller.
      // Deliberately not cached: a transient failure must not pin "no title".
      return undefined
    } finally {
      this.inflight.delete(key)
    }
  }

  /**
   * Titles for one `session/list` request, within `budgetMs`. Returns
   * `{ titles, complete }`: `titles` maps the snapshot's position in the given
   * array to its title (absent = no title, or not reached), and `complete` is
   * false when the budget or the size guard left candidates unresolved — the
   * caller then schedules {@link resolveRemaining}.
   */
  async collect(snapshots, budgetMs) {
    const deadline = this.now() + budgetMs
    const ranked = rankTitleCandidates(snapshots, this.maxBytes)
    const titles = new Map()
    let complete = ranked.length === snapshots.length
    for (const { snapshot, index } of ranked) {
      const key = titleCacheKey(snapshot)
      if (this.cache.has(key)) {
        const cached = this.cache.get(key)
        if (cached !== false) titles.set(index, cached)
        continue
      }
      if (this.now() >= deadline) {
        complete = false
        continue
      }
      const title = await this.#resolve(snapshot)
      if (title !== undefined) titles.set(index, title)
    }
    return { titles, complete }
  }

  /**
   * Off the request path, keep resolving what {@link collect} could not reach
   * and report each title through `onTitle`. At most one pass runs at a time;
   * a call that lands mid-pass **merges** its snapshots into the running
   * pass's queue instead of being dropped — the queue, not the caller's array,
   * is the shared state, so snapshots the running pass never saw (a later
   * `session/list` over a changed corpus) are still reached exactly once.
   */
  async resolveRemaining(snapshots) {
    for (const { snapshot } of rankTitleCandidates(snapshots, this.maxBytes)) {
      const key = titleCacheKey(snapshot)
      if (this.cache.has(key) || this.inflight.has(key)) continue
      this.pending.set(key, snapshot)
    }
    if (this.deferredRunning) return
    this.deferredRunning = true
    try {
      while (this.pending.size > 0) {
        const batch = [...this.pending.values()]
        this.pending.clear()
        for (const snapshot of batch) {
          if (this.stopped()) return
          const key = titleCacheKey(snapshot)
          if (this.cache.has(key) || this.inflight.has(key)) continue
          const title = await this.#resolve(snapshot)
          if (title === undefined) continue
          try {
            this.onTitle?.(snapshot, title)
          } catch {
            // The client seam must not veto the pass: the cache is already
            // filled, and one unreportable title is not worth abandoning the
            // rest of the queue.
          }
        }
      }
    } finally {
      this.deferredRunning = false
    }
  }
}
