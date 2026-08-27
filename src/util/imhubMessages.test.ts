import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiMessage } from '../api/types';
import type { GlobalState } from '../global/types';

const enqueueImHubOutboxEvent = vi.fn();
const BRIDGE_NULL: null = JSON.parse('null');

describe('im-hub message events', () => {
  afterEach(() => {
    enqueueImHubOutboxEvent.mockReset();
    Reflect.deleteProperty(window, 'imHubNativeBridge');
    vi.resetModules();
  });

  it('enqueues a plain outgoing message snapshot', async () => {
    mockDependencies();
    const { reportImHubMessageUpsert } = await import('./imhubMessages');

    reportImHubMessageUpsert(buildGlobal(), buildMessage());

    expect(enqueueImHubOutboxEvent).toHaveBeenCalledOnce();
    expect(enqueueImHubOutboxEvent).toHaveBeenCalledWith('self-user', {
      type: 'message.upsert',
      message: {
        platformConversationId: '-1001',
        platformMessageId: '-1001:42',
        direction: 'out',
        senderExternalId: 'self-user',
        senderDisplayName: BRIDGE_NULL,
        conversationDisplayName: BRIDGE_NULL,
        body: 'local-only-probe',
        mediaRefs: [],
        replyToPlatformMessageId: BRIDGE_NULL,
        sentAt: '2026-08-28T00:00:00.000Z',
        editedAt: BRIDGE_NULL,
        editVersion: BRIDGE_NULL,
        raw: {
          groupedId: undefined,
          isSilent: false,
          isFromScheduled: false,
          isAction: false,
        },
      },
    });
  });

  it('enqueues a delete for a final message id', async () => {
    mockDependencies();
    const { reportImHubMessageDeleted } = await import('./imhubMessages');

    reportImHubMessageDeleted(buildGlobal(), '-1001', 42);

    expect(enqueueImHubOutboxEvent).toHaveBeenCalledOnce();
    expect(enqueueImHubOutboxEvent).toHaveBeenCalledWith('self-user', {
      type: 'message.deleted',
      platformMessageId: '-1001:42',
      deletedAt: expect.any(String),
    });
  });
});

function mockDependencies() {
  vi.doMock('../global/helpers/richMessage', () => ({
    getRichMessagePreviewText: () => '',
  }));
  vi.doMock('../global/selectors', () => ({
    selectPeer: () => undefined,
  }));
  vi.doMock('./imhub', () => ({
    buildImHubTelegramMessageId: (chatId: string, messageId: number) => `${chatId}:${messageId}`,
    isImHubTranslationEnabled: () => true,
  }));
  vi.doMock('./imhubOutbox', () => ({ enqueueImHubOutboxEvent }));
  Object.defineProperty(window, 'imHubNativeBridge', {
    configurable: true,
    value: { protocolVersion: 3 },
  });
}

function buildGlobal(): GlobalState {
  return { currentUserId: 'self-user' } as unknown as GlobalState;
}

function buildMessage(): ApiMessage {
  return {
    chatId: '-1001',
    id: 42,
    isOutgoing: true,
    date: new Date('2026-08-28T00:00:00.000Z').getTime() / 1000,
    content: { text: { text: 'local-only-probe' } },
  };
}
