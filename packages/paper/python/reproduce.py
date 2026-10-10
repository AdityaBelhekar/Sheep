"""Regenerates every figure of a Sheep Research Record from its source.

    python reproduce.py [--python PATH] [--dot PATH] [--tectonic PATH]

Run from the unpacked bundle. Each figure in manifest.json is rendered again
from the source beside it, by the same kind of tool that rendered it, and the
result is compared byte for byte with the hash the paper recorded. Nothing in
the bundle's figures/ directory is read: a figure that comes out identical was
reproduced from scratch.

Identical bytes need the same tools. The manifest names the versions and lock
hashes the paper was built with; with other versions, or other fonts, a figure
can differ without anything being wrong, and this says so rather than guessing.
A Mermaid diagram is drawn by a browser and cannot be redrawn here; it is
reported as skipped, and can be checked in Sheep itself.

Standard library only. Exit status 0 when every figure that could be redrawn
came out identical, 1 otherwise.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The fixed build date every renderer was given: 2000-01-01T00:00:00Z.
SOURCE_DATE_EPOCH = "946684800"

# What the sandbox does before a script starts, so that a script which never
# seeds anything still draws the same numbers. Kept in step with guard.py.
SEEDED_RUN = """
import random, runpy, sys
seed = int(sys.argv[1])
random.seed(seed)
import numpy
numpy.random.seed(seed)
_root = numpy.random.SeedSequence(seed)
_default_rng = numpy.random.default_rng
def _seeded_default_rng(seed=None):
    return _default_rng(_root.spawn(1)[0] if seed is None else seed)
numpy.random.default_rng = _seeded_default_rng
sys.argv = ["main.py"]
runpy.run_path("main.py", run_name="__main__")
"""


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def environment(extra=None):
    env = dict(os.environ)
    env.update({"SOURCE_DATE_EPOCH": SOURCE_DATE_EPOCH, "TZ": "UTC"})
    env.update(extra or {})
    return env


def run(command, cwd, env, stdin=None):
    done = subprocess.run(
        command, cwd=cwd, env=env, input=stdin, capture_output=True, timeout=900
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode("utf-8", "replace").strip()[-2000:])
    return done.stdout


def redraw_matplotlib(figure, source, work, tools):
    shutil.copyfile(source, work / "main.py")
    (work / "seeded_run.py").write_text(SEEDED_RUN, encoding="utf-8")
    config = work / "mpl"
    config.mkdir()
    (config / "matplotlibrc").write_text("backend: Agg\nsvg.hashsalt: sheep\n", encoding="utf-8")
    seed = str(figure["seed"])
    env = environment(
        {"PYTHONHASHSEED": seed, "SHEEP_SEED": seed, "MPLCONFIGDIR": str(config)}
    )
    for name in ("OPENBLAS", "OMP", "MKL", "NUMEXPR", "VECLIB"):
        env[name + "_NUM_THREADS"] = "1"
    run([tools.python, "-X", "utf8", "-B", "seeded_run.py", seed], work, env)


def redraw_graphviz(figure, source, work, tools):
    text = source.read_bytes()
    for output in figure["outputs"]:
        extension = output["path"].rsplit(".", 1)[-1]
        data = run([tools.dot, "-T" + extension], work, environment(), stdin=text)
        (work / output["path"]).write_bytes(data)


def redraw_latex(figure, source, work, tools):
    shutil.copyfile(source, work / "figure.tex")
    run([tools.tectonic, "-X", "compile", "--untrusted", "figure.tex"], work, environment())
    shutil.move(str(work / "figure.pdf"), str(work / figure["outputs"][0]["path"]))


REDRAW = {
    "matplotlib": ("python", redraw_matplotlib),
    "graphviz": ("dot", redraw_graphviz),
    "tikz": ("tectonic", redraw_latex),
    "formula": ("tectonic", redraw_latex),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--dot", default=shutil.which("dot"))
    parser.add_argument("--tectonic", default=shutil.which("tectonic"))
    tools = parser.parse_args()

    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    print("Sheep Research Record, session " + manifest["sessionId"])
    print("event-log root hash " + str(manifest["eventLog"]["rootHash"]))
    print("built with " + "; ".join(sorted(set(f["toolchain"] for f in manifest["figures"]))))
    print()

    failed = 0
    for figure in manifest["figures"]:
        name = figure["file"] + " (" + figure["kind"] + ")"
        tool, redraw = REDRAW.get(figure["kind"], (None, None))
        if redraw is None:
            print("SKIPPED    " + name + ": needs a browser; re-render it in Sheep")
            continue
        if getattr(tools, tool) is None:
            failed += 1
            print("MISSING    " + name + ": no " + tool + " found; pass --" + tool)
            continue

        with tempfile.TemporaryDirectory(prefix="sheep-reproduce-") as directory:
            work = Path(directory)
            try:
                redraw(figure, HERE / figure["source"], work, tools)
            except Exception as error:  # the tool's own words are the report
                failed += 1
                print("FAILED     " + name + ": " + str(error))
                continue

            differing = []
            for output in figure["outputs"]:
                produced = work / output["path"]
                actual = sha256(produced) if produced.exists() else None
                if actual != output["sha256"]:
                    differing.append(output["path"] + " recorded " + output["sha256"][:12]
                                     + ", now " + (actual[:12] if actual else "not produced"))
            if differing:
                failed += 1
                print("DIFFERENT  " + name + ": " + "; ".join(differing))
            else:
                print("IDENTICAL  " + name + ": " + ", ".join(
                    output["path"] + " " + output["sha256"][:12] for output in figure["outputs"]))

    print()
    print("every redrawn figure is byte-identical" if failed == 0
          else str(failed) + " figure(s) were not reproduced")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
