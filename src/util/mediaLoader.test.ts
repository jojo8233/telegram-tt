import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callApi: vi.fn(),
  serviceWorkerListener: undefined as ((event: MessageEvent) => Promise<void>) | undefined,
  postMessage: vi.fn(),
}));

vi.mock('../api/gramjs', () => ({
  callApi: mocks.callApi,
  cancelApiProgress: vi.fn(),
}));

vi.mock('./browser/windowEnvironment', () => ({
  IS_OPUS_SUPPORTED: true,
  IS_PROGRESSIVE_SUPPORTED: true,
}));

vi.mock('./cacheApi', () => ({
  Type: {
    Text: 0,
    Blob: 1,
  },
  fetch: vi.fn(),
  remove: vi.fn(),
  save: vi.fn(),
}));

vi.mock('./files', () => ({ fetchBlob: vi.fn() }));
vi.mock('./multiaccount', () => ({ ACCOUNT_SLOT: undefined }));
vi.mock('./oggToWav', () => ({ oggToWav: vi.fn() }));

describe('progressive media loading', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.serviceWorkerListener = undefined;
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => Promise<void>) => {
          if (type === 'message') mocks.serviceWorkerListener = listener;
        }),
        controller: { postMessage: mocks.postMessage },
      },
    });
    await import('./mediaLoader');
  });

  it('silently ends a progressive part canceled by the media sender', async () => {
    mocks.callApi.mockRejectedValue({ message: 'USER_CANCELED' });

    await expect(mocks.serviceWorkerListener?.({
      data: {
        type: 'requestPart',
        messageId: 'part-1',
        params: { url: 'document1', start: 0, end: 1023 },
      },
    } as MessageEvent)).resolves.toBeUndefined();

    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('still propagates an unexpected progressive media error', async () => {
    const error = { message: 'NETWORK_FAILED' };
    mocks.callApi.mockRejectedValue(error);

    await expect(mocks.serviceWorkerListener?.({
      data: {
        type: 'requestPart',
        messageId: 'part-2',
        params: { url: 'document2', start: 0, end: 1023 },
      },
    } as MessageEvent)).rejects.toBe(error);

    expect(mocks.postMessage).not.toHaveBeenCalled();
  });
});
