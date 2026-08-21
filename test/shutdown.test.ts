import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The signal Fly ACTUALLY sends is SIGINT, verified in our own deploy logs
 * (3x "Sending signal SIGINT to main child process", zero SIGTERM). Testing
 * SIGTERM here — the signal a person sends by hand — would pass against a
 * handler that only listens for SIGTERM while every real deploy kept killing
 * requests in flight. So SIGINT is the case that must be exercised.
 *
 * Both paid rails settle AFTER the handler, so an interrupted request is one
 * where the payer's money has moved and the answer was never sent.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);

function boot(): Promise<{ child: ChildProcess; exited: { code: number | null } }> {
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PAYMENT_MODE: 'none',
      DATA_DIR: mkdtempSync(join(tmpdir(), 'shutdown-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited: { code: number | null } = { code: null };
  child.on('exit', (code) => { exited.code = code ?? -1; });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server never reported listening')), 25_000);
    child.stdout?.on('data', (b: Buffer) => {
      if (b.toString().includes('listening on')) { clearTimeout(timer); resolve({ child, exited }); }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('graceful shutdown: a request in flight when SIGINT arrives is not killed', () => {
  it('drains the in-flight request, answers it, and only then exits 0', async () => {
    const { child, exited } = await boot();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    // Open a real connection and start a request WITHOUT finishing the body, so
    // the server is genuinely mid-request when the signal lands.
    const sock = net.connect(PORT, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    let response = '';
    sock.on('data', (b) => { response += b.toString(); });
    sock.write(
      `POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n` +
        `Accept: application/json, text/event-stream\r\nContent-Length: ${body.length}\r\n\r\n` +
        body.slice(0, 10), // deliberately partial
    );
    await sleep(300);

    child.kill('SIGINT'); // exactly what Fly sends
    await sleep(700);

    // If shutdown were absent (or the drain broken) the process would already be
    // gone and this request would have died with the payer's money moved.
    expect(exited.code).toBeNull();

    sock.write(body.slice(10)); // finish the request the client was mid-way through
    await sleep(1500);

    expect(response).toContain('HTTP/1.1 200');
    expect(response).toContain('explain_transaction'); // a real answer, served after the signal

    for (let i = 0; i < 60 && exited.code === null; i++) await sleep(100);
    expect(exited.code).toBe(0); // clean exit, on its own terms
    sock.destroy();
  }, 60_000);

  it('exits promptly when nothing is in flight, so ordinary deploys stay fast', async () => {
    const { child, exited } = await boot();
    const started = Date.now();
    child.kill('SIGINT');
    for (let i = 0; i < 50 && exited.code === null; i++) await sleep(100);
    expect(exited.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000); // nowhere near the 25s grace
  }, 60_000);
});
