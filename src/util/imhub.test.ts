import { afterEach, describe, expect, test, vi } from 'vitest';

type RequestStateCommand = {
  protocolVersion: 2;
  type: 'bridge.request-state';
};

const NULL_CONTEXT: null = JSON.parse('null');

describe('im-hub native state replay', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test('replays identity and a non-negative empty-context revision', async () => {
    vi.doMock('./localization', () => ({
      getTranslationFn: () => (key: string) => key,
    }));
    const emit = vi.fn();
    let commandListener: ((command: RequestStateCommand) => void) | undefined;
    Object.defineProperty(window, 'imHubNativeBridge', {
      configurable: true,
      value: {
        protocolVersion: 2,
        emit,
        onCommand(listener: (command: RequestStateCommand) => void) {
          commandListener = listener;
        },
        translateBatch: vi.fn(),
        detectLanguage: vi.fn(),
      },
    });

    const { reportImHubAccountIdentity } = await import('./imhub');
    reportImHubAccountIdentity('123456');
    emit.mockClear();

    expect(commandListener).toBeDefined();
    commandListener?.({ protocolVersion: 2, type: 'bridge.request-state' });

    expect(emit).toHaveBeenNthCalledWith(1, {
      protocolVersion: 2,
      type: 'account.identity',
      platformAccountExternalId: '123456',
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      protocolVersion: 2,
      type: 'context.changed',
      contextRevision: 0,
      context: NULL_CONTEXT,
    });
  });
});
