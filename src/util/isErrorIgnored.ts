import { IGNORE_UNHANDLED_ERRORS } from '../config';

export default function isErrorIgnored(error: unknown): boolean {
  const message = getErrorMessage(error);
  return Boolean(message && IGNORE_UNHANDLED_ERRORS.has(message));
}

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object' || !('message' in error)) return undefined;

  return typeof error.message === 'string' ? error.message : undefined;
}
