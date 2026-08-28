import { beforeEach, describe, expect, test, vi } from 'vitest';

import { requestMediaWorker } from '../../../../util/launchMediaWorkers';
import getCustomAppendixBg from './getCustomAppendixBg';

vi.mock('../../../../util/launchMediaWorkers', () => ({
  MAX_WORKERS: 4,
  requestMediaWorker: vi.fn(),
}));

const requestMediaWorkerMock = vi.mocked(requestMediaWorker);

beforeEach(() => {
  requestMediaWorkerMock.mockReset();
});

describe('getCustomAppendixBg', () => {
  test('图片暂时无法解码时降级到当前主题颜色', async () => {
    requestMediaWorkerMock.mockRejectedValue(new Error('The source image could not be decoded.'));

    await expect(getCustomAppendixBg('blob:stale', true, 7, false, 'dark'))
      .resolves.toBe('rgb(135,116,225)');
  });

  test('非解码错误继续向调用方传播', async () => {
    requestMediaWorkerMock.mockRejectedValue(new Error('worker crashed'));

    await expect(getCustomAppendixBg('blob:photo', false, 7, false, 'light'))
      .rejects.toThrow('worker crashed');
  });
});
