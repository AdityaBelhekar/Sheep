<div align="center">
  <img src="./sheep.png" alt="Sheep logo" width="140" />

  # Sheep

  **A multi-model sandbox for research you can check.**
</div>

Sheep runs a research question past several AI models from different vendors,
makes them commit to answers before they see each other's, has models from one
vendor critique the work of another, and settles every disagreement it can by
running code or checking a derivation — not by asking a model who is right.
What comes out is a paper in which every sentence that asserts something names
the evidence it rests on, with a bundle that redraws its figures from scratch.

It is a desktop app. There is no server and no telemetry: your sessions, keys
and results stay on your machine.

## What makes it different

| | |
|---|---|
| **Attribution is physical** | A critic is a *different vendor's model*, never the same model playing a role. |
| **Claims are typed** | `DERIVED`, `EMPIRICAL`, `CITED` or `CONJECTURE`. An empirical claim with no recorded run behind it cannot be written down at all. |
| **Independent before collective** | Every phase opens blind and in parallel. Agreement afterwards means something. |
| **Verification is not a model** | SymPy, Z3, pint and a sandboxed Python decide. A model only proposes what to check. |
| **Reproducibility is a build artifact** | An append-only, hash-chained event log replays any session. Figures regenerate byte for byte. |
| **Disagreement is output** | A dispute no test could settle ships in the paper as an open question, with both positions. |
| **Local-first** | No server. The only network calls are to the model providers and literature databases you choose. |

## Install

Download the installer for your platform from the
[releases page](https://github.com/AdityaBelhekar/Sheep/releases) and run it.

Windows is the supported platform today. macOS and Linux packages are built by
CI but the code sandbox is not yet available on them — see
[the roadmap](./ROADMAP.md).

## Run from source

Requires Node 22.12 or newer, on Windows x64.

```bash
npm install
```

```bash
npm run fetch-runtime
```

```bash
npm run fetch-tools
```

```bash
npm run dev
```

`fetch-runtime` installs the pinned Python the sandbox runs code in, and
`fetch-tools` installs the pinned Graphviz and Tectonic used for diagrams and
papers. Both download only what their lock files name, and check every file
against its sha256 before using it.

## A session, briefly

1. **Connections** — add the providers you have: an API key, a Google sign-in,
   or a local runtime such as Ollama. Keys go to the operating system's
   credential store; the database only ever holds a reference.
2. **Sessions** — state a research question, attach at least two models from
   different vendors, and set a spend cap.
3. **Conversation** — run the protocol. It stops for you exactly twice: to
   approve the Charter, and to choose which hypotheses to pursue.
4. **Ledger, Lab, Verification, Artifacts** — watch claims, runs, derivations
   and figures accumulate, each traceable to what produced it.
5. **Paper** — compile the record in the house format or a conference
   template, and export the reproduction bundle.

The [user guide](./docs/user-guide.md) walks through each step.

## Documentation

- [User guide](./docs/user-guide.md) — using the app, pane by pane
- [Architecture](./docs/architecture.md) — how it is built, and why
- [Contributing](./CONTRIBUTING.md) — building, testing and the rules a change is held to
- [Roadmap](./ROADMAP.md) — what was built, in order, and what is left

## Licence

[MIT](./LICENSE). The conference style files fetched by `npm run fetch-tools`
belong to their conferences and are not part of this repository.
