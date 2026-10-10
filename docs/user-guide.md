# Sheep user guide

Sheep takes one research question through a fixed protocol with several models
and leaves behind a record you can check. This guide follows the app's panes in
the order a session uses them.

- [Before you start](#before-you-start)
- [Connections](#connections)
- [Sessions](#sessions)
- [Conversation: running the protocol](#conversation-running-the-protocol)
- [Ledger](#ledger)
- [Lab](#lab)
- [Verification](#verification)
- [Artifacts](#artifacts)
- [Paper](#paper)
- [Moving a session between machines](#moving-a-session-between-machines)
- [Updates](#updates)
- [What leaves your machine](#what-leaves-your-machine)
- [When something goes wrong](#when-something-goes-wrong)

## Before you start

You need at least **two models from two different vendors**. This is not a
preference: the protocol will not let a model be critiqued by another model
from the same vendor, so a roster from one vendor cannot run. Three models is
better — it leaves someone unstaked to referee.

A local model counts as its own vendor. Ollama, LM Studio and a llama.cpp
server are detected automatically when they are running.

## Connections

A connection is how Sheep reaches a provider.

| Kind | What you supply |
|---|---|
| Anthropic, OpenAI | An API key |
| OpenAI-compatible (Groq, Together, DeepSeek, OpenRouter, xAI, Azure, …) | A base URL and a key |
| Google | An API key, or **Sign in** with your Google account |
| Local (Ollama, LM Studio, llama.cpp) | Nothing; start the runtime and press **Detect local runtimes** |

Press **Test** on a connection to confirm it answers. The badge beside it shows
the last result.

Keys are written to the operating system's credential store — Windows
Credential Manager on Windows. Sheep's database holds only a reference to the
key, and keys are masked in every log line.

## Sessions

A session is one question, one roster and one event stream.

1. Give it a **title** and a **research question**. The question is fixed
   before any model is asked anything, and is quoted verbatim in the paper.
2. Open **Roster** and attach models. For each you can set a weight, a
   per-model spend cap and a preferred role. A preferred role is a preference:
   the hard rules below always win.
3. Set the session's **spend cap**. When it is reached the session stops
   cleanly and waits for you to raise it; nothing is lost.

**Export** saves a session to a `.sheep` file; **Import session…** opens one.
See [Moving a session between machines](#moving-a-session-between-machines).

## Conversation: running the protocol

Press **Start the protocol** (later, **Continue**). The session moves through seven phases:

| Phase | What happens |
|---|---|
| **Framing** | Each model states the problem independently and blind. A referee drafts a Charter. **You approve it.** |
| **Hypothesis** | Hypotheses are generated blind, grouped, and scored blind. **You choose which to pursue.** |
| **Method** | One model drafts an executable method; models from other vendors attack it; it is smoke-run. |
| **Execution** | The method's script runs in the sandbox. Findings are recorded only if the run earned them. |
| **Critique** | Models from other vendors challenge each finding and propose a test for each challenge. |
| **Resolution** | Every proposed test that a program can run is run. Its result decides the dispute. |
| **Synthesis** | One model writes an account of the session from the ledger. |

The two gates in bold are the only points at which the session waits for you.

Some things the protocol guarantees, whatever the models say:

- **No model sees another's answer before committing its own** in a blind round.
- **A critic is never from the author's vendor**, and nobody critiques itself.
- **A finding cannot be recorded without a run or a checked derivation behind
  it.** A model that asserts a number the run never printed has that number
  refused.
- **A referee writes a rationale but cannot overrule a test.** The outcome of a
  dispute is read off the test.
- **A dispute no test could decide stays unresolved**, with both positions kept
  as they were stated. Nobody is asked to settle it by argument.

You can press **Stop** at any time. If the app is closed mid-session, reopening it
resumes at the last recorded turn, without paying again for turns already
answered.

## Ledger

The ledger is every claim in the session and what it rests on, drawn as a
graph. Select a claim to open its provenance: which model asserted it, which
version, with what parameters, at what cost, and every claim beneath it.

Every claim has a type:

| Type | It must rest on | Can it be established? |
|---|---|---|
| `EMPIRICAL` | A sandbox run that exited cleanly | Yes |
| `DERIVED` | A derivation with no failing step | Yes |
| `CITED` | A source a literature search actually returned | No — it can support other claims only |
| `CONJECTURE` | Nothing | No |

You can record a claim yourself at the bottom of the pane. It is held to the
same rules as a model's, and a claim that breaks one is refused with the rule
it broke.

### Literature

Below the graph you can search **arXiv**, **Semantic Scholar** or **Crossref**.
A search sends only the words you type. What comes back is recorded with the
provider's raw response.

- To cite a source, write one sentence saying what it shows and press **Cite**.
  This records a `CITED` claim.
- A citation can only be of a source in this list. A reference typed from
  memory is refused, because nothing shows it exists.
- A source in a red-bordered row was **flagged**: a scan found text in its
  title or abstract that reads as an instruction to an AI rather than a
  description of the work. It is kept exactly as retrieved and labelled.
- The same paper returned by two providers is marked as the same work on both
  rows.

Sources retrieved before a phase opens are shown to the models in the
Hypothesis, Method and Critique phases, fenced off as untrusted data.

The second search box searches the session itself: its turns, claims and
sources.

## Lab

The Lab runs Python in the bundled runtime: CPython 3.12 with NumPy, SciPy,
SymPy, pandas, matplotlib, scikit-learn, NetworkX, pint and Z3.

Every run is confined — capped memory, capped CPU, a wall-clock timeout, no
network, and no writing outside its own directory — and every run is recorded
whatever happened to it, with its code, seed, output and files. The same
script with the same seed produces the same output and byte-identical figures.

> The sandbox contains runaway code. It is not a security boundary against
> code written deliberately to escape it.

Any figure a script saves appears in **Artifacts**.

## Verification

Paste a derivation as a list of premises and steps, each step naming the
operation that is supposed to produce it. Each step is checked by SymPy and
shown as **PASS**, **FAIL** or **UNCHECKABLE**.

**UNCHECKABLE** means no checker could decide the step. It is never counted as
a pass and never hidden. A derivation with a failing step cannot back a claim.

## Artifacts

Every figure, diagram and formula in the session, with what made it.

Five kinds can be created here: a **formula** (LaTeX), a **Mermaid** diagram, a
**Graphviz** graph, a **TikZ** picture, or a **matplotlib** figure. Figures
saved by Lab runs and by the protocol's own experiments are listed too.

Opening an artifact shows its source, the tool and version that rendered it,
the hash of each file, and the claims that rest on it.

**Re-render from source and compare** renders the artifact again from its
stored source and tells you, file by file, whether the result is
byte-identical. If a file is missing from the store it is put back. If the
result differs, the tool versions then and now are shown side by side, and
nothing is replaced.

## Paper

Choose a template and press **Compile**. The paper is built from the ledger
each time; nothing about it is stored between compilations.

Templates: the native **Sheep Research Record**, **NeurIPS**, **ICML**,
**ICLR**, **IEEE**, **ACM** and **arXiv**. They differ in the page. The text is
identical in all of them.

### When the paper refuses to compile

A sentence in which the paper asserts something must name a claim in the
ledger. If the synthesis contains a sentence that names none, the build stops
and the pane shows you the sentence.

You then have one choice: tick **Leave out sentences that name no claim in the
ledger** and compile again. The paper's appendix then states how many
sentences were left out.

### The reproduction bundle

**Export reproduction bundle** saves a zip containing the PDF, its LaTeX
source, every figure with its source, the session's event log, and
`reproduce.py`. Run from the unpacked bundle:

```bash
python reproduce.py --dot <path to dot> --tectonic <path to tectonic>
```

The script redraws every figure from its source and compares each with the
hash the paper recorded. It never reads the figures in the bundle. Mermaid
diagrams need a browser and are reported as skipped.

Identical bytes need the same tool versions; `manifest.json` names them.

## Moving a session between machines

**Export** on a session writes a `.sheep` file holding every event of the
session and every file those events refer to. On another machine, **Import
session…** — or double-clicking the file — brings it in.

An imported session is checked before it is accepted: every event against its
hash, every file against its name, and then every claim against the ledger's
rules exactly as when it was first recorded. A bundle that fails any check is
refused and leaves nothing behind.

Two things to know:

- A session can be imported once. Importing it again is refused.
- Connections do not travel — they hold your keys. An imported session can be
  read, searched and compiled, but to run it further you attach models from
  the connections on the new machine.

## Updates

Sheep does not check for updates on its own. **Check for updates** in the
status bar contacts the project's GitHub releases when you press it.

An update is only offered to a build that was signed by its publisher, and is
verified against that signature before it is installed. An unsigned build
tells you so and points you at the releases page instead.

## What leaves your machine

| When | What is sent | Where |
|---|---|---|
| A model takes a turn | The prompt for that turn | The provider of that model |
| You press **Search** in Literature | The words you typed | The provider you chose |
| You press **Check for updates** | A request for the release list | GitHub |
| You sign in with Google | The sign-in itself | Google |

Nothing else. There is no telemetry, no crash reporting and no account.

## When something goes wrong

| What you see | What it means |
|---|---|
| *the python runtime is not installed* | Run `npm run fetch-runtime` (source checkouts only). |
| *the rendering tools are not installed* | Run `npm run fetch-tools` (source checkouts only). |
| *…is not among the TeX packages bundled with Sheep* | A figure or paper asked for a LaTeX package that was not fetched. |
| *LEDGER_EMPIRICAL_WITHOUT_EXECUTION* | An empirical claim was offered with no run behind it. |
| *LEDGER_UNKNOWN_SOURCE* | A citation of something no search returned. |
| *…is rate-limiting requests from this address* | The literature provider wants you to wait. Semantic Scholar does this often without a key. |
| The chain status in the status bar says **BROKEN** | The event log has been altered outside Sheep. The entries that fail are listed in the log output. |
