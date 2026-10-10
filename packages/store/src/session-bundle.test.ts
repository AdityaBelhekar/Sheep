import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { domainEvent } from '@sheep/core';
import { CLAIM_ID, EXECUTION_ID, SESSION_ID } from '@sheep/core/fixtures';
import { ArchiveError, unzip, zip, type ArchiveFile } from './archive';
import { hashPayload } from './events/hash';
import { recordExecution } from './executions';
import { readLedger } from './ledger';
import { listArtifacts } from './projections/artifacts';
import { listExecutions } from './projections/executions';
import { getSession, listSessions } from './projections/sessions';
import { recordFigures } from './artifacts';
import { exportSession, importSession, SessionBundleError, sessionBlobRef } from './session-bundle';
import { openSheepStore, type SheepStore } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';

const tempDir = useTempDir('sheep-bundle-');
const LIMITS = { maxEntries: 1_000, maxBytes: 10_000_000 };
const CODE = 'plt.plot(losses)';

/** A session with a run that drew a figure, a claim resting on the run, and a second session beside it. */
async function seeded(dir: string, driver: (typeof TESTABLE_DRIVERS)[number]): Promise<SheepStore> {
  const store = openSheepStore({ dataDir: dir, driver });
  store.record([
    domainEvent('session.created', {
      sessionId: SESSION_ID,
      title: 'Sparse attention',
      question: 'Does block-sparse attention preserve perplexity?',
    }),
    domainEvent('session.created', {
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Another session entirely',
      question: 'Is it left where it is?',
    }),
  ]);

  const workDir = join(dir, 'work');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'loss.svg'), '<svg>loss</svg>');
  const execution = await recordExecution(store, SESSION_ID, CODE, {
    executionId: EXECUTION_ID,
    status: 'ok',
    exitCode: 0,
    durationMs: 12,
    stdout: 'delta 0.31\n',
    stderr: '',
    truncated: false,
    seed: 7,
    envLockHash: 'a'.repeat(64),
    limits: { memoryMb: 1024, cpuPercent: 50, timeoutMs: 60_000 },
    peakMemoryBytes: null,
    artifacts: [{ path: 'loss.svg' }],
    workDir,
  });
  recordFigures(store, execution);
  store.record([
    domainEvent('claim.recorded', {
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      claimType: 'EMPIRICAL',
      statement: 'The perplexity delta is 0.31.',
      support: [{ kind: 'EXECUTION', ref: EXECUTION_ID }],
    }),
  ]);
  return store;
}

/** The files of a bundle, to be altered and packed again. */
const unpack = (bundle: Uint8Array): ArchiveFile[] =>
  [...unzip(bundle, LIMITS)].map(([path, data]) => ({ path, data }));

const edited = (bundle: Uint8Array, path: string, change: (text: string) => string): Uint8Array =>
  zip(
    unpack(bundle).map((file) =>
      file.path === path
        ? { path, data: change(Buffer.from(file.data as Uint8Array).toString('utf8')) }
        : file,
    ),
  );

describe('archives from outside', () => {
  it('round-trips files, names and all', () => {
    const files = [
      { path: 'manifest.json', data: '{"a":1}' },
      { path: 'blobs/ünïcode', data: Buffer.from([0, 1, 2, 255]) },
      { path: 'empty', data: '' },
    ];
    const read = unzip(zip(files), LIMITS);
    expect([...read.keys()]).toEqual(['manifest.json', 'blobs/ünïcode', 'empty']);
    expect(Buffer.from(read.get('blobs/ünïcode')!)).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(read.get('empty')).toHaveLength(0);
  });

  it.each(['../escape.txt', 'a/../../b', '/absolute', 'C:\\windows\\x', 'back\\slash'])(
    'refuses the path %j',
    (path) => {
      expect(() => unzip(zip([{ path, data: 'x' }]), LIMITS)).toThrow(ArchiveError);
    },
  );

  it('stops at the limits it was given, not at the machine’s memory', () => {
    const bomb = zip([{ path: 'zeros', data: Buffer.alloc(5_000_000) }]);
    // Five megabytes of zeros is a few kilobytes on disk.
    expect(bomb.byteLength).toBeLessThan(10_000);
    expect(() => unzip(bomb, { maxEntries: 10, maxBytes: 1_000_000 })).toThrow(
      /unpacks to more than/,
    );
    expect(() =>
      unzip(
        zip([
          { path: 'a', data: '' },
          { path: 'b', data: '' },
        ]),
        { maxEntries: 1, maxBytes: 10 },
      ),
    ).toThrow(/holds 2 entries/);
  });

  it('refuses an entry that is not what its header states, and anything that is not an archive', () => {
    const archive = Buffer.from(zip([{ path: 'a.txt', data: 'hello hello hello hello' }]));
    // The stated size is lowered: the entry would unpack to more than it claims.
    const lied = Buffer.from(archive);
    const central = lied.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lied.writeUInt32LE(3, central + 24);
    expect(() => unzip(lied, LIMITS)).toThrow(/does not unpack to what its header states/);

    const corrupt = Buffer.from(archive);
    corrupt[35] = corrupt[35]! ^ 0xff;
    expect(() => unzip(corrupt, LIMITS)).toThrow(ArchiveError);
    expect(() => unzip(Buffer.from('not a zip at all'), LIMITS)).toThrow(/not a ZIP archive/);
    expect(() =>
      unzip(
        zip([
          { path: 'a', data: '1' },
          { path: 'a', data: '2' },
        ]),
        LIMITS,
      ),
    ).toThrow(/twice/);
  });
});

describe.each(TESTABLE_DRIVERS)('session bundles on %s', (driver) => {
  it('carries a session to another store, where it is the same session', async () => {
    const source = await seeded(join(tempDir(), 'a'), driver);
    const target = openSheepStore({ dataDir: join(tempDir(), 'b'), driver });
    try {
      const bundle = exportSession(source, SESSION_ID);
      const imported = importSession(target, bundle);

      expect(imported).toMatchObject({ sessionId: SESSION_ID, title: 'Sparse attention' });
      // Only the one session travelled.
      expect(listSessions(target.db).map((session) => session.title)).toEqual(['Sparse attention']);
      expect(getSession(target.db, SESSION_ID)).toEqual(getSession(source.db, SESSION_ID));

      // The records are the same records, and the times are when things happened, not when they arrived.
      expect(listExecutions(target.db, SESSION_ID)).toEqual(listExecutions(source.db, SESSION_ID));
      expect(listArtifacts(target.db, SESSION_ID)).toEqual(listArtifacts(source.db, SESSION_ID));
      expect(readLedger(target.events, SESSION_ID).claims()).toEqual(
        readLedger(source.events, SESSION_ID).claims(),
      );
      expect(readLedger(target.events, SESSION_ID).rejected).toEqual([]);

      // Every blob the session names came with it, and is held against collection.
      const [execution] = listExecutions(target.db, SESSION_ID);
      expect(target.blobs.readText(execution!.codeHash)).toBe(CODE);
      expect(target.blobs.readText(execution!.stdoutHash)).toBe('delta 0.31\n');
      expect(target.blobs.readText(execution!.artifacts[0]!.hash)).toBe('<svg>loss</svg>');
      expect(target.blobs.gc().removed).toEqual([]);
      expect(target.blobs.heldBy(sessionBlobRef(SESSION_ID)).length).toBe(imported.blobs);

      // A new chain, intact: the entries are chained to the log they were appended to.
      expect(target.events.verify().ok).toBe(true);
      expect(target.events.head()!.entryHash).not.toBe(source.events.head()!.entryHash);
    } finally {
      source.close();
      target.close();
    }
  });

  it('writes the same bundle for the same session, and imports it only once', async () => {
    const source = await seeded(join(tempDir(), 'a'), driver);
    const target = openSheepStore({ dataDir: join(tempDir(), 'b'), driver });
    try {
      const bundle = exportSession(source, SESSION_ID);
      expect(Buffer.from(exportSession(source, SESSION_ID)).equals(Buffer.from(bundle))).toBe(true);

      importSession(target, bundle);
      const before = target.events.count();
      expect(() => importSession(target, bundle)).toThrow(/already here/);
      expect(() => importSession(source, bundle)).toThrow(/already here/);
      expect(target.events.count()).toBe(before);
      expect(() => exportSession(source, CLAIM_ID)).toThrow(/unknown session/);
    } finally {
      source.close();
      target.close();
    }
  });

  it('believes nothing a bundle says about itself', async () => {
    const source = await seeded(join(tempDir(), 'a'), driver);
    const target = openSheepStore({ dataDir: join(tempDir(), 'b'), driver });
    const refused = (bundle: Uint8Array, why: RegExp): void => {
      expect(() => importSession(target, bundle)).toThrow(SessionBundleError);
      expect(() => importSession(target, bundle)).toThrow(why);
      // Nothing of it stayed: no session, no event, no blob held.
      expect(listSessions(target.db)).toEqual([]);
      expect(target.blobs.heldBy(sessionBlobRef(SESSION_ID))).toEqual([]);
    };
    try {
      const bundle = exportSession(source, SESSION_ID);

      // A claim reworded after the fact no longer matches its hash.
      refused(
        edited(bundle, 'events.jsonl', (text) => text.replace('delta is 0.31', 'delta is 0.01')),
        /event \d+ is not what its hash says it is/,
      );
      // Reworded and rehashed, it is a valid event — and still has to pass the ledger: an
      // EMPIRICAL claim pointing at a run the bundle does not contain.
      const forged = edited(bundle, 'events.jsonl', (text) =>
        text
          .split('\n')
          .filter((line) => line !== '' && !line.includes('"execution.recorded"'))
          .filter((line) => !line.includes('"artifact.recorded"'))
          .join('\n'),
      );
      refused(
        edited(forged, 'manifest.json', (text) => text.replace('"events": 4', '"events": 2')),
        /LEDGER_UNKNOWN_EXECUTION/,
      );

      // An event for some other session, correctly hashed.
      const other = { sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Hijacked' };
      refused(
        edited(bundle, 'events.jsonl', (text) => {
          const lines = text.trimEnd().split('\n');
          lines[lines.length - 1] = JSON.stringify({
            eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
            type: 'session.retitled',
            payload: other,
            recordedAt: '2026-01-01T00:00:00.000Z',
            payloadHash: hashPayload(other),
          });
          return `${lines.join('\n')}\n`;
        }),
        /belongs to a different session/,
      );

      // A blob that is not what its name says.
      const [blob] = unpack(bundle).filter((file) => file.path.startsWith('blobs/'));
      refused(
        zip(
          unpack(bundle)
            .map((file) => (file === blob ? file : file))
            .map((file) =>
              file.path === blob!.path ? { path: file.path, data: 'swapped' } : file,
            ),
        ),
        /is not what its name says it is/,
      );
      // An extra file, a missing one, and something that is not a bundle at all.
      refused(
        zip([...unpack(bundle), { path: 'autorun.inf', data: 'x' }]),
        /files a session bundle does not have/,
      );
      refused(zip(unpack(bundle).filter((file) => file.path !== blob!.path)), /is missing blob/);
      refused(zip([{ path: 'readme.txt', data: 'hello' }]), /no manifest\.json/);
      refused(Buffer.from('plain text'), /not a ZIP archive/);
    } finally {
      source.close();
      target.close();
    }
  });
});
