import {
  afterEach, beforeAll, describe, expect, it, vi,
} from 'vitest';

vi.mock('./establishMultitabRole', () => ({
  isCurrentTabMaster: () => true,
}));

describe('global error handling', () => {
  beforeAll(async () => {
    await import('./handleError');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not alert for an ignored unhandled rejection', () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const event = new Event('unhandledrejection', { cancelable: true });
    Object.defineProperty(event, 'reason', {
      value: { message: 'USER_CANCELED' },
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('still reports an unexpected unhandled rejection', () => {
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = { message: 'NETWORK_FAILED' };
    const event = new Event('unhandledrejection', { cancelable: true });
    Object.defineProperty(event, 'reason', { value: error });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(error);
  });
});
