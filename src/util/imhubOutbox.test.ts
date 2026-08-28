import 'fake-indexeddb/auto';

import {
  clear, createStore, setMany, values,
} from 'idb-keyval';
import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';

const PENDING_STORE = createStore('tt-imhub-outbox-pending', 'events');
const DEAD_LETTER_STORE = createStore('tt-imhub-outbox-dead-letter', 'events');
const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';

type LoadedOutbox = typeof import('./imhubOutbox');

let loadedOutbox: LoadedOutbox | undefined;

function storedEvent(accountExternalId: string, index: number, nextAttemptAt = 0) {
  const eventId = `event-${accountExternalId}-${index}`;
  const storageKey = `${accountExternalId}:${eventId}`;
  return {
    storageKey,
    accountExternalId,
    event: {
      protocolVersion: 3,
      type: 'message.id-remapped',
      eventId,
      oldPlatformMessageId: `-1001:temp:telegram-tt:${index + 1}.5`,
      newPlatformMessageId: `-1001:${index + 1}`,
    },
    createdAt: index + 1,
    attemptCount: 0,
    nextAttemptAt,
  };
}

function deadLetter(accountExternalId: string, index: number) {
  return {
    ...storedEvent(accountExternalId, index),
    failedAt: index + 10,
    errorCode: 'permanent_rejection',
  };
}

async function loadOutbox(): Promise<LoadedOutbox> {
  loadedOutbox = await import('./imhubOutbox');
  return loadedOutbox;
}

beforeEach(async () => {
  vi.resetModules();
  await Promise.all([clear(PENDING_STORE), clear(DEAD_LETTER_STORE)]);
});

afterEach(async () => {
  loadedOutbox?.deactivateImHubOutbox();
  loadedOutbox = undefined;
  await Promise.all([clear(PENDING_STORE), clear(DEAD_LETTER_STORE)]);
});

describe('im-hub outbox capacity recovery', () => {
  test('pending 满时把新事件保留为 outbox_capacity dead-letter', async () => {
    await setMany(Array.from({ length: 1_000 }, (_, index) => {
      const record = storedEvent(ACCOUNT_A, index, Date.now() + 60_000);
      return [record.storageKey, record] as const;
    }), PENDING_STORE);
    const outbox = await loadOutbox();

    outbox.enqueueImHubOutboxEvent(ACCOUNT_A, {
      type: 'message.id-remapped',
      oldPlatformMessageId: '-1001:temp:telegram-tt:1001.5',
      newPlatformMessageId: '-1001:1001',
    });

    await vi.waitFor(async () => {
      const deadLetters = await values<Record<string, unknown>>(DEAD_LETTER_STORE);
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]).toMatchObject({
        accountExternalId: ACCOUNT_A,
        errorCode: 'outbox_capacity',
      });
    });
    await expect(values(PENDING_STORE)).resolves.toHaveLength(1_000);
  });

  test('dead-letter 满时保留永久拒绝的 pending，明确清除后立即唤醒队首', async () => {
    await setMany(Array.from({ length: 1_000 }, (_, index) => {
      const record = deadLetter(ACCOUNT_A, index);
      return [record.storageKey, record] as const;
    }), DEAD_LETTER_STORE);
    const pending = storedEvent(ACCOUNT_A, 2_000);
    await setMany([[pending.storageKey, pending]], PENDING_STORE);
    const emit = vi.fn();
    const outbox = await loadOutbox();
    outbox.activateImHubOutbox(ACCOUNT_A, emit);

    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventId: pending.event.eventId }));
    });
    outbox.acknowledgeImHubOutboxEvent(pending.event.eventId, false, false);

    await vi.waitFor(async () => {
      await expect(values(PENDING_STORE)).resolves.toHaveLength(1);
      await expect(values(DEAD_LETTER_STORE)).resolves.toHaveLength(1_000);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: 'outbox.status',
        pendingCount: 1,
        deadLetterCount: 1_000,
        lastErrorCode: 'dead_letter_capacity',
      }));
    });

    emit.mockClear();
    await expect(outbox.discardImHubDeadLetters()).resolves.toBe(1_000);
    await expect(values(DEAD_LETTER_STORE)).resolves.toHaveLength(0);
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventId: pending.event.eventId }));
    });
  });

  test('重试只移动当前账号且不超过 pending 容量', async () => {
    await setMany(Array.from({ length: 999 }, (_, index) => {
      const record = storedEvent(ACCOUNT_A, index, Date.now() + 60_000);
      return [record.storageKey, record] as const;
    }), PENDING_STORE);
    const accountADead = [deadLetter(ACCOUNT_A, 1_100), deadLetter(ACCOUNT_A, 1_101)];
    const accountBDead = deadLetter(ACCOUNT_B, 1_200);
    await setMany([...accountADead, accountBDead].map((record) => [record.storageKey, record]), DEAD_LETTER_STORE);
    const emit = vi.fn();
    const outbox = await loadOutbox();
    outbox.activateImHubOutbox(ACCOUNT_A, emit);

    await expect(outbox.retryImHubDeadLetters()).resolves.toBe(1);

    const pending = await values<{ accountExternalId: string }>(PENDING_STORE);
    const deadLetters = await values<{ accountExternalId: string }>(DEAD_LETTER_STORE);
    expect(pending.filter((record) => record.accountExternalId === ACCOUNT_A)).toHaveLength(1_000);
    expect(deadLetters.filter((record) => record.accountExternalId === ACCOUNT_A)).toHaveLength(1);
    expect(deadLetters.filter((record) => record.accountExternalId === ACCOUNT_B)).toHaveLength(1);
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: 'outbox.status',
        pendingCount: 1_000,
        deadLetterCount: 1,
        lastErrorCode: 'dead_letter_retry_partial',
      }));
    });
  });
});
