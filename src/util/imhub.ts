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

interface ImHubNativeBridge {
  protocolVersion: number;
  emit(event: {
    protocolVersion: 2;
    type: 'bridge.ready' | 'account.signed-out';
  } | {
    protocolVersion: 2;
    type: 'account.identity';
    platformAccountExternalId: string;
  }): void;
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

export type ImHubTelegramMessageId = {
  chatId: string;
} & ({
  kind: 'server';
  serverMessageId: string;
} | {
  kind: 'temporary';
  source: 'telegram-tt';
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
 * updateMessageSendSucceeded 到达后再 remap，不能把小数截断成服务器 id。
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
  return `${normalizedChatId}:temp:telegram-tt:${localMessageId}`;
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

/**
 * 翻译工作区与原生输入框之间的通道。
 *
 * 工作区渲染在 Composer 组件**外面**（原生输入框下方，见 MiddleColumn），
 * 拿不到 Composer 内部的 richEditor 和 handleSend，所以由 Composer 在挂载时
 * 把这三个动作登记进来。
 *
 * 用模块级单例而不是 React context：同一时刻只有一个会话的输入框是活的，
 * 而套一层 provider 要改 MiddleColumn 的结构，补丁面反而更大。
 */
export interface ImHubDraftBridge {
  setDraft(text: string): void;
  getDraft(): string;
  send(): void;
}

let draftBridge: ImHubDraftBridge | undefined;

export function registerImHubDraftBridge(bridge: ImHubDraftBridge | undefined) {
  draftBridge = bridge;
}

export function getImHubDraftBridge(): ImHubDraftBridge | undefined {
  return draftBridge;
}

function getImHubBridge(): ImHubNativeBridge | undefined {
  const bridge = window.imHubNativeBridge;
  return bridge?.protocolVersion === 2 ? bridge : undefined;
}

let reportedPlatformAccountExternalId: string | null = null;

export function isImHubTranslationEnabled(): boolean {
  return getImHubBridge() !== undefined;
}

export function reportImHubAccountIdentity(currentUserId: string | null): void {
  const bridge = getImHubBridge();
  if (!bridge) return;
  bridge.emit({ protocolVersion: 2, type: 'bridge.ready' });
  if (currentUserId) {
    reportedPlatformAccountExternalId = currentUserId;
    bridge.emit({
      protocolVersion: 2,
      type: 'account.identity',
      platformAccountExternalId: currentUserId,
    });
  } else if (reportedPlatformAccountExternalId !== null) {
    reportedPlatformAccountExternalId = null;
    bridge.emit({ protocolVersion: 2, type: 'account.signed-out' });
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
