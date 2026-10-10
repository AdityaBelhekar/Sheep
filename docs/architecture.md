# Sheep architecture

This document says how Sheep is put together and why. It is for someone about
to change the code. The [roadmap](../ROADMAP.md) says what was built in what
order; this says what it adds up to.

## The shape

```
RENDERER (React, sandboxed)  ──typed IPC──>  MAIN (thin)
                                               │ MessagePort
                                    ORCHESTRATOR (utilityProcess)
                                    protocol · roles · budget
                                               │
     ┌───────────┬───────────┬─────────────────┼───────────┬───────────┐
  GATEWAY      STORE      SANDBOX           VERIFY     ARTIFACTS    RETRIEVAL
  adapters   SQLite+CAS  CPython 3.12    SymPy/pint/Z3  dot/TeX    arXiv/S2/Crossref
                                                            │
                                                          PAPER
```

Three processes. The **renderer** draws and asks; it has no Node access, no
file system and no network of its own. **Main** owns the database, the
credential store, the sandbox and the windows, and answers the renderer over a
typed bridge. The **orchestrator** runs the protocol in a utility process, and
reaches everything through main.

## The seven invariants

Every design decision below serves one of these.

| | Invariant | Where it is enforced |
|---|---|---|
| P1 | **Attribution is physical.** A critic is a different vendor's model. | The role solver, `packages/orchestrator/src/roles.ts` |
| P2 | **Claims are typed.** | The ledger, `packages/core/src/ledger.ts` |
| P3 | **Independent before collective.** | The blind runner, `packages/orchestrator/src/blind.ts` |
| P4 | **Verification is not a model.** | Test routing, `packages/orchestrator/src/routing.ts` |
| P5 | **Reproducibility is a build artifact.** | The event log; deterministic sandbox and renderers |
| P6 | **Disagreement is output.** | Resolution, `packages/orchestrator/src/resolution.ts`; the paper's Open Questions |
| P7 | **Local-first.** | There is no server to enforce it against |

## The event log is the only source of truth

Everything that happens is appended to one table as an event: a session
created, a model attached, a turn recorded, a run finished, a claim made. Each
entry carries the SHA-256 of its payload and of the entry before it, so the
log is a hash chain, verified on every launch.

Every other table is a **projection**: derived from the log by replaying it,
and disposable. A projection owns its own DDL. Changing its shape is a version
bump and a replay, not a migration — which is why `packages/store/src/projections`
has eight of them and the migration list is short.

Three conventions make replay trustworthy:

- **Payloads carry no timestamps.** The log's `recordedAt` is when an event
  happened.
- **Payloads are self-contained.** A session-scoped payload names its session.
- **Payloads are strict.** An unknown key is rejected at the boundary, before
  it is hashed into a chain where it could never be corrected.

Large things — code, output, figures, a provider's raw response — are not in
the log. They are in a **content-addressed store** (`objects/<ab>/<sha256>`),
and the log names them by hash. Reference counts in SQLite say which record
holds which blob; garbage collection removes only what nothing holds.

## The ledger

The ledger (`packages/core`, pure, no I/O) is the rule set claims are held to.
It is replayed from the log, and every write is checked against it *before* it
is appended, so a claim that breaks a rule is never recorded.

- An `EMPIRICAL` claim must point at a run that exited 0.
- A `DERIVED` claim must point at a derivation with no failing step.
- A `CITED` claim must point at a source a search returned, and can never be
  marked supported.
- A claim becomes disputed, refuted or unresolved only through a dispute.
- A resolution may not contradict the result of the dispute's own test.

This is the structural defence the rest of the system leans on. Whatever a
model says — including after reading a hostile abstract — becomes a claim only
by passing these checks.

## The protocol

`packages/orchestrator` is a state machine over the log: phases, rounds,
turns. It holds no state between steps. Each step re-reads the log, decides
the one next thing to do, does it, and records it. That is what makes two
things cheap:

- **Resume.** A crashed session restarts by reading the log; there is no
  separate recovery path.
- **Replay.** Every model call is keyed by a hash of its request. A turn
  already in the log is not asked again, so a recorded session replays through
  the real engine at no cost.

The orchestrator reaches the world through a handful of **ports**
(`ports.ts`): read a snapshot, record events, ask a model, run a script, hand
something to a checker. In the app, main implements them. In tests, an array
and a script do. The engine cannot tell the difference.

## The model gateway

`packages/gateway` puts every provider behind one adapter interface and wraps
each adapter in a resilience layer (rate limiting, backoff, a circuit breaker)
and a budget governor (per-model pricing, hard caps). Every request and
response is recorded to the content-addressed store.

## The sandbox

`packages/sandbox` runs Python in a pinned CPython, confined in layers that do
not trust each other: a Windows Job Object (memory, CPU, process count,
kill-on-close), a wall clock, a low integrity level, an audit hook that
refuses reads outside the jail and any non-loopback socket, a bandwidth cap,
and an environment built from nothing.

It is deterministic by construction: a fixed hash seed, every random generator
seeded, a fixed build date. The same script and seed give the same bytes.

It contains runaway code. It is **not** a boundary against code written to
escape it; `guard.py` says so and the roadmap lists a stricter mode as
deferred work.

## Artifacts and the paper

`packages/artifacts` renders diagrams, formulas and TikZ with pinned tools
(Graphviz, Tectonic) and Mermaid in a hidden browser window. An artifact is a
*source* and what a named toolchain produced from it; the files can be deleted
and regenerated byte for byte.

`packages/paper` compiles a session into a paper in three steps: the ledger
becomes a document described as data (`ir.ts`), the document becomes LaTeX
with every character of model-written text escaped (`latex.ts`), and Tectonic
typesets it offline. The provenance rule — an asserting sentence must name a
ledger claim — is the first line of the only function that produces a PDF.

## Retrieval

`packages/retrieval` searches three literature APIs. Retrieved text is
untrusted: hidden characters are stripped, anything that reads as an
instruction is flagged, and when sources are shown to a model they sit inside
a fence whose boundary the source's author could not have known. Literature
enters a prompt in exactly one place, the engine's turn runner.

The vector index over a session (`packages/store/src/projections/corpus.ts`)
is hashed n-grams compared in TypeScript — lexical, exact, and with nothing to
download.

## The IPC bridge

`packages/ipc` holds one allowlist of channels and a zod contract for each.
Both sides validate: main rejects a bad request, the renderer rejects a bad
reply. A channel that is not on the list throws. The renderer never names a
file path; main shows the dialogs.

## Pinned everything

| What | Pinned by | Installed by |
|---|---|---|
| Python and its wheels | `packages/sandbox/runtime.lock.json` | `npm run fetch-runtime` |
| Graphviz, Tectonic, conference styles | `packages/artifacts/tools.lock.json` | `npm run fetch-tools` |
| TeX packages | The documents in `packages/artifacts/scripts/warm` | `npm run fetch-tools` |

Each install is stamped with the hash of the lock it came from. A runtime or
toolset whose stamp does not match the lock the build carries is refused,
because a run that records one environment and executes on another is not
reproducible — it only looks it.

## Package map

| Package | Depends on | Does |
|---|---|---|
| `core` | — | Domain types, event schemas, the ledger. Pure. |
| `store` | core | SQLite, the event log, projections, blobs, session bundles |
| `gateway` | core | Model adapters, resilience, cost |
| `ipc` | core | Channel allowlist and contracts |
| `sandbox` | — | The Python runner |
| `verify` | core, sandbox | SymPy, pint, Z3 and statistical checks |
| `retrieval` | core | Literature clients, quarantine |
| `orchestrator` | core, retrieval | The protocol |
| `artifacts` | — | Diagram, formula and TikZ rendering |
| `paper` | core, orchestrator, artifacts, store | The paper compiler |
| `apps/desktop` | all of them | Electron main, preload and renderer |

Workspace packages ship TypeScript source and are compiled into the app's
bundles by electron-vite; none is published.

## What is not done

- **macOS and Linux.** Packages are built by CI. The sandbox, the pinned
  Python and the pinned Graphviz exist for Windows x64 only, so the Lab,
  Verification and most of Artifacts report themselves unavailable there.
- **Signed builds.** Signing happens when a certificate is supplied to the
  build. Without one, builds are unsigned and never update themselves.
- **A strict sandbox, formal proof backends, and consumer-session adapters**
  are listed as deferred in the roadmap.
