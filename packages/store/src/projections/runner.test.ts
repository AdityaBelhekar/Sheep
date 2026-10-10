import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainEventType } from '@sheep/core';
import { EVENT_FIXTURES, SESSION_ID } from '@sheep/core/fixtures';
import { describe, expect, it } from 'vitest';
import { EventLog } from '../events/log';
import { ARTIFACTS_PROJECTION } from './artifacts';
import { CORPUS_PROJECTION } from './corpus';
import { DERIVATIONS_PROJECTION } from './derivations';
import { EXECUTIONS_PROJECTION } from './executions';
import { RETRIEVALS_PROJECTION } from './retrievals';
import type { JsonValue } from '../events/json';
import { MIGRATIONS } from '../migrations/definitions';
import { runMigrations } from '../migrations/runner';
import { openDatabase } from '../sqlite/open';
import type { SqliteDatabase, SqliteDriverName, SqlRow } from '../sqlite/types';
import { TESTABLE_DRIVERS, useTempDir } from '../test-support';
import { ProjectionRunner } from './runner';
import { SESSIONS_PROJECTION, getSession, listMessages, listSessions } from './sessions';
import type { Projection, ProjectionReport } from './types';

const tempDir = useTempDir('sheep-projections-');

let counter = 0;

interface Harness {
  readonly db: SqliteDatabase;
  readonly log: EventLog;
  readonly runner: ProjectionRunner;
  /** Appends an event by fixture name, optionally with payload overrides. */
  emit(type: DomainEventType, overrides?: Record<string, unknown>): void;
  catchUp(): ProjectionReport;
  rebuild(): ProjectionReport;
  close(): void;
}

function harness(driver: SqliteDriverName, projections?: readonly Projection[]): Harness {
  counter += 1;
  const dir = join(tempDir(), `run-${String(counter)}`);
  mkdirSync(dir, { recursive: true });

  const opened = openDatabase({ path: join(dir, 'sheep.sqlite'), driver });
  runMigrations(opened.db, { migrations: MIGRATIONS });

  let clock = Date.parse('2026-08-17T09:00:00.000Z');
  const log = new EventLog(opened.db, {
    now: () => {
      clock += 1_000;
      return new Date(clock);
    },
  });
  const runner = new ProjectionRunner(opened.db, log, {
    ...(projections === undefined ? {} : { projections }),
  });

  return {
    db: opened.db,
    log,
    runner,
    emit(type, overrides) {
      const payload = { ...EVENT_FIXTURES[type], ...overrides } as unknown as JsonValue;
      log.append({ type, payload, sessionId: type === 'app.started' ? null : SESSION_ID });
    },
    catchUp() {
      return runner.catchUp(SESSIONS_PROJECTION);
    },
    rebuild() {
      return runner.rebuild(SESSIONS_PROJECTION);
    },
    close() {
      opened.db.close();
    },
  };
}

/** Everything in the projected tables, as plain rows, for comparison. */
function snapshot(db: SqliteDatabase): {
  sessions: SqlRow[];
  messages: SqlRow[];
  participants: SqlRow[];
} {
  return {
    sessions: db.all('SELECT * FROM sessions ORDER BY session_id'),
    messages: db.all('SELECT * FROM messages ORDER BY seq'),
    participants: db.all('SELECT * FROM participants ORDER BY seq'),
  };
}

/** A small but representative session: created, budgeted, run, spent, spoken. */
function buildSession(h: Harness): void {
  h.emit('app.started');
  h.emit('session.created');
  h.emit('session.budget-set');
  h.emit('session.status-changed');
  h.emit('roster.model-attached');
  h.emit('message.recorded');
  h.emit('session.spend-recorded');
  h.emit('session.retitled');
  h.emit('dispute.opened');
}

describe.each(TESTABLE_DRIVERS)('projections on %s', (driver) => {
  it('creates its tables and records a watermark on first use', () => {
    const h = harness(driver);
    try {
      const [result] = h.runner.ensure();

      expect(result?.created).toBe(true);
      expect(result?.rebuilt).toBe(true);
      expect(h.runner.status()).toEqual([
        {
          name: 'sessions',
          lastSeq: 0,
          ddlVersion: SESSIONS_PROJECTION.ddlVersion,
          behind: 0,
          ready: true,
        },
        {
          name: 'executions',
          lastSeq: 0,
          ddlVersion: EXECUTIONS_PROJECTION.ddlVersion,
          behind: 0,
          ready: true,
        },
        {
          name: 'derivations',
          lastSeq: 0,
          ddlVersion: DERIVATIONS_PROJECTION.ddlVersion,
          behind: 0,
          ready: true,
        },
        {
          name: 'artifacts',
          lastSeq: 0,
          ddlVersion: ARTIFACTS_PROJECTION.ddlVersion,
          behind: 0,
          ready: true,
        },
        {
          name: 'retrievals',
          lastSeq: 0,
          ddlVersion: RETRIEVALS_PROJECTION.ddlVersion,
          behind: 0,
          ready: true,
        },
        {
          name: 'corpus',
          lastSeq: 0,
          ddlVersion: CORPUS_PROJECTION.ddlVersion,
          behind: 0,
          ready: true,
        },
      ]);
      expect(listSessions(h.db)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('folds events into rows and ignores the ones it does not model', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      buildSession(h);
      const report = h.catchUp();

      expect(report.applied).toBe(7);
      // app.started and dispute.opened are not this projection's business, and
      // are counted rather than silently dropped.
      expect(report.ignored).toBe(2);
      expect(report.unknown).toBe(0);
      expect(report.failures).toEqual([]);
      expect(report.lastSeq).toBe(9);

      const session = getSession(h.db, SESSION_ID);
      expect(session).toMatchObject({
        sessionId: SESSION_ID,
        title: EVENT_FIXTURES['session.retitled'].title,
        question: EVENT_FIXTURES['session.created'].question,
        status: 'running',
        messageCount: 1,
      });
      expect(session?.budget).toEqual({ capUsd: 25, spentUsd: 0.0412 });
    } finally {
      h.close();
    }
  });

  it('projects a message with its full provenance', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('session.created');
      h.emit('message.recorded');
      h.catchUp();

      const [message] = listMessages(h.db, SESSION_ID);
      const fixture = EVENT_FIXTURES['message.recorded'];

      expect(message).toEqual({
        messageId: fixture.messageId,
        sessionId: SESSION_ID,
        phaseId: fixture.phaseId,
        roundId: fixture.roundId,
        author: fixture.author,
        role: fixture.role,
        body: fixture.body,
        usage: fixture.usage,
        finish: fixture.finish,
        params: fixture.params,
        promptHash: fixture.promptHash,
        recordedAt: '2026-08-17T09:00:02.000Z',
      });
    } finally {
      h.close();
    }
  });

  it('projects a blob-backed body and a non-model author', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('session.created');
      h.emit('message.recorded', {
        messageId: '0000000f-0000-4000-8000-00000000000f',
        author: { kind: 'HUMAN' },
        role: undefined,
        body: { kind: 'blob', hash: 'd'.repeat(64), bytes: 8_192, mediaType: 'text/markdown' },
        usage: undefined,
        params: undefined,
        promptHash: undefined,
      });
      h.catchUp();

      const [message] = listMessages(h.db, SESSION_ID);
      expect(message?.author).toEqual({ kind: 'HUMAN' });
      expect(message?.role).toBeNull();
      expect(message?.usage).toBeNull();
      expect(message?.promptHash).toBeNull();
      expect(message?.params).toBeNull();
      expect(message?.body).toEqual({
        kind: 'blob',
        hash: 'd'.repeat(64),
        bytes: 8_192,
        mediaType: 'text/markdown',
      });
    } finally {
      h.close();
    }
  });

  it('catches up incrementally, touching only what is new', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('session.created');

      const first = h.catchUp();
      expect(first).toMatchObject({ fromSeq: 1, lastSeq: 1, applied: 1 });

      // Nothing appended: nothing to do, and the watermark holds.
      const idle = h.catchUp();
      expect(idle).toMatchObject({ fromSeq: 2, lastSeq: 1, applied: 0, ignored: 0 });

      h.emit('message.recorded');
      const second = h.catchUp();
      expect(second).toMatchObject({ fromSeq: 2, lastSeq: 2, applied: 1 });
      expect(getSession(h.db, SESSION_ID)?.messageCount).toBe(1);
    } finally {
      h.close();
    }
  });

  it('reproduces identical state after its tables are dropped and replayed', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      buildSession(h);
      h.emit('message.recorded', { messageId: '0000000a-0000-4000-8000-00000000000a' });
      h.emit('session.spend-recorded', { costUsd: 1.25 });
      h.catchUp();

      const before = snapshot(h.db);
      expect(before.sessions).toHaveLength(1);
      expect(before.messages).toHaveLength(2);

      // The tables are gone entirely — not emptied, dropped.
      h.runner.drop(SESSIONS_PROJECTION);
      expect(() => h.db.all('SELECT * FROM sessions')).toThrow();
      expect(h.runner.status()[0]).toMatchObject({ lastSeq: 0, ready: false });

      const [restored] = h.runner.ensure();
      expect(restored).toMatchObject({ created: true, rebuilt: true });
      expect(snapshot(h.db)).toEqual(before);
    } finally {
      h.close();
    }
  });

  it('rebuilds to the same state as an incremental catch-up', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      buildSession(h);

      // Catch up after every single append: the incremental path, exercised hard.
      for (let i = 0; i < 9; i += 1) h.catchUp();
      const incremental = snapshot(h.db);

      const report = h.rebuild();
      expect(report.rebuilt).toBe(true);
      expect(report.fromSeq).toBe(1);
      expect(snapshot(h.db)).toEqual(incremental);
    } finally {
      h.close();
    }
  });

  it('does not double-count accumulating values when rebuilt repeatedly', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('session.created');
      h.emit('session.spend-recorded', { costUsd: 2 });
      h.emit('session.spend-recorded', { costUsd: 3 });
      h.catchUp();

      expect(getSession(h.db, SESSION_ID)?.budget.spentUsd).toBe(5);
      h.rebuild();
      expect(getSession(h.db, SESSION_ID)?.budget.spentUsd).toBe(5);
      h.rebuild();
      h.rebuild();
      expect(getSession(h.db, SESSION_ID)?.budget.spentUsd).toBe(5);
    } finally {
      h.close();
    }
  });

  it('leaves message cost out of the session counter, so spend has one source', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('session.created');
      // A message carrying usage, with no matching spend event.
      h.emit('message.recorded');
      h.catchUp();

      expect(getSession(h.db, SESSION_ID)?.budget.spentUsd).toBe(0);
      expect(listMessages(h.db, SESSION_ID)[0]?.usage?.costUsd).toBe(0.0412);
    } finally {
      h.close();
    }
  });

  it('rebuilds when the projection shape changes, without a migration', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('session.created');
      h.catchUp();
      expect(h.runner.status()[0]?.lastSeq).toBe(1);

      // A later build ships a new column under a new version number.
      const reshaped: Projection = {
        ...SESSIONS_PROJECTION,
        ddl: SESSIONS_PROJECTION.ddl.replace(
          'participant_count INTEGER NOT NULL,',
          'participant_count INTEGER NOT NULL, added_later TEXT,',
        ),
        ddlVersion: SESSIONS_PROJECTION.ddlVersion + 1,
      };
      const later = new ProjectionRunner(h.db, h.log, { projections: [reshaped] });

      const [result] = later.ensure();
      expect(result).toMatchObject({ created: false, rebuilt: true });
      expect(later.status()).toEqual([
        {
          name: 'sessions',
          lastSeq: 1,
          ddlVersion: SESSIONS_PROJECTION.ddlVersion + 1,
          behind: 0,
          ready: true,
        },
      ]);
      expect(getSession(h.db, SESSION_ID)).toBeDefined();
      // The table has the new shape, not the old one emptied and refilled.
      expect(
        h.db.all<{ name: string }>('PRAGMA table_info(sessions)').map((column) => column.name),
      ).toContain('added_later');
    } finally {
      h.close();
    }
  });

  it('reports how far behind the log it is', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('session.created');
      h.emit('message.recorded');
      expect(h.runner.status()[0]?.behind).toBe(2);

      h.catchUp();
      expect(h.runner.status()[0]?.behind).toBe(0);
    } finally {
      h.close();
    }
  });

  it('replays a fresh database from an imported log alone', () => {
    const source = harness(driver);
    const target = harness(driver);
    try {
      source.runner.ensure();
      buildSession(source);
      source.catchUp();

      // Copy only the events — nothing derived — into a second database.
      const targetLog = new EventLog(target.db);
      for (const record of source.log.stream()) {
        targetLog.append({
          type: record.type,
          payload: record.payload,
          sessionId: record.sessionId,
          eventId: record.eventId,
          recordedAt: record.recordedAt,
        });
      }
      target.runner.ensure();

      expect(snapshot(target.db)).toEqual(snapshot(source.db));
    } finally {
      source.close();
      target.close();
    }
  });
});

describe.each(TESTABLE_DRIVERS)('projection robustness on %s', (driver) => {
  it('counts an event type it has never heard of and keeps going', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('session.created');
      // What opening a log written by a newer build looks like.
      h.log.append({ type: 'quantum.entangled', payload: { spooky: true }, sessionId: SESSION_ID });
      h.emit('session.retitled');

      const report = h.catchUp();
      expect(report.unknown).toBe(1);
      expect(report.applied).toBe(2);
      expect(report.failures).toEqual([]);
      expect(report.lastSeq).toBe(3);
      expect(getSession(h.db, SESSION_ID)?.title).toBe(EVENT_FIXTURES['session.retitled'].title);
    } finally {
      h.close();
    }
  });

  it('reports a malformed payload instead of refusing to project anything', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('session.created');
      h.log.append({
        type: 'session.retitled',
        payload: { sessionId: SESSION_ID, title: '' },
        sessionId: SESSION_ID,
      });
      h.emit('session.status-changed');

      const report = h.catchUp();
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0]).toMatchObject({ seq: 2, type: 'session.retitled' });
      expect(report.failures[0]?.detail).toContain('title');
      expect(report.applied).toBe(2);

      // The events either side of the bad one still landed.
      expect(getSession(h.db, SESSION_ID)?.status).toBe('running');
      expect(getSession(h.db, SESSION_ID)?.title).toBe(EVENT_FIXTURES['session.created'].title);
    } finally {
      h.close();
    }
  });

  it('advances its watermark past events it skipped, so it never re-reads them', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('app.started');
      h.emit('app.started');
      const report = h.catchUp();

      expect(report.applied).toBe(0);
      expect(report.ignored).toBe(2);
      expect(report.lastSeq).toBe(2);
      expect(h.catchUp()).toMatchObject({ fromSeq: 3, ignored: 0 });
    } finally {
      h.close();
    }
  });

  it('projects nothing at all for an empty log', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      const report = h.catchUp();
      expect(report).toMatchObject({ fromSeq: 1, lastSeq: 0, applied: 0 });
      expect(listSessions(h.db)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('refuses to hand a projection an event it declared it does not handle', () => {
    const h = harness(driver);
    try {
      h.runner.ensure();
      h.emit('app.started');
      expect(() => {
        SESSIONS_PROJECTION.apply(
          h.db,
          { type: 'app.started', payload: EVENT_FIXTURES['app.started'] },
          h.log.read()[0]!,
        );
      }).toThrow(/does not handle/);
    } finally {
      h.close();
    }
  });
});
