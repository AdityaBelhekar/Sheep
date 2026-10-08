"""Sheep sandbox runner.

Speaks JSON-RPC 2.0 over stdio, one message per line. It reads a single `run`
request, confines itself to a Job Object, starts the script as a child process,
relays what the child prints as `output` notifications while it is printing,
and answers with a result envelope once the child has exited or run out of
time.

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


class Job:
    """A Windows Job Object holding this process and everything it starts.

    The runner joins the job itself and only then starts the script, so the
    script is born inside it — there is no window in which it runs unconfined,
    and no suspended-process dance to get it there. The handle is not
    inheritable: the script is subject to the limits and holds nothing it could
    use to relax them. When the runner exits, for any reason including being
    killed, the last handle closes and the kernel ends every process still in
    the job.
    """

    def __init__(self, limits):
        import ctypes
        from ctypes import wintypes

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in "abcdef"]

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimits),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        class CpuRate(ctypes.Structure):
            _fields_ = [("ControlFlags", wintypes.DWORD), ("CpuRate", wintypes.DWORD)]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        info_args = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.SetInformationJobObject.argtypes = info_args
        kernel32.QueryInformationJobObject.argtypes = [*info_args, ctypes.c_void_p]

        def check(ok, what):
            if not ok:
                raise ctypes.WinError(ctypes.get_last_error(), what)

        self._ctypes = ctypes
        self._kernel32 = kernel32
        self._ExtendedLimits = ExtendedLimits
        self._handle = kernel32.CreateJobObjectW(None, None)
        check(self._handle, "CreateJobObject")

        extended = ExtendedLimits()
        # KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION | PROCESS_MEMORY | ACTIVE_PROCESS
        extended.BasicLimitInformation.LimitFlags = 0x2000 | 0x400 | 0x100 | 0x8
        extended.BasicLimitInformation.ActiveProcessLimit = limits["maxProcesses"]
        extended.ProcessMemoryLimit = limits["memoryBytes"]
        check(
            kernel32.SetInformationJobObject(
                self._handle, 9, ctypes.byref(extended), ctypes.sizeof(extended)
            ),
            "SetInformationJobObject(limits)",
        )

        # ENABLE | HARD_CAP. The rate is a share of the whole machine, in
        # hundredths of a percent.
        rate = CpuRate(0x1 | 0x4, limits["cpuPercent"] * 100)
        check(
            kernel32.SetInformationJobObject(
                self._handle, 15, ctypes.byref(rate), ctypes.sizeof(rate)
            ),
            "SetInformationJobObject(cpu rate)",
        )

        check(
            kernel32.AssignProcessToJobObject(self._handle, kernel32.GetCurrentProcess()),
            "AssignProcessToJobObject",
        )

    def peak_memory_bytes(self):
        ctypes = self._ctypes
        extended = self._ExtendedLimits()
        ok = self._kernel32.QueryInformationJobObject(
            self._handle, 9, ctypes.byref(extended), ctypes.sizeof(extended), None
        )
        return extended.PeakProcessMemoryUsed if ok else None


def confine(limits):
    if sys.platform != "win32":
        # ponytail: Job Objects only. POSIX gets rlimits + a process group when
        # the macOS and Linux builds arrive (Phase 72); until then, fail closed.
        raise RuntimeError(f"no process isolation is implemented for {sys.platform}")
    return Job(limits)


def run(params):
    limits = params["limits"]
    job = confine(limits)

    budget = OutputBudget(OUTPUT_CAP_BYTES)
    started = time.monotonic()
    child = subprocess.Popen(
        [params["python"], *params["args"]],
        cwd=params["workDir"],
        env=params["env"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    pumps = [
        threading.Thread(target=pump, args=(pipe, name, budget), daemon=True)
        for pipe, name in ((child.stdout, "stdout"), (child.stderr, "stderr"))
    ]
    for thread in pumps:
        thread.start()

    timed_out = False
    try:
        exit_code = child.wait(limits["timeoutMs"] / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        child.kill()
        exit_code = child.wait()
    for thread in pumps:
        # Bounded: a grandchild holding the pipe open must not hold the result.
        thread.join(2)

    return {
        "exitCode": exit_code,
        "timedOut": timed_out,
        "durationMs": round((time.monotonic() - started) * 1000),
        "truncated": budget.truncated,
        "peakMemoryBytes": job.peak_memory_bytes(),
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
