import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from './connection';

import { AuthKey } from '../crypto/AuthKey';
import Logger from '../extensions/Logger';
import MTProtoSender from './MTProtoSender';

describe('MTProtoSender receive loop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconnects when the active connection returns no data', async () => {
    const sender = new MTProtoSender(new AuthKey(), {
      logger: new Logger('error'),
      retries: 1,
      retriesToFallback: 1,
      retryMainConnectionDelay: 1,
      delay: 1,
      dcId: 1,
      autoReconnect: true,
      shouldForceHttpTransport: false,
      shouldAllowHttpTransport: false,
      connectTimeout: 1,
      authKeyCallback: () => undefined,
    });
    sender._connection = {
      recv: vi.fn().mockResolvedValue(undefined),
    } as unknown as Connection;
    sender._userConnected = true;

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reconnect = vi.spyOn(sender, 'reconnect').mockImplementation(() => {
      sender.isReconnecting = true;
    });

    await sender._recvLoop();

    expect(reconnect).toHaveBeenCalledOnce();
  });
});
