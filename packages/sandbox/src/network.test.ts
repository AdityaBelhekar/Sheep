import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testSandbox } from './test-support';

const { sandbox, root } = testSandbox();

const DENIED = 'PermissionError: sandbox: network access is not allowed';

describe('network denial: audit hook', () => {
  it.each([
    ['a TCP connection', 'socket.create_connection(("1.1.1.1", 80), timeout=5)'],
    ['a UDP datagram', 'socket.socket(type=socket.SOCK_DGRAM).sendto(b"x", ("1.1.1.1", 53))'],
    ['a name lookup', 'socket.getaddrinfo("example.com", 80)'],
    ['a legacy name lookup', 'socket.gethostbyname("example.com")'],
    ['a reverse lookup', 'socket.gethostbyaddr("1.1.1.1")'],
    ['listening on every interface', 'socket.socket().bind(("0.0.0.0", 0))'],
    ['a name that merely starts like loopback', 'socket.getaddrinfo("127.example.com", 80)'],
  ])('refuses %s', async (_what, statement) => {
    const result = await sandbox.run({ code: `import socket\n${statement}\nprint("reached")` });

    expect(result.status).toBe('error');
    expect(result.stderr).toContain(DENIED);
    expect(result.stdout).toBe('');
    // Refused, not timed out: the hook answers before anything is sent.
    expect(result.durationMs).toBeLessThan(4_000);
  });

  it('refuses the standard library clients built on sockets', async () => {
    const result = await sandbox.run({
      code: [
        'import urllib.request',
        'try:',
        '    urllib.request.urlopen("http://example.com", timeout=5)',
        'except Exception as error:',
        '    print(error)',
      ].join('\n'),
    });

    expect(result.stdout).toContain('sandbox: network access is not allowed');
  });

  it('leaves loopback open', async () => {
    const result = await sandbox.run({
      code: [
        'import socket',
        'server = socket.socket()',
        'server.bind(("127.0.0.1", 0))',
        'server.listen(1)',
        'client = socket.create_connection(server.getsockname(), timeout=5)',
        'peer, _ = server.accept()',
        'client.sendall(b"ping")',
        'print(peer.recv(4))',
        'print(socket.getaddrinfo("localhost", 80)[0][4][0] in ("127.0.0.1", "::1"))',
      ].join('\n'),
    });

    expect(result).toMatchObject({ status: 'ok', stdout: "b'ping'\nTrue\n" });
  });
});

describe('network denial: environment', () => {
  const planted = ['HTTPS_PROXY', 'http_proxy', 'ALL_PROXY', 'SHEEP_TEST_API_KEY'];
  afterEach(() => {
    for (const name of planted) delete process.env[name];
  });

  it('gives the script no proxy and none of the parent environment', async () => {
    for (const name of planted) process.env[name] = 'http://proxy.invalid:3128';

    const result = await sandbox.run({
      code: [
        'import os, urllib.request',
        'print(sorted(k for k in os.environ if "proxy" in k.lower() or "KEY" in k))',
        'print(urllib.request.getproxies())',
        'print("proxy.invalid" in " ".join(os.environ.values()))',
      ].join('\n'),
    });

    expect(result.stdout).toBe("['NO_PROXY']\n{'no': '*'}\nFalse\n");
  });

  it('points home and temp into the jail', async () => {
    const result = await sandbox.run({
      code: [
        'import os, tempfile',
        'print(os.path.expanduser("~") == tempfile.gettempdir() == os.environ["TEMP"])',
        'print(os.path.dirname(tempfile.gettempdir()) == os.path.dirname(os.getcwd()))',
      ].join('\n'),
    });

    expect(result.stdout).toBe('True\nTrue\n');
  });
});

/**
 * The layer under the hook, exercised with no hook at all: the runner is
 * driven directly and starts a bare interpreter, so the only thing between the
 * script and the internet is the Job Object.
 *
 * It needs a host that would otherwise answer, so it reaches off the machine
 * and is opt-in: SHEEP_NETWORK_TESTS=1.
 */
describe.skipIf(process.env['SHEEP_NETWORK_TESTS'] !== '1')('network denial: job object', () => {
  const probe = [
    'import socket',
    'try:',
    '    socket.create_connection(("1.1.1.1", 80), timeout=4)',
    '    print("connected")',
    'except TimeoutError:',
    '    print("blocked")',
  ].join('\n');

  it('lets nothing out of the job, hook or no hook', () => {
    // Without the job the same script connects — otherwise "blocked" proves nothing.
    const bare = spawnSync(sandbox.runtime.python, ['-I', '-c', probe], { encoding: 'utf8' });
    expect(bare.stdout.trim()).toBe('connected');

    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'run',
      params: {
        python: sandbox.runtime.python,
        args: ['-I', '-c', probe],
        workDir: root,
        env: { SystemRoot: process.env['SystemRoot'] },
        limits: { memoryBytes: 2 ** 30, cpuPercent: 50, timeoutMs: 20_000, maxProcesses: 2 },
      },
    };
    const confined = spawnSync(
      sandbox.runtime.python,
      ['-I', '-S', join(root, 'runner', 'runner.py')],
      { input: `${JSON.stringify(request)}\n`, encoding: 'utf8' },
    );
    const messages = confined.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { params?: { data: string } });

    expect(messages[0]?.params?.data.trim()).toBe('blocked');
  }, 30_000);
});
