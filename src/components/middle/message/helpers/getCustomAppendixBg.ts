import type { ThemeKey } from '../../../../types';

import { MAX_WORKERS, requestMediaWorker } from '../../../../util/launchMediaWorkers';

const SELECTED_APPENDIX_COLORS = {
  dark: {
    outgoing: 'rgb(135,116,225)',
    incoming: 'rgb(33,33,33)',
  },
  light: {
    outgoing: 'rgb(238,255,222)',
    incoming: 'rgb(255,255,255)',
  },
};

const SOURCE_IMAGE_DECODE_ERROR = 'The source image could not be decoded.';

function getFallbackColor(isOwn: boolean, theme?: ThemeKey) {
  return SELECTED_APPENDIX_COLORS[theme || 'light'][isOwn ? 'outgoing' : 'incoming'];
}

export default function getCustomAppendixBg(
  src: string, isOwn: boolean, id: number, isSelected?: boolean, theme?: ThemeKey,
) {
  if (isSelected) {
    return Promise.resolve(getFallbackColor(isOwn, theme));
  }

  return requestMediaWorker({
    name: 'offscreen-canvas:getAppendixColorFromImage',
    args: [src, isOwn],
  }, Math.round(id) % MAX_WORKERS).catch((error: unknown) => {
    // Blob URLs can become stale while media caches are rebuilt after a network
    // reconnect. Appendix sampling is decorative, so keep the message usable and
    // fall back to the theme color for this known decode failure only.
    if (error instanceof Error && error.message === SOURCE_IMAGE_DECODE_ERROR) {
      return getFallbackColor(isOwn, theme);
    }
    throw error;
  });
}
