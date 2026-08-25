import { useRef, useState } from '../../../../lib/teact/teact';

import type { ApiFormattedText } from '../../../../api/types';

import {
  detectLanguageViaImHub, isImHubTranslationEnabled, translateOne,
} from '../../../../util/imhub';

/**
 * 发送前译文校对。
 *
 * 员工打中文 → 第一次回车不发出去，而是翻成客户的语言、写回输入框 →
 * 员工看一眼（能直接改）→ 第二次回车才真的发。
 *
 * 为什么值得做：跨境客服发出去的每一句都代表公司，而机器翻译会在价格、数量、
 * 否定词、时间这些地方出错。发完再发现就晚了。
 *
 * 判断"要不要拦"不靠状态机，靠比对文本本身：
 * 拦截后我们把译文写回了输入框，此时输入框里的内容与 lastTranslatedRef 相同，
 * 第二次回车时比对相等就直接放行。用状态机的话，用户在预览阶段改了字、
 * 切了会话、撤销了操作，每一种都要单独处理，很容易漏掉某条路径而变成
 * "怎么按都发不出去"。
 */

export interface ImHubReviewState {
  /** 员工原本输入的中文，供对照 */
  original: string;
  /** 译文回译成中文的结果。null 表示回译不可用——不影响发送 */
  backTranslated: string | null;
  targetLang: string;
  isBackPending: boolean;
}

/** 目标语言识别不出来时的兜底。改这个值等于改变所有未知语言会话的默认行为。 */
const FALLBACK_TARGET_LANG = 'en';

/** 含中日韩字符才需要校对——员工用母语打的才是要翻译的那部分 */
const CJK = /[一-鿿぀-ヿ가-힯]/;

export default function useImHubSendReview() {
  const [review, setReview] = useState<ImHubReviewState | undefined>();
  const lastTranslatedRef = useRef<string | undefined>();
  const isBusyRef = useRef(false);

  function dismiss() {
    setReview(undefined);
    lastTranslatedRef.current = undefined;
  }

  /**
   * 返回 true 表示"这次不要发出去"——调用方必须直接 return。
   *
   * @param getText     取输入框当前文本
   * @param setText     把译文写回输入框
   * @param getPeerText 取客户最近一条消息，用来判断该翻成什么语言
   */
  async function shouldHoldForReview(
    getText: () => ApiFormattedText | undefined,
    setText: (text: string) => void,
    getPeerText: () => string | undefined,
  ): Promise<boolean> {
    if (!isImHubTranslationEnabled()) return false;

    const current = getText()?.text.trim();
    if (!current) return false;

    // 已经是我们上一步译出来的那段（可能被员工微调过前后空白）——放行
    if (lastTranslatedRef.current !== undefined && current === lastTranslatedRef.current.trim()) {
      dismiss();
      return false;
    }

    if (!CJK.test(current)) return false;

    // 正在翻上一次时又按了回车：挡住，避免同一段文字发两次翻译请求
    if (isBusyRef.current) return true;
    isBusyRef.current = true;

    try {
      const peer = getPeerText();
      const detected = peer ? await detectLanguageViaImHub(peer) : undefined;
      // 客户也在说中文时不该翻成中文——那样译文和原文一样，校对没有意义
      const targetLang = !detected || detected.startsWith('zh') ? FALLBACK_TARGET_LANG : detected;

      const translated = await translateOne(current, targetLang);
      if (!translated) {
        // 翻译挂了不能把人卡住：放行让他按原样发出去，自己决定怎么办
        // eslint-disable-next-line no-console
        console.error('[im-hub] 发送前翻译失败，本次按原文发送');
        return false;
      }

      lastTranslatedRef.current = translated;
      setText(translated);
      setReview({
        original: current, backTranslated: null, targetLang, isBackPending: true,
      });

      // 回译是辅助，不能让它拖住主流程。单独跑，回来了再补上
      void translateOne(translated, 'zh').then((back) => {
        setReview((prev) => (prev && prev.original === current
          ? { ...prev, backTranslated: back ?? null, isBackPending: false }
          : prev));
      });

      return true;
    } finally {
      isBusyRef.current = false;
    }
  }

  return { review, dismiss, shouldHoldForReview };
}
