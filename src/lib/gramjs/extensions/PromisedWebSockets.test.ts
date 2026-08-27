import { afterEach, describe, expect, it, vi } from 'vitest';

import PromisedWebSockets from './PromisedWebSockets';

class FakeWebSocket {
  public binaryType: BinaryType = 'blob';

  public onclose?: (event: CloseEvent) => void;

  public onerror?: (event: Event) => void;

  public onmessage?: (event: MessageEvent) => void;

  public onopen?: (event: Event) => void;

  constructor(public readonly url: string, public readonly protocols?: string | string[]) {
    sockets.push(this);
  }

  public close() {
    // The timeout path is not exercised in this regression test.
  }

  public send(_data: ArrayBufferView | ArrayBuffer | Blob | string) {
    // No-op: the test only covers connection establishment.
  }
}

const sockets: FakeWebSocket[] = [];

describe('PromisedWebSockets', () => {
  afterEach(() => {
    sockets.length = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('allows a healthy WebSocket handshake to take longer than three seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const connection = new PromisedWebSockets(() => undefined).connect(443, 'example.test');
    let settled = false;
    void connection.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(9000);
    expect(settled).toBe(false);

    sockets[0]?.onopen?.(new Event('open'));
    await expect(connection).resolves.toBeInstanceOf(PromisedWebSockets);
  });
});
