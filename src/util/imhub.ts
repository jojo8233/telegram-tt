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

declare global {
  interface Window {
    __IM_HUB__?: ImHubConfig;
  }
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
