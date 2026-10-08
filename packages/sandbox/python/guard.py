"""Sheep sandbox guard: the first code to run in the script's own process.

It confines the interpreter, then runs the script as `__main__`. Everything
here happens before a line of the script does, and none of it can be undone
from inside: an audit hook cannot be removed, and a process cannot raise its
own integrity level.

This is defence in depth against a script that misbehaves — a runaway loop, a
stray write, a library that phones home — not a boundary against code written
to escape. Python can load native code, and native code answers to the
operating system, not to an audit hook. The layers below that hold regardless
are the Job Object the runner put this process in — which also paces outbound
network traffic down to nothing — and the low integrity level set here.
"""

import json
import os
import sys
import traceback


def lower_integrity():
    """Drops this process to low integrity.

    Windows refuses writes from a low-integrity process to anything not itself
    labelled low, and only the jail is. So a write outside the jail fails in
    the kernel, however the script goes about it.
    """
    import ctypes
    from ctypes import wintypes

    class Label(ctypes.Structure):
        _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    advapi32.OpenProcessToken.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.HANDLE),
    ]
    advapi32.ConvertStringSidToSidW.argtypes = [
        wintypes.LPCWSTR,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    advapi32.GetLengthSid.argtypes = [ctypes.c_void_p]
    advapi32.GetLengthSid.restype = wintypes.DWORD
    advapi32.SetTokenInformation.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]

    def check(ok, what):
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error(), what)

    token = wintypes.HANDLE()
    # TOKEN_ADJUST_DEFAULT | TOKEN_QUERY
    check(
        advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x80 | 0x8, ctypes.byref(token)),
        "OpenProcessToken",
    )
    sid = ctypes.c_void_p()
    # The low mandatory level.
    check(advapi32.ConvertStringSidToSidW("S-1-16-4096", ctypes.byref(sid)), "ConvertStringSid")
    label = Label(sid, 0x20)  # SE_GROUP_INTEGRITY
    check(
        advapi32.SetTokenInformation(
            token, 25, ctypes.byref(label), ctypes.sizeof(label) + advapi32.GetLengthSid(sid)
        ),
        "SetTokenInformation(TokenIntegrityLevel)",
    )
    kernel32.CloseHandle(token)


def install_jail(config):
    """Refuses file access outside the jail and any attempt to start a process."""

    def normalise(path):
        return os.path.normcase(os.path.realpath(os.fsdecode(path)))

    write_roots = tuple(normalise(root) for root in config["write"])
    read_roots = write_roots + tuple(normalise(root) for root in config["read"])
    devnull = normalise(os.devnull)
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC

    def require(path, roots, action):
        if isinstance(path, int):  # an already-open descriptor
            return
        try:
            full = normalise("." if path is None else path)
        except (TypeError, ValueError, OSError):
            full = None
        if full is not None and (
            full == devnull or any(full == root or full.startswith(root + os.sep) for root in roots)
        ):
            return
        raise PermissionError(f"sandbox: cannot {action} outside the working directory: {path!r}")

    def on_open(args):
        path, _mode, flags = args
        if flags & write_flags:
            require(path, write_roots, "write")
        else:
            require(path, read_roots, "read")

    def reads(args):
        require(args[0], read_roots, "read")

    def writes(args):
        require(args[0], write_roots, "write")

    def writes_both(args):
        require(args[0], write_roots, "write")
        require(args[1], write_roots, "write")

    def no_processes(_args):
        raise PermissionError("sandbox: starting a process is not allowed")

    handlers = {
        "open": on_open,
        "os.listdir": reads,
        "os.scandir": reads,
        "os.chdir": reads,
        "os.mkdir": writes,
        "os.rmdir": writes,
        "os.remove": writes,
        "os.chmod": writes,
        "os.truncate": writes,
        "os.utime": writes,
        "os.rename": writes_both,
        "os.link": writes_both,
        "os.symlink": writes_both,
        "subprocess.Popen": no_processes,
        "_winapi.CreateProcess": no_processes,
        "os.system": no_processes,
        "os.exec": no_processes,
        "os.spawn": no_processes,
        "os.posix_spawn": no_processes,
        "os.fork": no_processes,
        "os.forkpty": no_processes,
        "os.startfile": no_processes,
    }

    def hook(event, args):
        handler = handlers.get(event)
        if handler is not None:
            handler(args)

    sys.addaudithook(hook)


def install_network_denial():
    """Refuses any socket operation that would leave the machine.

    Loopback stays open: a script may talk to itself. Name lookups are refused
    too — a DNS query is network traffic, and carries whatever is in the name.
    """
    import ipaddress

    def is_loopback(host):
        if isinstance(host, bytes):
            host = host.decode("ascii", "replace")
        if not isinstance(host, str):
            return False
        if host == "localhost":
            return True
        try:
            return ipaddress.ip_address(host.partition("%")[0]).is_loopback
        except ValueError:
            return False

    def refuse(target):
        raise PermissionError(f"sandbox: network access is not allowed: {target!r}")

    def address(args):
        target = args[1]
        if target is None:  # sendmsg on a socket that is already connected
            return
        if not (isinstance(target, tuple) and target and is_loopback(target[0])):
            refuse(target)

    def lookup(args):
        # getaddrinfo(None, port) asks for a local address and sends nothing.
        if args[0] is not None and not is_loopback(args[0]):
            refuse(args[0])

    def reverse_lookup(args):
        target = args[0]
        if not is_loopback(target[0] if isinstance(target, tuple) else target):
            refuse(target)

    handlers = {
        "socket.connect": address,
        "socket.bind": address,
        "socket.sendto": address,
        "socket.sendmsg": address,
        "socket.getaddrinfo": lookup,
        "socket.gethostbyname": lookup,
        "socket.gethostbyaddr": reverse_lookup,
        "socket.getnameinfo": reverse_lookup,
    }

    def hook(event, args):
        handler = handlers.get(event)
        if handler is not None:
            handler(args)

    sys.addaudithook(hook)


def seed_everything(seed):
    """Seeds every generator a script reaches for without thinking about it.

    PYTHONHASHSEED is already fixed by the environment, so set and dict order
    of strings repeats. This covers `random`, numpy's legacy global state, and
    numpy's `default_rng()` — which, called with no seed, would otherwise draw
    fresh entropy from the OS and make the run unrepeatable by design. Unseeded
    generators are instead spawned from the run's seed, in the order they are
    created. A script that passes its own seed gets exactly what it asked for.
    """
    import random

    random.seed(seed)

    import numpy

    numpy.random.seed(seed)
    root = numpy.random.SeedSequence(seed)
    default_rng = numpy.random.default_rng

    def seeded_default_rng(seed=None):
        return default_rng(root.spawn(1)[0] if seed is None else seed)

    numpy.random.default_rng = seeded_default_rng


def execute(entry):
    sys.argv = [entry]
    scope = {"__name__": "__main__", "__file__": entry, "__builtins__": __builtins__}
    try:
        with open(entry, "rb") as source:
            code = compile(source.read(), entry, "exec")
        exec(code, scope)
    except SystemExit:
        raise
    except BaseException as error:
        # The traceback starts at the script: frames from this file are not
        # something the author of the script can act on.
        frame = error.__traceback__
        while frame is not None and frame.tb_frame.f_code.co_filename != entry:
            frame = frame.tb_next
        traceback.print_exception(type(error), error, frame)
        sys.exit(1)


def main():
    config = json.loads(sys.argv[1])
    # One newline convention on every platform, so recorded output is the same
    # bytes wherever the run happened.
    sys.stdout.reconfigure(newline="\n")
    sys.stderr.reconfigure(newline="\n")

    if sys.platform == "win32":
        lower_integrity()
    install_jail(config)
    install_network_denial()
    seed_everything(config["seed"])
    execute(config["entry"])


if __name__ == "__main__":
    main()
