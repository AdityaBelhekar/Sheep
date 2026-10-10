<div align="center">
  <img src="./sheep.png" alt="Sheep logo" width="120" />

  # Sheep — Build Roadmap
</div>

A multi-model sandbox for genuine, original AI-driven research.
**75 phases. One phase per working session. One commit per phase.**

---

## How to use this file

This is the single source of truth for build progress. Every session:

1. Open this file, find the **first unchecked phase**.
2. Build only that phase — resist scope creep into the next one.
3. Run the phase's **Done when** check.
4. Tick the checkbox, commit with the given message.
5. Stop.

### Working rules

| Rule | Why |
|---|---|
| **One phase per session** | Keeps each session small enough to finish properly and keeps usage predictable. |
| **Commit at the end of every phase — never push** | Pushing is Aditya's call. Commits accumulate locally; push when you want the heatmap to fill. |
| **The app must launch at the end of every phase** | No phase may leave `main` broken. If a phase can't finish, commit the working subset and split the remainder into a new phase. |
| **Conventional commits** | `feat(scope):`, `fix(scope):`, `chore:`, `test(scope):`, `docs:` — clean history, easy changelog later. |
| **Tests land with the code, not after** | "I want perfection" means the verifier corpus and escape tests are part of their phase, not a cleanup phase at the end. |
| **Stage gates are hard gates** | At the end of each stage, everything in it must pass before the next stage starts. |

> **Heatmap note:** ~75 phases ≈ 3–4 months at one per weekday. Commits are made locally with real dates; push whenever you like — GitHub colours the graph by commit date, so the green fills in retroactively.

---

## Architecture at a glance

Enough context to execute any phase without another document.

```
RENDERER (React, sandboxed)  ──typed IPC──>  MAIN (thin)
                                               │ MessagePort
                                    ORCHESTRATOR (utilityProcess)
                                    Protocol SM │ Ledger │ Budget │ Role solver
                                               │
             ┌────────────┬────────────────────┼──────────────┐
          GATEWAY       STORE               SANDBOX         VERIFY
        adapters/cost  SQLite+CAS      CPython 3.12/Job Obj  SymPy/pint/Z3
```

**The seven invariants** every phase serves:

- **P1 Attribution is physical** — the critic is a *different vendor's model*, never the same model role-playing.
- **P2 Claims are typed** — `DERIVED` / `EMPIRICAL` / `CITED` / `CONJECTURE`; the ledger rejects an `EMPIRICAL` claim with no execution record.
- **P3 Independent before collective** — every phase opens blind-parallel; this is the anti-groupthink mechanism.
- **P4 Verification is not a model** — SymPy/Z3/execution check; LLM critique only *routes* to a checker.
- **P5 Reproducibility is a build artifact** — event log replays any session.
- **P6 Disagreement is output** — unresolved disputes ship in the paper as Open Questions.
- **P7 Local-first** — no server, no telemetry.

**Stack:** Electron + React + TypeScript, npm workspaces, electron-vite, SQLite (WAL) + content-addressed blobs, bundled CPython 3.12, Tectonic for LaTeX.

---

## Stage 0 — Foundation `Phases 1–5`

- [x] **1. Scaffold the monorepo**
  npm workspaces, `tsconfig` base + per-package, ESLint + Prettier, vitest, `.gitignore`, empty package skeletons per the layout.
  *Done when:* `npm install` succeeds and `npm test` runs green with zero tests.
  `chore: scaffold monorepo with typescript workspaces`

- [x] **2. Electron shell**
  electron-vite, `apps/desktop/{main,preload,renderer}`, React 19 + Vite, a window that opens with the Sheep logo.
  *Done when:* `npm run dev` opens a window; hot reload works.
  `feat(desktop): electron shell with react renderer`

- [x] **3. Typed IPC bridge**
  zod-validated channel contracts, allowlisted channel registry, `contextBridge` preload, `ping` round-trip.
  *Done when:* renderer calls `ipc.ping()` and gets a validated reply; an unregistered channel throws.
  `feat(ipc): typed zod-validated ipc bridge`

- [x] **4. SQLite + migrations**
  Driver selection (better-sqlite3, WASM fallback if native build fails), WAL mode, versioned migration runner, pre-migration backup.
  *Done when:* DB file is created at the user data path; migrations apply and are idempotent.
  `feat(store): sqlite with versioned migrations`

- [x] **5. Hash-chained event log**
  `events` table, append API, SHA-256 `payload_hash` + `prev_hash` chaining, sequential reader, chain-integrity verifier.
  *Done when:* unit tests prove append/read works and a tampered row fails verification.
  `feat(store): hash-chained append-only event log`

> **Stage gate:** app launches, writes events, replays them, verifies the chain.

---

## Stage 1 — Core domain & storage `Phases 6–10`

- [x] **6. Domain types** — `packages/core`: sessions, phases, rounds, messages, claims, disputes as zod schemas + inferred TS types. Pure, no I/O.
  *Done when:* every event type parses/round-trips in tests. → `feat(core): domain types and event schemas`

- [x] **7. Content-addressed store** — `.sheep/objects/<ab>/<sha256>`, put/get/has, streaming writes, reference counting, GC for unreferenced blobs.
  *Done when:* identical content dedupes; GC removes only unreferenced objects. → `feat(store): content-addressed blob store with gc`

- [x] **8. Projections** — rebuild `sessions`/`messages` tables purely by replaying events; incremental catch-up on append.
  *Done when:* dropping all projection tables and replaying reproduces identical state. → `feat(store): event replay projections`

- [x] **9. Keychain & settings** — keytar-backed credential storage, `credential_ref` indirection, app settings store, key redaction in logs.
  *Done when:* a secret saves to Windows Credential Manager; the DB contains only a reference; logs never leak it. → `feat(desktop): os keychain credentials and settings`

- [x] **10. App shell UI** — layout with the seven panes stubbed, routing, theme (light/dark), renderer reads a projection over IPC.
  *Done when:* every pane is navigable and one pane renders real DB data. → `feat(ui): application shell and navigation`

> **Stage gate:** data flows DB → projection → IPC → React, and secrets never touch SQLite.

---

## Stage 2 — Model gateway `Phases 11–17`

- [x] **11. Adapter interface** — `ModelAdapter`, `NormalizedRequest`, `Delta`, `ModelDescriptor`, `CostEstimate`, adapter registry, capability flags.
  *Done when:* a mock adapter streams deltas through the registry. → `feat(gateway): model adapter interface and registry`

- [x] **12. Anthropic adapter** — messages API, streaming, tool-calling normalisation, token accounting.
  *Done when:* a real key streams a completion; usage and cost are recorded. → `feat(gateway): anthropic adapter`

- [x] **13. OpenAI + OpenAI-compatible adapter** — the generic base-URL adapter covers Groq/Together/DeepSeek/OpenRouter/xAI/Azure in one implementation.
  *Done when:* one code path drives two different providers from config alone. → `feat(gateway): openai and openai-compatible adapters`

- [x] **14. Google: API key + OAuth** — Gemini via API key, plus real "Google login" (loopback redirect + PKCE, refresh token in keychain).
  *Done when:* signing in with Google yields a working Gemini connection with no key pasted. → `feat(gateway): google adapter with oauth pkce login`

- [x] **15. Local models** — Ollama, llama.cpp server, LM Studio; localhost autodetect; graceful absence (none are installed on this machine).
  *Done when:* Sheep detects a running Ollama, and shows a clean "not found" state when it isn't. → `feat(gateway): local model adapters with autodetect`

- [x] **16. Resilience layer** — per-provider token-bucket rate limiting, jittered exponential backoff, circuit breaker, full request/response recording to CAS by hash.
  *Done when:* a 429-injecting mock provider is survived without data loss and the exchange replays from CAS. → `feat(gateway): rate limiting, retry and circuit breaker`

- [x] **17. Cost accounting & budget governor** — per-model pricing table, pre-run estimate, live spend, hard caps with halt-and-resume.
  *Done when:* a session stops cleanly at its USD cap and resumes on confirmation. → `feat(gateway): cost accounting and budget governor`

> **Stage gate:** a cloud model, a local model, and a custom endpoint all stream, with spend tracked and capped.

---

## Stage 3 — Roster & first conversation `Phases 18–21`

- [x] **18. Connections UI** — add/edit/delete/test a connection per adapter category; keychain write; connection health badge.
  → `feat(ui): model connection management`
- [x] **19. Session roster** — attach models to a session, assign roles, set per-model budget and weight.
  → `feat(ui): per-session model roster`
- [x] **20. Single-model chat** — a plain streaming chat surface. Not a product feature; it proves the whole pipe end to end.
  → `feat(ui): single-model streaming chat surface`
- [x] **21. Streaming hardening** — ~30fps delta batching to the renderer, cancellation, partial-response persistence, error surfacing.
  → `feat(desktop): streaming backpressure and cancellation`

> **Stage gate:** six concurrent streams don't stutter the UI; cancel mid-stream loses nothing.

---

## Stage 4 — Orchestrator `Phases 22–29`

- [x] **22. Utility process host** — orchestrator in `utilityProcess`, JSON-RPC over MessagePort, lifecycle + restart, survives window close.
  → `feat(orchestrator): utility process host with json-rpc`
- [x] **23. Protocol state machine** — phases → rounds → turns, persisted transitions, every transition is an event.
  → `feat(orchestrator): protocol state machine`
- [x] **24. Role assignment solver** — PROPOSER/CRITIC/VERIFIER/REFEREE/DEVIL/SCRIBE with constraints: no self-critique, critic vendor ≠ author vendor, referee unstaked, rotation. **(P1)**
  *Done when:* property tests prove no assignment ever violates a hard constraint. → `feat(orchestrator): vendor-diverse role assignment solver`
- [x] **25. Blind-parallel runner** — isolated contexts per model, commit-then-reveal. **(P3)**
  *Done when:* a test proves no model's context contains another's output before reveal. → `feat(orchestrator): blind parallel phase runner`
- [x] **26. FRAMING phase** — independent problem statements → embedding-cluster + dedupe → Referee drafts Charter → **human approval gate**.
  → `feat(orchestrator): framing phase with charter human gate`
- [x] **27. HYPOTHESIS phase** — blind generation, clustering, blind scoring (testability × novelty × feasibility), user selects top-k.
  → `feat(orchestrator): hypothesis generation and ranking`
- [x] **28. Termination & loop detection** — convergence rules, round caps, budget stop, cosine-similarity loop breaker.
  → `feat(orchestrator): termination conditions and loop detection`
- [x] **29. Resume & golden-replay harness** — crash recovery from the event log, idempotent retry via request-hash dedupe, recorded provider fixtures for deterministic replay.
  *Done when:* killing the app mid-session and reopening resumes at the last committed turn; a fixture session replays identically with zero API spend. → `feat(orchestrator): crash-safe resume and golden replay tests`

> **Stage gate:** three models complete FRAMING + HYPOTHESIS; kill and resume works; replay costs nothing.

---

## Stage 5 — Claim ledger `Phases 30–35`

- [x] **30. Ledger schema & rules** — claims, evidence, disputes, resolutions as pure tested logic in `packages/core`.
  → `feat(core): claim ledger schema and rules`
- [x] **31. Ledger enforcement** — `EMPIRICAL` requires a valid `execution_id`; `DERIVED` requires a derivation record; `CITED` can support but never alone establish. **(P2)**
  *Done when:* each violation is rejected with a specific error, proven by tests. → `feat(core): claim type enforcement`
- [x] **32. Position locking** — pre-reveal `{stance, confidence}` commitments, hashed and stored; movement diffing.
  → `feat(orchestrator): position commitment and movement tracking`
- [x] **33. Calibration scoring** — Brier scores over resolved disputes; per-model reliability shown, never used to auto-decide.
  → `feat(core): per-model calibration scoring`
- [x] **34. Claim graph UI** — interactive DAG of claims/evidence/disputes, coloured by status.
  → `feat(ui): interactive claim graph`
- [x] **35. Provenance drawer** — click any claim: model, version, params, prompt hash, cost, timestamp, full ancestry.
  → `feat(ui): claim provenance drawer`

> **Stage gate:** an unbacked empirical claim is impossible to record, and every claim's full lineage is one click away.

---

## Stage 6 — Execution sandbox `Phases 36–42`

- [x] **36. Bundled Python runtime** — pinned CPython 3.12 (python-build-standalone) + locked wheels (numpy, scipy, sympy, pandas, matplotlib, scikit-learn, networkx), fetch script, lock hash. *Deliberately not system Python 3.14 — wheel availability is unreliable.*
  → `chore(sandbox): bundle pinned cpython 3.12 runtime`
- [x] **37. Runner protocol** — stdio JSON-RPC, live stdout/stderr streaming, structured result envelope.
  → `feat(sandbox): python runner with json-rpc protocol`
- [x] **38. Windows Job Object isolation** — memory cap, CPU rate cap, wall-clock timeout, kill-on-close, jailed working directory.
  → `feat(sandbox): job object resource isolation`
- [x] **39. Network denial** — cleared proxy env, `sitecustomize.py` refusing non-loopback sockets, optional per-child firewall rule.
  *Note:* defense-in-depth against runaway jobs, **not** a hard boundary against hostile code. → `feat(sandbox): layered network denial`
- [x] **40. Determinism** — `PYTHONHASHSEED`, explicit numpy seeding, Agg backend, `SOURCE_DATE_EPOCH`, env-lock hash recorded per run.
  *Done when:* the same script run twice produces byte-identical figures. → `feat(sandbox): deterministic execution environment`
- [x] **41. Execution records** — persist spec/code/env-lock/seed/exit/stdout/stderr, ingest artifacts into CAS, link to claims.
  → `feat(sandbox): execution records and artifact ingestion`
- [x] **42. Lab UI + escape suite** — Monaco editor, run controls, live output, plot viewer; **escape tests: network, filesystem escape, fork bomb, memory bomb, infinite loop must all fail closed.**
  → `feat(ui): lab surface with sandbox escape test suite`

> **Stage gate:** every escape test fails closed; results are hashed artifacts, not model assertions.

---

## Stage 7 — Verification `Phases 43–48`

- [x] **43. SymPy step checker** — derivations as ordered steps with declared operations; per-step entailment check. **(P4)**
  → `feat(verify): sympy derivation step checker`
- [x] **44. Derivation corpus** — known-good **and known-bad** derivations. *The single most important test suite in the project: a checker that never fails manufactures false confidence.*
  *Done when:* every planted error is caught and every valid derivation passes. → `test(verify): known-good and known-bad derivation corpus`
- [x] **45. Dimensional analysis** — `pint` unit checking across derivations and empirical results.
  → `feat(verify): dimensional analysis with pint`
- [x] **46. Numeric spot-check + Z3** — random sampling to falsify identities cheaply before symbolic work; SMT for logical/constraint claims.
  → `feat(verify): numeric spot-check and smt solver`
- [x] **47. Statistical audit** — n, effect size, CIs, multiple-comparison correction, p-hacking shape detection.
  → `feat(verify): statistical audit for empirical claims`
- [x] **48. Derivation UI** — LaTeX with per-step PASS / FAIL / **UNCHECKABLE**. Unchecked steps stay visible, never silently hidden.
  → `feat(ui): derivation view with per-step verification status`

> **Stage gate:** planted errors are caught; unverifiable steps are honestly labelled rather than assumed correct.

---

## Stage 8 — The full protocol `Phases 49–54`

Needs the sandbox and verifier, so it lands here rather than with Stage 4.

- [x] **49. METHOD phase** — proposer drafts an executable protocol; critics attack fixed axes (internal validity, confounds, leakage, power, baselines, reproducibility); verifier smoke-runs.
  → `feat(orchestrator): method design phase`
- [x] **50. EXECUTION phase** — protocol → sandbox → hashed artifacts, with the "no unearned results" invariant enforced end to end.
  → `feat(orchestrator): execution phase wired to sandbox`
- [x] **51. CRITIQUE phase** — structured critique objects `{claim_id, axis, severity, argument, proposed_test}`, cross-vendor assignment.
  → `feat(orchestrator): structured cross-vendor critique phase`
- [x] **52. Test auto-routing** — a `proposed_test` routes automatically to the sandbox or SymPy. **(P4 in action.)**
  → `feat(orchestrator): auto-route proposed tests to verifiers`
- [x] **53. RESOLUTION phase** — disputes settled by discriminating evidence; no test that discriminates → `UNRESOLVED` with both positions preserved. Referee writes rationale but cannot overrule evidence. **(P6)**
  → `feat(orchestrator): evidence-based dispute resolution`
- [x] **54. Full 7-phase E2E** — complete run against mock models in CI.
  → `test(e2e): full seven-phase session against mock models`

> **Stage gate:** a complete research session runs start to finish without human intervention beyond the two approval gates.

---

## Stage 9 — Artifacts `Phases 55–59`

- [x] **55. Formula pipeline** — LaTeX canonical, KaTeX preview in UI, real LaTeX for print. → `feat(artifacts): latex formula pipeline`
- [x] **56. Mermaid + Graphviz** — bundled `dot`, deterministic SVG/PDF output, CAS storage. → `feat(artifacts): mermaid and graphviz rendering`
- [x] **57. TikZ + matplotlib** — TikZ via Tectonic, matplotlib figures from the sandbox. → `feat(artifacts): tikz and matplotlib figure generation`
- [x] **58. Figure ↔ claim linking** — every figure keeps its generating source and the claims it supports; regeneration determinism test.
  *Done when:* deleting a figure and regenerating from source yields a byte-identical file. → `feat(artifacts): figure provenance and regeneration`
- [x] **59. Artifact browser** — browse, preview, re-render, and trace any artifact. → `feat(ui): artifact browser`

---

## Stage 10 — Paper compiler `Phases 60–65`

- [x] **60. Tectonic driver** — bundle the engine, compile pipeline, error surfacing. → `chore(paper): bundle tectonic latex engine`
- [x] **61. Ledger → IR** — sections, claims, figures, references as an intermediate representation. → `feat(paper): ledger to document ir`
- [x] **62. IR → LaTeX + house template** — the native "Sheep Research Record" format. → `feat(paper): latex emitter and sheep research record template`
- [x] **63. ML conference templates** — NeurIPS, ICML, ICLR. → `feat(paper): neurips, icml and iclr templates`
- [x] **64. IEEE / ACM / arXiv templates** → `feat(paper): ieee, acm and arxiv templates`
- [x] **65. Provenance appendix + repro bundle + compile-time enforcement** — auto-generated appendix (roster, versions, params, cost, seeds, env lock, artifact hashes, event-log root hash); zip bundle with replay script; **a claim-bearing sentence with no ledger id fails the build.** **(P5)**
  → `feat(paper): provenance appendix and reproduction bundle`

> **Stage gate:** an unprovenanced sentence breaks the build, and the emitted bundle reproduces every figure from scratch.

---

## Stage 11 — Retrieval, quarantined `Phases 66–69`

- [x] **66. Literature clients** — arXiv, Semantic Scholar, Crossref with retrieval records and snapshots. → `feat(retrieval): arxiv, semantic scholar and crossref clients`
- [x] **67. Quarantine + injection guard** — retrieved text is delimited, marked untrusted, and never interpreted as instructions. → `feat(retrieval): source quarantine and prompt injection guard`
- [ ] **68. Vector index** — `sqlite-vec` for dedupe, clustering, and semantic search over the session corpus. → `feat(retrieval): vector index over session corpus`
- [ ] **69. CITED rules + citation UI** — enforce that cited claims support but never alone establish a conclusion. **(P2)** → `feat(core): cited claim enforcement and citation ui`

---

## Stage 12 — Ship `Phases 70–75`

- [ ] **70. Session export/import** — portable session bundles with full event log and blobs. → `feat(store): session export and import bundles`
- [ ] **71. Windows installer** — electron-builder, NSIS, icons, file associations. → `chore(build): windows installer`
- [ ] **72. macOS + Linux builds** → `chore(build): macos and linux packaging`
- [ ] **73. Auto-update + signing** → `chore(build): signed auto-update`
- [ ] **74. Documentation** — README, user guide, architecture doc, contributing guide. → `docs: user guide and architecture documentation`
- [ ] **75. Acceptance run** — two cloud models + one local, a real research question end to end, exported paper, bundle verified to reproduce. → `test(e2e): full acceptance run`

---

## Optional / deferred

- [ ] **X1. Browser-session adapter** *(experimental, off by default)* — ChatGPT Plus / Claude Pro consumer sessions. Violates those providers' terms of service and risks account bans; isolated behind a feature flag so nothing else depends on it and public builds ship it disabled. Build only if you still want it after the rest works.
- [ ] **X2. Docker/WSL2 strict sandbox mode** — a genuine security boundary for untrusted code, replacing the Job Object best-effort isolation.
- [ ] **X3. Lean/Coq formal verification backend** — for claims where SymPy and Z3 aren't enough.

---

## Open questions to settle during Stage 0–2

1. **Bundle size** — CPython + wheels + Tectonic + Graphviz is roughly 400–700 MB installed. Ship it all, or fetch on first use with a small installer?
2. **First-run defaults** — default model roster and default budget cap.
3. **Autonomous mode** — are the Charter and hypothesis-selection human gates mandatory, or skippable?
