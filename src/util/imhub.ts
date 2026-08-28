import type { ImHubOutboxBridgeEvent } from './imhubOutbox';

import {
  acknowledgeImHubOutboxEvent,
  activateImHubOutbox,
  deactivateImHubOutbox,
  discardImHubDeadLetters,
  replayImHubOutbox,
  retryImHubDeadLetters,
} from './imhubOutbox';
import { getTranslationFn } from './localization';

/**
 * 与 im-hub 服务端的对接层。
 *
 * 这是本 fork 相对上游新增的文件之一。所有对 im-hub 的调用都收在这里，
 * 跟上游合并时冲突面最小——上游改不到这个文件，我们也尽量不把逻辑散进
 * 上游原有的文件里。
 *
 * Electron webview preload 只暴露 typed bridge。页面拿不到服务端地址、用户 JWT、
 * control grant 或任意 IPC；翻译请求由主进程按 partition 与实际登录身份代理。
 */

interface BatchResult {
  translated: string;
  detectedLang: string;
  provider: string;
  failed: boolean;
}

type ImHubComposerCommand = {
  protocolVersion: 3;
  requestId: string;
  contextRevision: number;
  platformConversationId: string;
} & ({
  type: 'composer.set-draft';
  text: string;
} | {
  type: 'composer.get-draft';
} | {
  type: 'composer.send';
  attemptId: string;
});

type ImHubHostCommand = ImHubComposerCommand | {
  protocolVersion: 3;
  type: 'bridge.request-state';
} | {
  protocolVersion: 3;
  type: 'event.ack';
  eventId: string;
  accepted: boolean;
  retryable: boolean;
} | {
  protocolVersion: 3;
  type: 'outbox.retry-dead-letters';
} | {
  protocolVersion: 3;
  type: 'outbox.discard-dead-letters';
};

type ImHubGuestEvent = ImHubOutboxBridgeEvent | {
  protocolVersion: 3;
  type: 'bridge.ready' | 'account.signed-out';
} | {
  protocolVersion: 3;
  type: 'account.identity';
  platformAccountExternalId: string;
} | {
  protocolVersion: 3;
  type: 'context.changed';
  contextRevision: number;
  context: {
    platformConversationId: string;
    contactExternalId: string;
    contactDisplayName: string | null;
  } | null;
} | {
  protocolVersion: 3;
  type: 'composer.state';
  contextRevision: number;
  platformConversationId: string;
  draft: string;
  canSend: boolean;
} | {
  protocolVersion: 3;
  type: 'command.result';
  requestId: string;
  command: ImHubComposerCommand['type'];
  contextRevision: number;
  ok: boolean;
  attemptId?: string;
  draft?: string;
  platformMessageId?: string;
  error?: {
    code: string;
    message: string;
  };
};

interface ImHubNativeBridge {
  protocolVersion: number;
  emit(event: ImHubGuestEvent): void;
  onCommand(listener: (command: ImHubHostCommand) => void): void;
  translateBatch(input: {
    texts: string[];
    targetLang: string;
    sourceLang?: string;
  }): Promise<BatchResult[] | undefined>;
  detectLanguage(text: string): Promise<string | undefined>;
}

const TELEGRAM_SERVER_MESSAGE_ID_MAX = 2_147_483_647;
const TELEGRAM_CHAT_ID_MIN = -(1n << 63n);
const TELEGRAM_CHAT_ID_MAX = (1n << 63n) - 1n;
const CANONICAL_INTEGER = /^-?(?:0|[1-9]\d*)$/;
const CANONICAL_LOCAL_ID = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const NEGATIVE_ZERO = /^-0(?:\.0+)?$/;
const TEMP_MESSAGE_INSTANCE_ID = crypto.randomUUID().replaceAll('-', '');
const TEMP_MESSAGE_INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SEND_ATTEMPT_SEAL_DELAY_MS = 250;
const MAX_COMPLETED_SEND_ATTEMPTS = 100;
// Bridge v3 的 JSON 协议用 `null` 明确表示没有会话或展示名。
const BRIDGE_NULL: null = JSON.parse('null');

export type ImHubTelegramMessageId = {
  chatId: string;
} & ({
  kind: 'server';
  serverMessageId: string;
} | {
  kind: 'temporary';
  source: 'telegram-tt';
  instanceId?: string;
  localMessageId: string;
});

function normalizeTelegramChatId(chatId: string): string {
  if (!CANONICAL_INTEGER.test(chatId)) throw new Error('Telegram chat id 格式无效');
  const value = BigInt(chatId);
  if (value === 0n || value < TELEGRAM_CHAT_ID_MIN || value > TELEGRAM_CHAT_ID_MAX) {
    throw new Error('Telegram chat id 超出范围');
  }
  const normalized = value.toString();
  if (normalized !== chatId) throw new Error('Telegram chat id 不是规范十进制');
  return normalized;
}

/**
 * telegram-tt 的服务器消息 id 就是 MTProto int32；本地回显则使用小数 id。
 * im-hub 以 chatId:serverMessageId 去重，本地 id 必须进入独立命名空间，等
 * updateMessageSendSucceeded 到达后再 remap。页面实例 id 隔离会在重载后复用的
 * telegram-tt 本地计数器，不能只靠小数 local id 标识消息。
 */
export function buildImHubTelegramMessageId(chatId: string, messageId: number): string {
  const normalizedChatId = normalizeTelegramChatId(chatId);
  if (Number.isSafeInteger(messageId) && messageId > 0) {
    if (messageId > TELEGRAM_SERVER_MESSAGE_ID_MAX) throw new Error('Telegram message id 超出范围');
    return `${normalizedChatId}:${messageId}`;
  }

  if (!Number.isFinite(messageId) || Math.abs(messageId) > Number.MAX_SAFE_INTEGER) {
    throw new Error('Telegram 本地 message id 无效');
  }
  const localMessageId = String(messageId);
  if (!CANONICAL_LOCAL_ID.test(localMessageId) || NEGATIVE_ZERO.test(localMessageId)) {
    throw new Error('Telegram 本地 message id 格式无效');
  }
  return `${normalizedChatId}:temp:telegram-tt:${TEMP_MESSAGE_INSTANCE_ID}:${localMessageId}`;
}

export function parseImHubTelegramMessageId(messageId: string): ImHubTelegramMessageId | undefined {
  const parts = messageId.split(':');
  try {
    if (parts.length === 2) {
      const [rawChatId, rawServerMessageId] = parts;
      if (!rawChatId || !rawServerMessageId || !CANONICAL_INTEGER.test(rawServerMessageId)) return undefined;
      const serverMessageId = Number(rawServerMessageId);
      if (!Number.isSafeInteger(serverMessageId)
        || serverMessageId <= 0
        || serverMessageId > TELEGRAM_SERVER_MESSAGE_ID_MAX) return undefined;
      const chatId = normalizeTelegramChatId(rawChatId);
      if (`${chatId}:${serverMessageId}` !== messageId) return undefined;
      return { chatId, kind: 'server', serverMessageId: String(serverMessageId) };
    }

    if (parts.length === 4 && parts[1] === 'temp' && parts[2] === 'telegram-tt') {
      const [rawChatId, , , localMessageId] = parts;
      if (!rawChatId
        || !localMessageId
        || !CANONICAL_LOCAL_ID.test(localMessageId)
        || NEGATIVE_ZERO.test(localMessageId)) return undefined;
      const chatId = normalizeTelegramChatId(rawChatId);
      if (`${chatId}:temp:telegram-tt:${localMessageId}` !== messageId) return undefined;
      return { chatId, kind: 'temporary', source: 'telegram-tt', localMessageId };
    }

    if (parts.length === 5 && parts[1] === 'temp' && parts[2] === 'telegram-tt') {
      const [rawChatId, , , instanceId, localMessageId] = parts;
      if (!rawChatId
        || !instanceId
        || !TEMP_MESSAGE_INSTANCE_ID_PATTERN.test(instanceId)
        || !localMessageId
        || !CANONICAL_LOCAL_ID.test(localMessageId)
        || NEGATIVE_ZERO.test(localMessageId)) return undefined;
      const chatId = normalizeTelegramChatId(rawChatId);
      if (`${chatId}:temp:telegram-tt:${instanceId}:${localMessageId}` !== messageId) return undefined;
      return {
        chatId, kind: 'temporary', source: 'telegram-tt', instanceId, localMessageId,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

declare global {
  interface Window {
    imHubNativeBridge?: ImHubNativeBridge;
  }
}

export interface ImHubComposerBridge {
  platformConversationId: string;
  contactExternalId: string;
  contactDisplayName?: string;
  setDraft(text: string): void;
  getDraft(): string;
  canSend(): boolean;
  send(attemptId: string, canContinue: () => boolean): Promise<boolean>;
}

type ImHubSendLocalResult = {
  status: 'pending' | 'succeeded' | 'failed';
  platformMessageId?: string;
};

type ImHubSendResult = {
  ok: true;
  platformMessageId: string;
} | {
  ok: false;
  code: string;
  message: string;
};

type ImHubSendAttempt = {
  attemptId: string;
  contextRevision: number;
  platformConversationId: string;
  chatId: string;
  commands: Map<string, ImHubComposerCommand & { type: 'composer.send' }>;
  localResults: Map<string, ImHubSendLocalResult>;
  isSealed: boolean;
  result?: ImHubSendResult;
};

let composerBridge: ImHubComposerBridge | undefined;
// 空会话也是一个可重放的有效状态；宿主协议不接受负 revision。
let contextRevision = 0;
let registeredNativeBridge: ImHubNativeBridge | undefined;
const sendAttempts = new Map<string, ImHubSendAttempt>();
const sendAttemptIdByLocalMessage = new Map<string, string>();

export function registerImHubComposerBridge(bridge: ImHubComposerBridge): () => void {
  ensureImHubCommandListener();
  composerBridge = bridge;
  contextRevision += 1;
  reportImHubContext();
  reportImHubComposerState();

  return () => {
    if (composerBridge !== bridge) return;
    composerBridge = undefined;
    contextRevision += 1;
    reportImHubContext();
  };
}

export function reportImHubComposerState(): void {
  const bridge = getImHubBridge();
  const composer = composerBridge;
  if (!bridge || !composer) return;
  bridge.emit({
    protocolVersion: 3,
    type: 'composer.state',
    contextRevision,
    platformConversationId: composer.platformConversationId,
    draft: composer.getDraft(),
    canSend: composer.canSend(),
  });
}

function getImHubBridge(): ImHubNativeBridge | undefined {
  const bridge = window.imHubNativeBridge;
  return bridge?.protocolVersion === 3 ? bridge : undefined;
}

let reportedPlatformAccountExternalId: string | undefined;

export function isImHubTranslationEnabled(): boolean {
  return getImHubBridge() !== undefined;
}

export function reportImHubAccountIdentity(currentUserId?: string): void {
  const bridge = getImHubBridge();
  if (!bridge) return;
  ensureImHubCommandListener();
  bridge.emit({ protocolVersion: 3, type: 'bridge.ready' });
  if (currentUserId) {
    // 上游运行时来源可能并非严格遵守声明类型；跨 IPC 前统一成字符串。
    const externalId = String(currentUserId);
    reportedPlatformAccountExternalId = externalId;
    activateImHubOutbox(externalId, (event) => bridge.emit(event));
    bridge.emit({
      protocolVersion: 3,
      type: 'account.identity',
      platformAccountExternalId: externalId,
    });
  } else if (reportedPlatformAccountExternalId !== undefined) {
    reportedPlatformAccountExternalId = undefined;
    deactivateImHubOutbox();
    bridge.emit({ protocolVersion: 3, type: 'account.signed-out' });
  }
}

export function registerImHubSendLocalMessage(
  attemptId: string,
  chatId: string,
  localMessageId: number,
): void {
  const attempt = sendAttempts.get(attemptId);
  if (!attempt || attempt.result || attempt.chatId !== chatId) return;
  const localKey = buildImHubLocalMessageKey(chatId, localMessageId);
  if (attempt.localResults.has(localKey)) return;
  attempt.localResults.set(localKey, { status: 'pending' });
  sendAttemptIdByLocalMessage.set(localKey, attemptId);
}

export function resolveImHubSendLocalMessage(
  chatId: string,
  localMessageId: number,
  finalMessageId: number,
): void {
  const localKey = buildImHubLocalMessageKey(chatId, localMessageId);
  const attemptId = sendAttemptIdByLocalMessage.get(localKey);
  const attempt = attemptId ? sendAttempts.get(attemptId) : undefined;
  if (!attempt || attempt.result) return;
  try {
    attempt.localResults.set(localKey, {
      status: 'succeeded',
      platformMessageId: buildImHubTelegramMessageId(chatId, finalMessageId),
    });
  } catch {
    attempt.localResults.set(localKey, { status: 'failed' });
  }
  settleImHubSendAttempt(attempt);
}

export function rejectImHubSendLocalMessage(chatId: string, localMessageId: number): void {
  const localKey = buildImHubLocalMessageKey(chatId, localMessageId);
  const attemptId = sendAttemptIdByLocalMessage.get(localKey);
  const attempt = attemptId ? sendAttempts.get(attemptId) : undefined;
  if (!attempt || attempt.result) return;
  attempt.localResults.set(localKey, { status: 'failed' });
  settleImHubSendAttempt(attempt);
}

export function sealImHubSendAttempt(attemptId: string): void {
  const attempt = sendAttempts.get(attemptId);
  if (!attempt || attempt.result || attempt.isSealed) return;
  setTimeout(() => {
    if (attempt.result) return;
    attempt.isSealed = true;
    settleImHubSendAttempt(attempt);
  }, SEND_ATTEMPT_SEAL_DELAY_MS);
}

function ensureImHubCommandListener(): void {
  const bridge = getImHubBridge();
  if (!bridge || registeredNativeBridge === bridge) return;
  registeredNativeBridge = bridge;
  bridge.onCommand((command) => {
    if (command.type === 'bridge.request-state') {
      if (reportedPlatformAccountExternalId) {
        bridge.emit({
          protocolVersion: 3,
          type: 'account.identity',
          platformAccountExternalId: reportedPlatformAccountExternalId,
        });
      }
      reportImHubContext();
      reportImHubComposerState();
      replayImHubOutbox();
      return;
    }
    if (command.type === 'event.ack') {
      acknowledgeImHubOutboxEvent(command.eventId, command.accepted, command.retryable);
      return;
    }
    if (command.type === 'outbox.retry-dead-letters') {
      void retryImHubDeadLetters();
      return;
    }
    if (command.type === 'outbox.discard-dead-letters') {
      void discardImHubDeadLetters();
      return;
    }
    void handleImHubComposerCommand(command);
  });
}

async function handleImHubComposerCommand(command: ImHubComposerCommand): Promise<void> {
  const bridge = getImHubBridge();
  const composer = composerBridge;
  if (!bridge) return;
  if (!composer
    || command.contextRevision !== contextRevision
    || command.platformConversationId !== composer.platformConversationId) {
    reportImHubCommandFailure(command, 'stale_context');
    return;
  }

  if (command.type === 'composer.set-draft') {
    composer.setDraft(command.text);
    reportImHubCommandSuccess(command);
    reportImHubComposerState();
    return;
  }
  if (command.type === 'composer.get-draft') {
    reportImHubCommandSuccess(command, { draft: composer.getDraft() });
    return;
  }
  await handleImHubSendCommand(command, composer);
}

async function handleImHubSendCommand(
  command: ImHubComposerCommand & { type: 'composer.send' },
  composer: ImHubComposerBridge,
): Promise<void> {
  const existing = sendAttempts.get(command.attemptId);
  if (existing) {
    if (existing.contextRevision !== command.contextRevision
      || existing.platformConversationId !== command.platformConversationId) {
      reportImHubCommandFailure(command, 'attempt_context_mismatch');
      return;
    }
    existing.commands.set(command.requestId, command);
    if (existing.result) reportImHubSendResult(command, existing.result);
    return;
  }

  if (!composer.canSend()) {
    reportImHubCommandFailure(command, 'composer_not_sendable');
    return;
  }

  const attempt: ImHubSendAttempt = {
    attemptId: command.attemptId,
    contextRevision: command.contextRevision,
    platformConversationId: command.platformConversationId,
    chatId: composer.platformConversationId,
    commands: new Map([[command.requestId, command]]),
    localResults: new Map(),
    isSealed: false,
  };
  sendAttempts.set(command.attemptId, attempt);

  try {
    const wasStarted = await composer.send(command.attemptId, () => (
      composerBridge === composer
      && contextRevision === command.contextRevision
      && composer.platformConversationId === command.platformConversationId
      && composer.canSend()
    ));
    if (!wasStarted) {
      completeImHubSendAttempt(attempt, {
        ok: false,
        code: 'send_not_started',
        message: getImHubBridgeErrorMessage('send_not_started'),
      });
    }
  } catch {
    completeImHubSendAttempt(attempt, {
      ok: false,
      code: 'send_failed',
      message: getImHubBridgeErrorMessage('send_failed'),
    });
  }
}

function reportImHubContext(): void {
  const bridge = getImHubBridge();
  if (!bridge) return;
  const composer = composerBridge;
  bridge.emit({
    protocolVersion: 3,
    type: 'context.changed',
    contextRevision,
    context: composer ? {
      platformConversationId: composer.platformConversationId,
      contactExternalId: composer.contactExternalId,
      contactDisplayName: composer.contactDisplayName ?? BRIDGE_NULL,
    } : BRIDGE_NULL,
  });
}

function reportImHubCommandSuccess(
  command: ImHubComposerCommand,
  extra: { draft?: string } = {},
): void {
  getImHubBridge()?.emit({
    protocolVersion: 3,
    type: 'command.result',
    requestId: command.requestId,
    command: command.type,
    contextRevision: command.contextRevision,
    ok: true,
    ...extra,
  });
}

function reportImHubCommandFailure(command: ImHubComposerCommand, code: string): void {
  getImHubBridge()?.emit({
    protocolVersion: 3,
    type: 'command.result',
    requestId: command.requestId,
    command: command.type,
    contextRevision: command.contextRevision,
    ok: false,
    attemptId: command.type === 'composer.send' ? command.attemptId : undefined,
    error: { code, message: getImHubBridgeErrorMessage(code) },
  });
}

function settleImHubSendAttempt(attempt: ImHubSendAttempt): void {
  if (!attempt.isSealed || attempt.result) return;
  const localResults = Array.from(attempt.localResults.values());
  if (!localResults.length) {
    completeImHubSendAttempt(attempt, {
      ok: false,
      code: 'send_not_started',
      message: getImHubBridgeErrorMessage('send_not_started'),
    });
    return;
  }
  if (localResults.some(({ status }) => status === 'pending')) return;

  const succeeded = localResults.filter(
    (result): result is ImHubSendLocalResult & { platformMessageId: string } => (
      result.status === 'succeeded' && Boolean(result.platformMessageId)
    ),
  );
  if (succeeded.length === localResults.length) {
    completeImHubSendAttempt(attempt, { ok: true, platformMessageId: succeeded[0].platformMessageId });
    return;
  }
  completeImHubSendAttempt(attempt, {
    ok: false,
    code: succeeded.length ? 'partial_send_failed' : 'send_failed',
    message: succeeded.length
      ? getImHubBridgeErrorMessage('partial_send_failed')
      : getImHubBridgeErrorMessage('send_failed'),
  });
}

function completeImHubSendAttempt(attempt: ImHubSendAttempt, result: ImHubSendResult): void {
  if (attempt.result) return;
  attempt.result = result;
  attempt.commands.forEach((command) => reportImHubSendResult(command, result));
  pruneImHubSendAttempts();
}

function reportImHubSendResult(
  command: ImHubComposerCommand & { type: 'composer.send' },
  result: ImHubSendResult,
): void {
  getImHubBridge()?.emit({
    protocolVersion: 3,
    type: 'command.result',
    requestId: command.requestId,
    command: command.type,
    contextRevision: command.contextRevision,
    ok: result.ok,
    attemptId: command.attemptId,
    platformMessageId: result.ok ? result.platformMessageId : undefined,
    error: result.ok ? undefined : { code: result.code, message: result.message },
  });
}

function pruneImHubSendAttempts(): void {
  const completed = Array.from(sendAttempts.values()).filter(({ result }) => Boolean(result));
  completed.slice(0, -MAX_COMPLETED_SEND_ATTEMPTS).forEach((attempt) => {
    sendAttempts.delete(attempt.attemptId);
    attempt.localResults.forEach((_result, localKey) => sendAttemptIdByLocalMessage.delete(localKey));
  });
}

function buildImHubLocalMessageKey(chatId: string, localMessageId: number): string {
  return `${chatId}:${localMessageId}`;
}

function getImHubBridgeErrorMessage(code: string): string {
  const lang = getTranslationFn();
  switch (code) {
    case 'stale_context':
      return lang('ImHubContextChanged');
    case 'attempt_context_mismatch':
      return lang('ImHubAttemptContextMismatch');
    case 'composer_not_sendable':
      return lang('ImHubComposerNotSendable');
    case 'send_not_started':
      return lang('ImHubSendNotStarted');
    case 'partial_send_failed':
      return lang('ImHubPartialSendFailed');
    default:
      return lang('ImHubSendFailed');
  }
}

/**
 * 识别一段文字是什么语言。返回 undefined 表示识别不出来（不是错误，是"不知道"）。
 *
 * 发送前校对靠它决定该翻成什么语言：依据是客户最近一条消息用的语言。
 */
export async function detectLanguageViaImHub(text: string): Promise<string | undefined> {
  const bridge = getImHubBridge();
  if (!bridge || !text.trim()) return undefined;

  try {
    const lang = await bridge.detectLanguage(text);
    // 'und' 是"没识别出来"的占位值，不是一种语言，不能当目标语言用
    if (!lang || lang.toLowerCase() === 'und') return undefined;
    return lang.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * 翻一段文字，返回译文。发送前校对用它做正向翻译和回译。
 */
export async function translateOne(text: string, targetLang: string): Promise<string | undefined> {
  const results = await translateBatch([text], targetLang);
  const first = results?.[0];
  if (!first || first.failed || !first.translated) return undefined;
  return first.translated;
}

/**
 * 批量翻译。返回数组与入参一一对应，失败的那条 translated 为空串。
 *
 * 整批失败时返回 undefined，调用方据此清掉 pending 状态——留着 pending
 * 会让消息永远停在"翻译中"，用户分不清是还在排队还是已经挂了。
 */
export async function translateBatch(
  texts: string[],
  targetLang: string,
): Promise<BatchResult[] | undefined> {
  const bridge = getImHubBridge();
  if (!bridge) return undefined;

  try {
    return await bridge.translateBatch({ texts, targetLang });
  } catch {
    // eslint-disable-next-line no-console
    console.error('[im-hub] 翻译代理请求失败');
    return undefined;
  }
}
