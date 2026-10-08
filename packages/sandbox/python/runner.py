"""Sheep sandbox runner.

Speaks JSON-RPC 2.0 over stdio, one message per line. It reads a single `run`
request, starts the script as a child process, relays what the child prints as
`output` notifications while it is printing, and answers with a result
envelope once the child has exited.

The script's stdout never touches this channel: it is a pipe the runner reads,
so nothing a script prints can be mistaken for a protocol message.

Standard library only, and started with -I -S: it must not depend on anything
a script could have influenced.
"""

import codecs
import json
import subprocess
import sys
import threading
import time

# Combined stdout + stderr relayed before the rest is dropped. A script that
# prints in a loop must not be able to fill the memory of whoever is listening.
OUTPUT_CAP_BYTES = 4 * 1024 * 1024

_write_lock = threading.Lock()


def send(message):
    line = (json.dumps({"jsonrpc": "2.0", **message}) + "\n").encode("ascii")
    with _write_lock:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()


class OutputBudget:
    def __init__(self, remaining):
        self.remaining = remaining
        self.truncated = False
        self._lock = threading.Lock()

    def take(self, size):
        with self._lock:
            if self.remaining <= 0:
                self.truncated = True
                return False
            self.remaining -= size
            return True


def pump(pipe, stream, budget):
    # Incremental, so a multi-byte character split across two reads survives.
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    while True:
        chunk = pipe.read1(65536)
        if not chunk:
            break
        text = decoder.decode(chunk)
        # Keeps draining after the cap: a full pipe would block the child, and
        # a script must hit its own limits rather than hang on ours.
        if text and budget.take(len(chunk)):
            send({"method": "output", "params": {"stream": stream, "data": text}})


def run(params):
    budget = OutputBudget(OUTPUT_CAP_BYTES)
    started = time.monotonic()
    child = subprocess.Popen(
        [params["python"], *params["args"]],
        cwd=params["workDir"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    pumps = [
        threading.Thread(target=pump, args=(pipe, name, budget), daemon=True)
        for pipe, name in ((child.stdout, "stdout"), (child.stderr, "stderr"))
    ]
    for thread in pumps:
        thread.start()

    exit_code = child.wait()
    for thread in pumps:
        # Bounded: a grandchild holding the pipe open must not hold the result.
        thread.join(2)

    return {
        "exitCode": exit_code,
        "durationMs": round((time.monotonic() - started) * 1000),
        "truncated": budget.truncated,
    }


def main():
    request = json.loads(sys.stdin.readline())
    try:
        if request.get("method") != "run":
            raise ValueError(f"unknown method: {request.get('method')}")
        send({"id": request.get("id"), "result": run(request["params"])})
    except Exception as error:  # the caller gets a reason, never a dead pipe
        send(
            {
                "id": request.get("id"),
                "error": {"code": -32000, "message": f"{type(error).__name__}: {error}"},
            }
        )


if __name__ == "__main__":
    main()
