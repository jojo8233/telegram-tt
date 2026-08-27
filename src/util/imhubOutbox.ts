import {
  createStore, del, get, set, values,
} from 'idb-keyval';

type ImHubMediaRef = {
  kind: 'image' | 'video' | 'audio' | 'file' | 'sticker';
  remoteId: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type ImHubMessageSnapshot = {
  platformConversationId: string;
  platformMessageId: string;
  direction: 'in' | 'out';
  senderExternalId: string;
  senderDisplayName: string | null;
  conversationDisplayName: string | null;
  body: string;
  mediaRefs: ImHubMediaRef[];
  replyToPlatformMessageId: string | null;
  sentAt: string;
  editedAt: string | null;
  editVersion: number | null;
  raw: Record<string, unknown>;
};

export type ImHubOutboxEventInput = {
  type: 'message.upsert';
  message: ImHubMessageSnapshot;
} | {
  type: 'message.deleted';
  platformMessageId: string;
  deletedAt: string;
} | {
  type: 'message.id-remapped';
  oldPlatformMessageId: string;
  newPlatformMessageId: string;
};

type ImHubMessageEvent = ImHubOutboxEventInput & {
  protocolVersion: 3;
  eventId: string;
};

export type ImHubOutboxBridgeEvent = ImHubMessageEvent | {
  protocolVersion: 3;
  type: 'outbox.status';
  pendingCount: number;
  deadLetterCount: number;
  isSending: boolean;
  lastErrorCode: string | null;
};

type StoredOutboxEvent = {
  storageKey: string;
  accountExternalId: string;
  event: ImHubMessageEvent;
  createdAt: number;
  attemptCount: number;
  nextAttemptAt: number;
};

type DeadLetterEvent = StoredOutboxEvent & {
  failedAt: number;
  errorCode: string;
};

type EmitOutboxEvent = (event: ImHubOutboxBridgeEvent) => void;

const OUTBOX_STORE = createStore('tt-imhub-outbox-pending', 'events');
const DEAD_LETTER_STORE = createStore('tt-imhub-outbox-dead-letter', 'events');
const MAX_PENDING_EVENTS = 1_000;
const MAX_DEAD_LETTER_EVENTS = 1_000;
const ACK_TIMEOUT_MS = 10_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;
const SEND_INTERVAL_MS = 100;
const BRIDGE_NULL: null = JSON.parse('null');

let activeAccountExternalId: string | undefined;
let emitOutboxEvent: EmitOutboxEvent | undefined;
let activeEventId: string | undefined;
let pumpTimer: ReturnType<typeof setTimeout> | undefined;
let ackTimer: ReturnType<typeof setTimeout> | undefined;
// IndexedDB 等待期间的新调度只记录请求，始终保持单一发送协程。
let isPumping = false;
let requestedPumpDelay: number | undefined;
let lastErrorCode: string | undefined;
let storageQueue = Promise.resolve<unknown>(undefined);

export function activateImHubOutbox(
  accountExternalId: string,
  emit: EmitOutboxEvent,
): void {
  if (activeAccountExternalId !== accountExternalId) {
    resetDeliveryState();
    lastErrorCode = undefined;
  }
  activeAccountExternalId = accountExternalId;
  emitOutboxEvent = emit;
  void reportImHubOutboxStatus();
  schedulePump(0);
}

export function deactivateImHubOutbox(): void {
  activeAccountExternalId = undefined;
  emitOutboxEvent = undefined;
  lastErrorCode = undefined;
  resetDeliveryState();
}

export function replayImHubOutbox(): void {
  void reportImHubOutboxStatus();
  schedulePump(0);
}

export function enqueueImHubOutboxEvent(
  accountExternalId: string,
  input: ImHubOutboxEventInput,
): void {
  void queueStorageOperation(async () => {
    const eventId = await buildEventId(accountExternalId, input);
    const storageKey = buildStorageKey(accountExternalId, eventId);
    if (await get<StoredOutboxEvent>(storageKey, OUTBOX_STORE)
      || await get<DeadLetterEvent>(storageKey, DEAD_LETTER_STORE)) return;

    const event: ImHubMessageEvent = {
      ...input,
      protocolVersion: 3,
      eventId,
    };
    const pending = await listPendingEvents(accountExternalId);
    const lastCreatedAt = pending.at(-1)?.createdAt ?? 0;
    const record: StoredOutboxEvent = {
      storageKey,
      accountExternalId,
      event,
      // IndexedDB values() 对相同时间戳没有业务顺序保证；用单调时间确保
      // local upsert -> remap -> final upsert 即使同一毫秒入队也保持顺序。
      createdAt: Math.max(Date.now(), lastCreatedAt + 1),
      attemptCount: 0,
      nextAttemptAt: 0,
    };
    if (pending.length >= MAX_PENDING_EVENTS) {
      const stored = await storeDeadLetter(record, 'outbox_capacity');
      lastErrorCode = stored ? 'outbox_capacity' : 'dead_letter_capacity';
      return;
    }
    await set(storageKey, record, OUTBOX_STORE);
  }).then(() => {
    void reportImHubOutboxStatus();
    schedulePump(0);
  }).catch(() => {
    lastErrorCode = 'outbox_storage_failed';
    void reportImHubOutboxStatus();
  });
}

export function acknowledgeImHubOutboxEvent(
  eventId: string,
  accepted: boolean,
  retryable: boolean,
): void {
  const accountExternalId = activeAccountExternalId;
  if (!accountExternalId) return;
  const storageKey = buildStorageKey(accountExternalId, eventId);

  void queueStorageOperation(async () => {
    const record = await get<StoredOutboxEvent>(storageKey, OUTBOX_STORE);
    if (!record) return;
    if (accepted) {
      await del(storageKey, OUTBOX_STORE);
      lastErrorCode = undefined;
      return;
    }
    if (retryable) {
      record.nextAttemptAt = Date.now() + calculateRetryDelay(record.attemptCount);
      await set(storageKey, record, OUTBOX_STORE);
      lastErrorCode = 'retryable_rejection';
      return;
    }
    const stored = await storeDeadLetter(record, 'permanent_rejection');
    if (stored) {
      await del(storageKey, OUTBOX_STORE);
      lastErrorCode = 'permanent_rejection';
      return;
    }
    // dead-letter 已满时宁可保留 pending 证据，也不把永久失败事件静默丢掉。
    // 此容量故障会暂时阻塞账号内严格有序发送，等待运维清理 dead-letter。
    record.nextAttemptAt = Date.now() + RETRY_MAX_DELAY_MS;
    await set(storageKey, record, OUTBOX_STORE);
    lastErrorCode = 'dead_letter_capacity';
  }).then(() => {
    if (activeEventId === eventId) resetActiveEvent();
    void reportImHubOutboxStatus();
    schedulePump(SEND_INTERVAL_MS);
  }).catch(() => {
    lastErrorCode = 'outbox_storage_failed';
    if (activeEventId === eventId) resetActiveEvent();
    void reportImHubOutboxStatus();
    schedulePump(RETRY_BASE_DELAY_MS);
  });
}

function schedulePump(delay: number): void {
  if (!activeAccountExternalId || !emitOutboxEvent) return;
  if (activeEventId || isPumping) {
    requestedPumpDelay = requestedPumpDelay === undefined
      ? delay
      : Math.min(requestedPumpDelay, delay);
    return;
  }
  if (pumpTimer) clearTimeout(pumpTimer);
  requestedPumpDelay = undefined;
  pumpTimer = setTimeout(() => {
    pumpTimer = undefined;
    void pumpOutbox();
  }, delay);
}

async function pumpOutbox(): Promise<void> {
  const accountExternalId = activeAccountExternalId;
  const emit = emitOutboxEvent;
  if (!accountExternalId || !emit || activeEventId || isPumping) return;
  isPumping = true;

  try {
    const now = Date.now();
    const pending = await queueStorageOperation(() => listPendingEvents(accountExternalId));
    if (!pending.length) {
      void reportImHubOutboxStatus();
      return;
    }
    const record = pending[0];
    if (record.nextAttemptAt > now) {
      schedulePump(record.nextAttemptAt - now);
      return;
    }

    record.attemptCount += 1;
    record.nextAttemptAt = now + calculateRetryDelay(record.attemptCount);
    await queueStorageOperation(() => set(record.storageKey, record, OUTBOX_STORE));
    if (activeAccountExternalId !== accountExternalId || emitOutboxEvent !== emit) return;

    activeEventId = record.event.eventId;
    emit(record.event);
    ackTimer = setTimeout(() => {
      lastErrorCode = 'ack_timeout';
      resetActiveEvent();
      void reportImHubOutboxStatus();
      schedulePump(0);
    }, ACK_TIMEOUT_MS);
    void reportImHubOutboxStatus();
  } catch {
    lastErrorCode = 'outbox_delivery_failed';
    resetActiveEvent();
    void reportImHubOutboxStatus();
    schedulePump(RETRY_BASE_DELAY_MS);
  } finally {
    isPumping = false;
    if (requestedPumpDelay !== undefined && !activeEventId) schedulePump(requestedPumpDelay);
  }
}

async function reportImHubOutboxStatus(): Promise<void> {
  const accountExternalId = activeAccountExternalId;
  const emit = emitOutboxEvent;
  if (!accountExternalId || !emit) return;
  try {
    const [pending, deadLetters] = await Promise.all([
      queueStorageOperation(() => listPendingEvents(accountExternalId)),
      queueStorageOperation(() => listDeadLetters(accountExternalId)),
    ]);
    if (activeAccountExternalId !== accountExternalId || emitOutboxEvent !== emit) return;
    emit({
      protocolVersion: 3,
      type: 'outbox.status',
      pendingCount: pending.length,
      deadLetterCount: deadLetters.length,
      isSending: activeEventId !== undefined,
      lastErrorCode: lastErrorCode ?? BRIDGE_NULL,
    });
  } catch {
    if (activeAccountExternalId !== accountExternalId || emitOutboxEvent !== emit) return;
    emit({
      protocolVersion: 3,
      type: 'outbox.status',
      pendingCount: 0,
      deadLetterCount: 0,
      isSending: false,
      lastErrorCode: 'outbox_storage_failed',
    });
  }
}

function resetDeliveryState(): void {
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = undefined;
  requestedPumpDelay = undefined;
  resetActiveEvent();
}

function resetActiveEvent(): void {
  if (ackTimer) clearTimeout(ackTimer);
  ackTimer = undefined;
  activeEventId = undefined;
}

function calculateRetryDelay(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 10);
  return Math.min(RETRY_BASE_DELAY_MS * (2 ** exponent), RETRY_MAX_DELAY_MS);
}

async function buildEventId(accountExternalId: string, input: ImHubOutboxEventInput): Promise<string> {
  const upsertRevision = input.type === 'message.upsert'
    ? input.message.editVersion ?? (input.message.editedAt ? `edited:${input.message.editedAt}` : 'base')
    : undefined;
  const identity = input.type === 'message.upsert'
    ? `${input.type}:${input.message.platformMessageId}:${upsertRevision}`
    : input.type === 'message.deleted'
      ? `${input.type}:${input.platformMessageId}`
      : `${input.type}:${input.oldPlatformMessageId}:${input.newPlatformMessageId}`;
  const bytes = new TextEncoder().encode(`${accountExternalId}:${identity}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `tg-${hash.slice(0, 32)}`;
}

function buildStorageKey(accountExternalId: string, eventId: string): string {
  return `${accountExternalId}:${eventId}`;
}

async function listPendingEvents(accountExternalId: string): Promise<StoredOutboxEvent[]> {
  const records = await values<StoredOutboxEvent>(OUTBOX_STORE);
  return records
    .filter((record) => record.accountExternalId === accountExternalId)
    .sort((first, second) => first.createdAt - second.createdAt);
}

async function listDeadLetters(accountExternalId: string): Promise<DeadLetterEvent[]> {
  const records = await values<DeadLetterEvent>(DEAD_LETTER_STORE);
  return records.filter((record) => record.accountExternalId === accountExternalId);
}

async function storeDeadLetter(record: StoredOutboxEvent, errorCode: string): Promise<boolean> {
  if (await get<DeadLetterEvent>(record.storageKey, DEAD_LETTER_STORE)) return true;
  const deadLetters = await listDeadLetters(record.accountExternalId);
  if (deadLetters.length >= MAX_DEAD_LETTER_EVENTS) {
    lastErrorCode = 'dead_letter_capacity';
    return false;
  }
  await set(record.storageKey, {
    ...record,
    failedAt: Date.now(),
    errorCode,
  } satisfies DeadLetterEvent, DEAD_LETTER_STORE);
  return true;
}

function queueStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(operation, operation);
  storageQueue = result.then(() => undefined, () => undefined);
  return result;
}
