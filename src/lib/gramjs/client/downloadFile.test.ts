import { afterEach, describe, expect, it, vi } from 'vitest';

import type Api from '../tl/api';
import type TelegramClient from './TelegramClient';

import { RPCError } from '../errors';
import { downloadFile } from './downloadFile';

const bandwidthManager = vi.hoisted(() => ({
  requestWorker: vi.fn().mockResolvedValue(0),
  releaseWorker: vi.fn(),
}));

vi.mock('../../../util/dcBandwithManager', () => ({
  getDcBandwidthManager: () => bandwidthManager,
}));

describe('downloadFile exported sender recovery', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('cleans up and retries a stale exported sender after AUTH_KEY_UNREGISTERED', async () => {
    vi.useFakeTimers();
    const staleSender = {
      isConnected: () => true,
      send: vi.fn().mockRejectedValue(new RPCError(
        'AUTH_KEY_UNREGISTERED',
        {} as Api.AnyRequest,
        401,
      )),
    };
    const replacementSender = {
      isConnected: () => true,
      send: vi.fn().mockResolvedValue({ bytes: Uint8Array.of(42) }),
    };
    const cleanupExportedSenders = vi.fn().mockResolvedValue(undefined);
    const client = {
      isPremium: false,
      session: { dcId: 2 },
      _log: { info: vi.fn() },
      _cleanupExportedSenders: cleanupExportedSenders,
      getSender: vi.fn()
        .mockResolvedValueOnce(staleSender)
        .mockResolvedValueOnce(replacementSender),
      releaseExportedSender: vi.fn(),
    } as unknown as TelegramClient;

    await expect(downloadFile(client, {} as Api.TypeInputFileLocation, {
      dcId: 2,
      partSizeKb: 4,
    })).resolves.toEqual(Uint8Array.of(42));

    expect(cleanupExportedSenders).toHaveBeenCalledOnce();
    expect(cleanupExportedSenders).toHaveBeenCalledWith(2);
    expect(client.getSender).toHaveBeenCalledTimes(2);
  });
});
