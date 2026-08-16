import { describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations/runner';
import { openDatabase } from '../sqlite/open';
import type { SqliteDatabase } from '../sqlite/types';
import { TESTABLE_DRIVERS } from '../test-support';
import { GENESIS_HASH, hashPayload } from './hash';
import { EventLog, EventLogError } from './log';

function freshDb(driver: (typeof TESTABLE_DRIVERS)[number]): SqliteDatabase {
  const { db } = openDatabase({ path: ':memory:', driver });
  runMigrations(db);
  return db;
}

/** Deterministic ids and clock, so hashes are reproducible across runs. */
function deterministicLog(db: SqliteDatabase, batchSize = 500): EventLog {
  let n = 0;
  return new EventLog(db, {
    batchSize,
    newId: () => {
      n += 1;
      return `event-${String(n).padStart(4, '0')}`;
    },
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
  });
}

describe.each(TESTABLE_DRIVERS)('EventLog on %s', (driver) => {
  it('starts empty', () => {
    const db = freshDb(driver);
    try {
      const log = deterministicLog(db);
      expect(log.count()).toBe(0);
      expect(log.head()).toBeUndefined();
      expect(log.read()).toEqual([]);
      expect(log.verify()).toEqual({ ok: true, checked: 0, failures: [] });
    } finally {
      db.close();
    }
  });

  it('anchors the first entry to the genesis hash', () => {
    const db = freshDb(driver);
    try {
      const log = deterministicLog(db);
      const record = log.append({ type: 'app.started', payload: { version: '0.0.0' } });

      expect(record.seq).toBe(1);
      expect(record.prevHash).toBe(GENESIS_HASH);
      expect(record.payloadHash).toBe(hashPayload({ version: '0.0.0' }));
      expect(record.entryHash).toMatch(/^[0-9a-f]{64}$/);
      expect(log.head()).toEqual({ seq: 1, entryHash: record.entryHash });
    } finally {
      db.close();
    }
  });

  it('links each entry to the one before it', () => {
    const db = freshDb(driver);
    try {
      const log = deterministicLog(db);
      const first = log.append({ type: 'a', payload: { i: 1 } });
      const second = log.append({ type: 'b', payload: { i: 2 } });
      const third = log.append({ type: 'c', payload: { i: 3 } });

      expect(second.prevHash).toBe(first.entryHash);
      expect(third.prevHash).toBe(second.entryHash);
      expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
      expect(log.verify().ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it('round-trips payloads, ids, sessions and timestamps', () => {
    const db = freshDb(driver);
    try {
      const log = deterministicLog(db);
      const payload = { nested: { list: [1, 'two', null, true] }, n: 3.5 };
      log.append({ type: 'session.opened', payload, sessionId: 's-1' });

      const [stored] = log.read();
      expect(stored).toMatchObject({
        seq: 1,
        eventId: 'event-0001',
        sessionId: 's-1',
        type: 'session.opened',
        payload,
        recordedAt: '2026-01-01T00:00:01.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('appends a batch atomically', () => {
    const db = freshDb(driver);
    try {
      const log = deterministicLog(db);
      log.append({ type: 'first', payload: {} });

      expect(() =>
        log.appendAll([
          { type: 'good', payload: { ok: true } },
          { type: '   ', payload: {} },
        ]),
      ).toThrow(EventLogError);

      expect(log.count()).toBe(1);
      expect(log.verify().ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it('rejects a duplicate event id rather than forking the chain', () => {
    const db = freshDb(driver);
    try {
      const log = deterministicLog(db);
      log.append({ type: 'a', payload: {}, eventId: 'fixed' });

      expect(() => log.append({ type: 'b', payload: {}, eventId: 'fixed' })).toThrow();
      expect(log.count()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('filters reads by session, type and range', () => {
    const db = freshDb(driver);
    try {
      const log = deterministicLog(db);
      log.appendAll([
        { type: 'a', payload: { i: 1 }, sessionId: 's-1' },
        { type: 'b', payload: { i: 2 }, sessionId: 's-2' },
        { type: 'a', payload: { i: 3 }, sessionId: 's-1' },
        { type: 'a', payload: { i: 4 } },
      ]);

      expect(log.read({ sessionId: 's-1' }).map((r) => r.seq)).toEqual([1, 3]);
      expect(log.read({ sessionId: null }).map((r) => r.seq)).toEqual([4]);
      expect(log.read({ type: 'a' }).map((r) => r.seq)).toEqual([1, 3, 4]);
      expect(log.read({ fromSeq: 3 }).map((r) => r.seq)).toEqual([3, 4]);
      expect(log.read({ limit: 2 }).map((r) => r.seq)).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });

  it('streams the whole log in order across batch boundaries', () => {
    const db = freshDb(driver);
    try {
      const log = deterministicLog(db, 3);
      log.appendAll(Array.from({ length: 10 }, (_, i) => ({ type: 'tick', payload: { i } })));

      expect([...log.stream()].map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect([...log.stream({ fromSeq: 8 })].map((r) => r.seq)).toEqual([8, 9, 10]);
      expect([...log.stream({ limit: 4 })].map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    } finally {
      db.close();
    }
  });

  it('verifies a long chain', () => {
    const db = freshDb(driver);
    try {
      const log = deterministicLog(db, 7);
      log.appendAll(Array.from({ length: 50 }, (_, i) => ({ type: 'tick', payload: { i } })));

      const result = log.verify();
      expect(result.ok).toBe(true);
      expect(result.checked).toBe(50);
      expect(result.head?.seq).toBe(50);
      expect(result.failures).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe.each(TESTABLE_DRIVERS)('tamper detection on %s', (driver) => {
  function seeded(): { db: SqliteDatabase; log: EventLog } {
    const db = freshDb(driver);
    const log = deterministicLog(db);
    log.appendAll([
      { type: 'a', payload: { i: 1 } },
      { type: 'b', payload: { i: 2 } },
      { type: 'c', payload: { i: 3 } },
    ]);
    return { db, log };
  }

  it('catches an edited payload', () => {
    const { db, log } = seeded();
    try {
      db.run('UPDATE events SET payload = ? WHERE seq = ?', ['{"i":999}', 2]);

      const result = log.verify();
      expect(result.ok).toBe(false);
      expect(result.failures.map((f) => f.reason)).toContain('payload-hash');
      expect(result.failures[0]?.seq).toBe(2);
    } finally {
      db.close();
    }
  });

  it('catches an edited field that the entry hash covers', () => {
    const { db, log } = seeded();
    try {
      db.run('UPDATE events SET type = ? WHERE seq = ?', ['forged', 2]);

      const result = log.verify();
      expect(result.ok).toBe(false);
      expect(result.failures.map((f) => f.reason)).toContain('entry-hash');
    } finally {
      db.close();
    }
  });

  it('catches a payload edited together with its own hash', () => {
    const { db, log } = seeded();
    try {
      // A forger who recomputes payload_hash still cannot match entry_hash.
      const forged = '{"i":999}';
      db.run('UPDATE events SET payload = ?, payload_hash = ? WHERE seq = ?', [
        forged,
        hashPayload({ i: 999 }),
        2,
      ]);

      const result = log.verify();
      expect(result.ok).toBe(false);
      expect(result.failures.map((f) => f.reason)).toContain('entry-hash');
    } finally {
      db.close();
    }
  });

  it('catches a broken link', () => {
    const { db, log } = seeded();
    try {
      db.run('UPDATE events SET prev_hash = ? WHERE seq = ?', ['0'.repeat(64), 3]);

      const result = log.verify();
      expect(result.ok).toBe(false);
      expect(result.failures.map((f) => f.reason)).toEqual(
        expect.arrayContaining(['broken-link', 'entry-hash']),
      );
    } finally {
      db.close();
    }
  });

  it('catches a deleted entry', () => {
    const { db, log } = seeded();
    try {
      db.run('DELETE FROM events WHERE seq = ?', [2]);

      const result = log.verify();
      expect(result.ok).toBe(false);
      expect(result.failures.map((f) => f.reason)).toEqual(
        expect.arrayContaining(['sequence-gap', 'broken-link']),
      );
      expect(result.checked).toBe(2);
    } finally {
      db.close();
    }
  });

  it('catches a truncated tail, which the chain alone cannot see', () => {
    const { db, log } = seeded();
    try {
      const before = log.head();
      db.run('DELETE FROM events WHERE seq = ?', [3]);

      // Entries 1-2 still form a valid chain; only the anchored head reveals
      // that the log used to be longer.
      const result = log.verify();
      expect(result.ok).toBe(false);
      expect(result.failures.map((f) => f.reason)).toEqual(['head-mismatch']);
      expect(result.head?.entryHash).not.toBe(before?.entryHash);
      expect(log.anchor()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('catches a log emptied entirely', () => {
    const { db, log } = seeded();
    try {
      db.run('DELETE FROM events', []);

      const result = log.verify();
      expect(result.ok).toBe(false);
      expect(result.checked).toBe(0);
      expect(result.failures.map((f) => f.reason)).toEqual(['head-mismatch']);
    } finally {
      db.close();
    }
  });

  it('reports an unreadable payload instead of throwing', () => {
    const { db, log } = seeded();
    try {
      db.run('UPDATE events SET payload = ? WHERE seq = ?', ['{not json', 2]);

      const result = log.verify();
      expect(result.ok).toBe(false);
      expect(result.failures.map((f) => f.reason)).toEqual(
        expect.arrayContaining(['payload-hash', 'unreadable-payload']),
      );
    } finally {
      db.close();
    }
  });
});
