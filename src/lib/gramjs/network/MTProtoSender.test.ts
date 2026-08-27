import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TLMessage } from '../tl/core';
import type { Connection } from './connection';

import { RPCError } from '../errors';
import { Api } from '../tl';
import { UpdateConnectionState } from './updates';

import { AuthKey } from '../crypto/AuthKey';
import Logger from '../extensions/Logger';
import MTProtoSender from './MTProtoSender';

describe('MTProtoSender receive loop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconnects when the active connection returns no data', async () => {
    const sender = createSender();
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

  it.each(['SESSION_REVOKED', 'USER_DEACTIVATED'])(
    'marks the main connection broken for %s',
    async (errorMessage) => {
      const updateCallback = await receiveRpcError(errorMessage);

      expect(updateCallback).toHaveBeenCalledWith(
        expect.objectContaining({ state: UpdateConnectionState.broken }),
      );
    },
  );

  it('keeps the existing main-sender handling for AUTH_KEY_UNREGISTERED', async () => {
    const updateCallback = await receiveRpcError('AUTH_KEY_UNREGISTERED');

    expect(updateCallback).not.toHaveBeenCalled();
  });
});

async function receiveRpcError(errorMessage: string) {
  const updateCallback = vi.fn();
  const sender = createSender(updateCallback);
  sender._connection = {
    recv: vi.fn()
      .mockResolvedValueOnce(Uint8Array.of(1))
      .mockResolvedValue(undefined),
  } as unknown as Connection;
  sender._userConnected = true;

  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(sender, 'decryptMessageData').mockResolvedValue({} as TLMessage);
  vi.spyOn(sender, '_processMessage').mockRejectedValue(new RPCError(
    errorMessage,
    new Api.Ping({ pingId: 1n }),
    401,
  ));
  vi.spyOn(sender, 'reconnect').mockImplementation(() => {
    sender.isReconnecting = true;
  });

  await sender._recvLoop();

  return updateCallback;
}

function createSender(updateCallback = vi.fn()) {
  return new MTProtoSender(new AuthKey(), {
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
    updateCallback,
    isMainSender: true,
  });
}
