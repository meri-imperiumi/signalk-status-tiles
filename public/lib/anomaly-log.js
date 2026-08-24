/**
 * Durable anomaly log (SPEC §10): every detected unclaimed anomaly is
 * appended — surfaced or not, including ones bumped by something more
 * severe — so a transient that reverts before anyone looks at the screen
 * isn't lost. A "Squawks"-style running list.
 *
 * Storage is injectable with the Web Storage API shape
 * (`getItem`/`setItem`): the webapp passes `window.localStorage`
 * (survives reloads and server restarts — the browser persists it); node
 * tests pass an in-memory map or nothing (memory-only fallback).
 * Malformed persisted state is discarded rather than thrown on: the log
 * is a flight recorder, not load-bearing state.
 *
 * Entries are bounded (`maxEntries`, oldest dropped first) so a
 * long-running display can't grow storage unboundedly. A path that
 * re-opens after clearing appends a fresh entry — reopen is a new event,
 * not an edit of history.
 *
 * @file anomaly-log.js */

const STORAGE_KEY = "signalk-status-tiles:anomaly-log";

export class AnomalyLog {
  /**
   * @param {Storage|{getItem(string): string|null, setItem(string, string): void}|null} [storage]
   * @param {object} [opts]
   * @param {number} [opts.maxEntries]
   */
  constructor(storage = null, opts = {}) {
    /** @type {Storage|null} */
    this.storage = storage;
    this.maxEntries = opts.maxEntries ?? 100;
    /** @type {Array<{path: string, state: string, zone: string, value: number, firstSeen: number, openedAt: number, clearedAt: number|null}>} */
    this.entries = this.#load();
  }

  /**
   * @returns {Array} parsed entries, or [] when storage is absent/malformed
   */
  #load() {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  #persist() {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      // Quota/private-mode: keep serving from memory, never throw.
    }
  }

  /** The most recent still-open entry for a path, if any. */
  #openEntry(path) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.path === path) return e.clearedAt == null ? e : null;
    }
    return null;
  }

  /**
   * Records an anomaly opening (from the tracker's `opened` event).
   * No-op when the path is already open (one entry per open episode).
   * @param {{path: string, state: string, zone: string, value: number, firstSeen: number}} ev
   * @param {number} [now]
   */
  record(ev, now = Date.now()) {
    if (this.#openEntry(ev.path)) return;
    this.entries.push({
      path: ev.path,
      state: ev.state,
      zone: ev.zone,
      value: ev.value,
      firstSeen: ev.firstSeen,
      openedAt: now,
      clearedAt: null,
    });
    if (this.entries.length > this.maxEntries) {
      // Prefer dropping long-closed history over open episodes.
      const idx = this.entries.findIndex((e) => e.clearedAt != null);
      if (idx >= 0) this.entries.splice(idx, 1);
      else this.entries.shift();
    }
    this.#persist();
  }

  /**
   * Marks a path's open episode as cleared (from the tracker's `cleared`
   * event). No-op when nothing is open.
   * @param {string} path
   * @param {number} [clearedAt]
   */
  clear(path, clearedAt = Date.now()) {
    const e = this.#openEntry(path);
    if (!e) return;
    e.clearedAt = clearedAt;
    this.#persist();
  }

  /** All log entries, oldest first (for a drill-down view). */
  all() {
    return [...this.entries];
  }
}
