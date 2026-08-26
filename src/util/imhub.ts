/**
 * 与 im-hub 服务端的对接层。
 *
 * 这是本 fork 相对上游新增的文件之一。所有对 im-hub 的调用都收在这里，
 * 跟上游合并时冲突面最小——上游改不到这个文件，我们也尽量不把逻辑散进
 * 上游原有的文件里。
 *
 * 配置由外壳注入：Electron 的 webview preload 会在页面加载前写入
 * window.__IM_HUB__。拿不到就静默降级成不翻译，而不是抛异常——
 * 翻译挂了不该让整个客户端起不来。
 */

interface ImHubConfig {
  serverUrl: string;
  token: string;
}

interface BatchResult {
  translated: string;
  detectedLang: string;
  provider: string;
  failed: boolean;
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
    __IM_HUB__?: ImHubConfig;
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

export function getImHubConfig(): ImHubConfig | undefined {
  const cfg = window.__IM_HUB__;
  if (!cfg?.serverUrl || !cfg.token) return undefined;
  return cfg;
}

export function isImHubTranslationEnabled(): boolean {
  return getImHubConfig() !== undefined;
}

/**
 * 识别一段文字是什么语言。返回 undefined 表示识别不出来（不是错误，是"不知道"）。
 *
 * 发送前校对靠它决定该翻成什么语言：依据是客户最近一条消息用的语言。
 */
export async function detectLanguageViaImHub(text: string): Promise<string | undefined> {
  const cfg = getImHubConfig();
  if (!cfg || !text.trim()) return undefined;

  try {
    const res = await fetch(`${cfg.serverUrl}/api/translate/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const body = await res.json() as { detectedLang?: string | null };
    const lang = body.detectedLang;
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
  const cfg = getImHubConfig();
  if (!cfg) return undefined;

  try {
    const res = await fetch(`${cfg.serverUrl}/api/translate/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ texts, targetLang }),
      // 20 条一批，给足时间但不能无限等——挂住的请求会让 pending 永远不消
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[im-hub] 翻译接口返回', res.status);
      return undefined;
    }
    const body = await res.json() as { results?: BatchResult[] };
    return body.results;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[im-hub] 翻译请求失败', err);
    return undefined;
  }
}
