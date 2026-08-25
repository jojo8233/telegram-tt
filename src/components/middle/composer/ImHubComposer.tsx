import type { FC } from '../../../lib/teact/teact';
import React, {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import {
  detectLanguageViaImHub, isImHubTranslationEnabled, translateOne,
} from '../../../util/imhub';

import styles from './ImHubComposer.module.scss';

type OwnProps = {
  chatId: string;
  /** 客户最近一条有文字的消息，用来自动判断回复语言 */
  getPeerText: () => string | undefined;
  /** 把文本写进原生输入框 */
  setDraft: (text: string) => void;
  /** 读原生输入框当前内容 */
  getDraft: () => string;
  /** 触发原生发送流程（发的就是原生输入框里的内容） */
  onSend: NoneToVoidFunction;
};

const LANG_OPTIONS: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'th', label: 'ไทย' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'zh', label: '中文' },
];

const SUPPORTED = new Set(LANG_OPTIONS.map((o) => o.code));
const FALLBACK_LANG = 'en';

/**
 * 自动识别语言的最短文本长度。
 *
 * 短文本识别极不可靠——实测 "Sticker" 会被判成瑞典语。宁可退回默认语言，
 * 也不要拿一个猜出来的语种去翻译整段回复。
 */
const MIN_DETECT_LENGTH = 12;

/** 锁定的回复语言按会话存，切走再回来还在 */
const lockKey = (chatId: string) => `im-hub.replyLang.${chatId}`;

const BACK_TRANSLATE_DEBOUNCE = 600;

/**
 * 发送前译文校对区。
 *
 * 与原生输入框并存而不是取代它：原生那个还管着附件、语音、表情、回复引用，
 * 取代它等于要把这些全部重做一遍。这里只负责"打中文 → 校对 → 发出去"这条
 * 主链路，最终文本仍然交给原生的发送流程，所以限流、字数限制、回复引用
 * 这些全都照常生效。
 */
const ImHubComposer: FC<OwnProps> = ({
  chatId, getPeerText, setDraft, getDraft, onSend,
}) => {
  const [zh, setZh] = useState('');
  const [preview, setPreview] = useState('');
  const [previewSource, setPreviewSource] = useState('');
  const [backTranslated, setBackTranslated] = useState<string | undefined>();
  const [isBackPending, setIsBackPending] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [isHovering, setIsHovering] = useState(false);

  const [lockedLang, setLockedLang] = useState<string | undefined>();
  const [autoLang, setAutoLang] = useState<string | undefined>();

  const previewRef = useRef<HTMLTextAreaElement>();
  const backTimerRef = useRef<number | undefined>();

  const targetLang = lockedLang || autoLang || FALLBACK_LANG;
  const hasPreview = preview.trim().length > 0;

  // 换会话：清空一切，并读回这个会话上次锁定的语言
  useEffect(() => {
    setZh('');
    setPreview('');
    setPreviewSource('');
    setBackTranslated(undefined);
    setError(undefined);
    setAutoLang(undefined);
    setDraft('');
    try {
      setLockedLang(localStorage.getItem(lockKey(chatId)) || undefined);
    } catch {
      setLockedLang(undefined);
    }
  }, [chatId]);

  // 没锁定时，按客户最近一条消息自动判断回复语言
  useEffect(() => {
    if (lockedLang) return;
    const peer = getPeerText();
    if (!peer || peer.trim().length < MIN_DETECT_LENGTH) return;

    let isCancelled = false;
    void detectLanguageViaImHub(peer).then((lang) => {
      if (isCancelled || !lang) return;
      const code = lang.split('-')[0]!;
      // 识别出来的语种我们不支持时不要硬用，退回默认；
      // 客户说中文时也不该把回复翻成中文
      if (!SUPPORTED.has(code) || code === 'zh') return;
      setAutoLang(code);
    });
    return () => { isCancelled = true; };
  }, [chatId, lockedLang, getPeerText]);

  function scheduleBackTranslate(text: string) {
    window.clearTimeout(backTimerRef.current);
    if (!text.trim()) {
      setBackTranslated(undefined);
      return;
    }
    setIsBackPending(true);
    backTimerRef.current = window.setTimeout(() => {
      void translateOne(text, 'zh').then((back) => {
        setBackTranslated(back);
        setIsBackPending(false);
      });
    }, BACK_TRANSLATE_DEBOUNCE);
  }

  async function handleTranslate() {
    const source = zh.trim();
    if (!source || isTranslating) return;
    setIsTranslating(true);
    setError(undefined);
    try {
      const translated = await translateOne(source, targetLang);
      if (!translated) {
        setError('翻译失败，检查服务端是否在运行');
        return;
      }
      setPreview(translated);
      setPreviewSource(source);
      // 同步写进原生输入框：那一行显示的就是即将发出去的内容，发送前在那里
      // 再核一遍。这也让它有了明确角色，不再像"第二个输入框"
      setDraft(translated);
      scheduleBackTranslate(translated);
      // 焦点移到译文框：下一次回车就是发送，光标该已经落在要读的内容上
      requestAnimationFrame(() => previewRef.current?.focus());
    } finally {
      setIsTranslating(false);
    }
  }

  function handleSend() {
    // 以原生输入框为准：它显示的就是即将发出去的内容，员工可能直接在那里
    // 改了字。取预览框的值会把他刚改的悄悄覆盖掉。
    const text = (getDraft().trim() || preview.trim());
    if (!text) return;
    setDraft(text);
    onSend();
    setZh('');
    setPreview('');
    setPreviewSource('');
    setBackTranslated(undefined);
  }

  function handleToggleLock() {
    try {
      if (lockedLang) {
        localStorage.removeItem(lockKey(chatId));
        setLockedLang(undefined);
      } else {
        localStorage.setItem(lockKey(chatId), targetLang);
        setLockedLang(targetLang);
      }
    } catch {
      // 存不下就只在本次会话内生效，不值得为它报错
      setLockedLang(lockedLang ? undefined : targetLang);
    }
  }

  function handleSelectLang(code: string) {
    setLockedLang(code);
    try {
      localStorage.setItem(lockKey(chatId), code);
    } catch { /* 同上 */ }
  }

  if (!isImHubTranslationEnabled()) return undefined;

  return (
    <div className={styles.root} dir="auto">
      {/* 对照框浮在整个面板之上：挂在译文框上的话会盖住上方的中文原文，
          正是要对照的两样东西互相遮挡 */}
      {isHovering && hasPreview && (
        <div className={styles.tooltip}>
          <div className={styles.tooltipRow}>
            <span className={styles.tooltipLabel}>你输入的</span>
            <span>{previewSource}</span>
          </div>
          <div className={styles.tooltipRow}>
            <span className={styles.tooltipLabel}>回译成中文</span>
            <span>{isBackPending ? '回译中…' : (backTranslated ?? '回译不可用')}</span>
          </div>
          <div className={styles.tooltipHint}>
            回译顺不代表翻对了。要比的是关键信息有没有丢：价格、数量、否定词、时间、人名。
          </div>
        </div>
      )}
      <div className={styles.label}>
        <span className={styles.dot} />
        中文原文
      </div>
      <textarea
        className={styles.input}
        value={zh}
        placeholder="输入中文，回车翻译（Shift+回车换行）"
        onChange={(e) => setZh(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleTranslate();
          }
        }}
      />

      {hasPreview && (
        <div className={styles.previewBlock}>
          <div className={styles.label}>
            <span className={buildClassName(styles.dot, styles.dotAccent)} />
            译文预览
            <span className={styles.labelHint}>
              可直接改，悬停看原文与回译对照 · 下方输入框显示的就是即将发出的内容
            </span>
          </div>

          <div
            className={styles.previewWrap}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          >
            <textarea
              ref={previewRef}
              className={buildClassName(styles.input, styles.preview)}
              value={preview}
              onChange={(e) => {
                const next = e.currentTarget.value;
                setPreview(next);
                setDraft(next);
                scheduleBackTranslate(next);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
          </div>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.footer}>
        <span className={styles.footerLabel}>回复语言</span>
        <select
          className={styles.select}
          value={targetLang}
          onChange={(e) => handleSelectLang(e.currentTarget.value)}
        >
          {LANG_OPTIONS.map((o) => (
            <option key={o.code} value={o.code}>{o.label}</option>
          ))}
        </select>
        <button
          type="button"
          className={buildClassName(styles.lock, lockedLang && styles.lockOn)}
          onClick={handleToggleLock}
          title={lockedLang ? '已锁定，点击恢复自动跟随客户语言' : '自动跟随客户语言，点击锁定'}
        >
          {lockedLang ? '🔒 已锁定' : '🔓 自动'}
        </button>

        <div className={styles.spacer} />

        <button
          type="button"
          className={styles.ghostButton}
          onClick={() => void handleTranslate()}
          disabled={!zh.trim() || isTranslating}
        >
          {isTranslating ? '翻译中…' : '翻译'}
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={handleSend}
          disabled={!hasPreview}
        >
          发送
        </button>
      </div>
    </div>
  );
};

export default memo(ImHubComposer);
