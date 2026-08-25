import type { FC } from '../../../lib/teact/teact';
import React, { memo } from '../../../lib/teact/teact';

import type { ImHubReviewState } from './hooks/useImHubSendReview';

import buildClassName from '../../../util/buildClassName';

import Icon from '../../common/icons/Icon';

import styles from './ImHubSendReview.module.scss';

type OwnProps = {
  review?: ImHubReviewState;
  onDismiss: NoneToVoidFunction;
};

/**
 * 发送前校对条。
 *
 * 关键是**把原文和回译并排放**，不能只给回译。
 *
 * 回译并不能证明翻译正确——错译也可能回译得很顺，而正常的语序调整回来又会显得
 * 别扭。它的实际用途是"气味测试"：拿原文对照着看关键信息有没有丢，
 * 价格、数量、否定词、时间、人名。只给回译的话，员工没有参照物，判断不了。
 */
const ImHubSendReview: FC<OwnProps> = ({ review, onDismiss }) => {
  if (!review) return undefined;

  return (
    <div className={styles.root} dir="auto">
      <div className={styles.header}>
        <Icon name="language" className={styles.icon} />
        <span className={styles.title}>
          译文已填入输入框（{review.targetLang.toUpperCase()}）· 检查后再按回车发送
        </span>
        <button
          type="button"
          className={styles.close}
          aria-label="关闭校对提示"
          onClick={onDismiss}
        >
          <Icon name="close" />
        </button>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>你输入的</span>
        <span className={styles.text}>{review.original}</span>
      </div>
      <div className={buildClassName(styles.row, styles.lastRow)}>
        <span className={styles.label}>回译成中文</span>
        <span className={buildClassName(styles.text, review.isBackPending && styles.pending)}>
          {review.isBackPending
            ? '回译中…'
            : (review.backTranslated ?? '回译不可用（不影响发送）')}
        </span>
      </div>

      <div className={styles.hint}>
        回译顺不代表翻对了。要比的是关键信息有没有丢：价格、数量、否定词、时间、人名。
      </div>
    </div>
  );
};

export default memo(ImHubSendReview);
