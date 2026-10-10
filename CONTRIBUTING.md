# Contributing to Sheep

## Setting up

Node 22.12 or newer, on Windows x64.

```bash
npm install
```

```bash
npm run fetch-runtime
```

```bash
npm run fetch-tools
```

The last two download the pinned Python runtime (about 550 MB) and the pinned
rendering tools (about 130 MB). They fetch only what the lock files name and
verify every file's sha256. Tests that start an interpreter or a TeX engine
fail without them.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | The app, with hot reload |
| `npm test` | Every test |
| `npm run typecheck` | Type-checks every package |
| `npm run lint` | ESLint |
| `npm run format` | Prettier, writing |
| `npm run smoke` | Builds the app, launches it headless, and runs its launch checks |
| `npm run dist -- --dir` | Packages the app, unpacked, into `apps/desktop/dist` |
| `npm run smoke:packaged` | Runs the launch checks against that packaged app |
| `npm run dist` | Builds the installer |
| `npm run acceptance -- --dry-run` | Says what an acceptance run would do, without calling a model |

Before a change is done, these four pass:

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm test
```

```bash
npm run smoke
```

## The rules a change is held to

**The app launches at every commit.** `npm run smoke` is how that is checked.
It boots the real app, drives the real panes, and fails if any check is
missing — so a new surface gets a new check.

**Tests land with the code.** A checker ships with a corpus of things it must
catch. A renderer ships with a test that it produces the same bytes twice. A
rule in the ledger ships with the event that breaks it.

**A test proves the property, not the design.** "No model sees another's
answer" is tested by capturing every prompt and searching each for every other
model's answer — not by trusting the code that was meant to prevent it.

**Nothing external runs unpinned.** A new binary, wheel or TeX package goes in
a lock file with its hash, or in a warm-up document. Nothing is downloaded at
run time.

**The log is append-only and events are forever.** Adding an event type means
adding its schema, a fixture (the build fails without one) and whatever
projection reads it. Changing the meaning of an existing event is not a change
that can be made.

**Text from a model or from outside is data.** It is escaped before it reaches
LaTeX, rendered as characters before it reaches the DOM, and fenced before it
reaches another model.

**Commits are conventional.** `feat(scope):`, `fix(scope):`, `chore:`,
`test(scope):`, `docs:`. The message says what is now true and why, not what
was typed.

## Where things go

- A rule about what may be claimed → `packages/core/src/ledger.ts`
- A new event → `packages/core/src/events.ts`, then `fixtures.ts`
- A table derived from events → a projection in `packages/store/src/projections`
- A step of the protocol → `packages/orchestrator`
- Anything main does for the renderer → a channel in `packages/ipc`, a handler
  in `apps/desktop/src/main/ipc.ts`
- A new pane or panel → `apps/desktop/src/renderer/src/panes`, and a launch
  check in `apps/desktop/src/main/window.ts`

The [architecture document](./docs/architecture.md) explains the pieces.

## Adding a LaTeX package

Rendering runs offline. A package a figure or a paper needs has to be in the
TeX cache, which is filled by typesetting the documents in
`packages/artifacts/scripts/warm`.

- For figures: add it to `figures.tex`.
- For a paper template: change the template; then
  `SHEEP_UPDATE_WARM=1 npx vitest run packages/paper/src/warm.test.ts`
  rewrites that template's warm-up document.

Then run `npm run fetch-tools` to refill the cache.

## Releasing

```bash
npm run dist
```

The installer is written to `apps/desktop/dist`. Nothing is uploaded: a build
never publishes.

To sign, set `CSC_LINK` and `CSC_KEY_PASSWORD` (as electron-builder reads
them) before building. A signed build can update itself from GitHub releases;
an unsigned one never does. Publishing a release is done by hand, by attaching
the installer and the `latest.yml` beside it to a GitHub release.

CI (`.github/workflows/build.yml`) builds packages for Windows, macOS and
Linux on a tag. The macOS and Linux packages have never been run by anyone;
see "What is not done" in the architecture document.

## Reporting a problem

Open an issue with what you did, what you expected and what happened. If the
status bar says the chain is broken, include the log output — it names the
entries that failed.
