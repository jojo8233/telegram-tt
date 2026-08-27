import type { ApiMessage } from '../api/types';
import type { GlobalState } from '../global/types';
import type { ImHubMessageSnapshot } from './imhubOutbox';

import { getRichMessagePreviewText } from '../global/helpers/richMessage';
import { selectPeer } from '../global/selectors';
import { buildImHubTelegramMessageId, isImHubTranslationEnabled } from './imhub';
import { enqueueImHubOutboxEvent } from './imhubOutbox';

const NATIVE_EDIT_VERSION_MAX = 2_147_483_647;
const BRIDGE_NULL: null = JSON.parse('null');

export function reportImHubMessageUpsert(
  global: GlobalState,
  message: ApiMessage,
  editVersion?: number,
): void {
  const accountExternalId = global.currentUserId;
  if (!accountExternalId || !isImHubTranslationEnabled() || message.isEphemeral || message.isScheduled) return;

  try {
    const snapshot = buildMessageSnapshot(global, message, normalizeEditVersion(editVersion));
    enqueueImHubOutboxEvent(accountExternalId, { type: 'message.upsert', message: snapshot });
  } catch {
    // 非规范消息 id 或时间不能跨过 bridge；中央更新链仍继续处理 Telegram 自身状态
  }
}

export function reportImHubMessageDeleted(global: GlobalState, chatId: string, messageId: number): void {
  const accountExternalId = global.currentUserId;
  if (!accountExternalId
    || !isImHubTranslationEnabled()
    || !Number.isSafeInteger(messageId)
    || messageId <= 0) return;
  try {
    enqueueImHubOutboxEvent(accountExternalId, {
      type: 'message.deleted',
      platformMessageId: buildImHubTelegramMessageId(chatId, messageId),
      deletedAt: new Date().toISOString(),
    });
  } catch {
    // 缺失或非规范 chat id 的删除不猜测归属
  }
}

export function reportImHubMessageIdRemapped(
  global: GlobalState,
  chatId: string,
  localMessageId: number,
  serverMessageId: number,
): void {
  const accountExternalId = global.currentUserId;
  if (!accountExternalId || !isImHubTranslationEnabled()) return;
  try {
    enqueueImHubOutboxEvent(accountExternalId, {
      type: 'message.id-remapped',
      oldPlatformMessageId: buildImHubTelegramMessageId(chatId, localMessageId),
      newPlatformMessageId: buildImHubTelegramMessageId(chatId, serverMessageId),
    });
  } catch {
    // remap 两端必须属于同一规范 chat，异常值不进入持久队列
  }
}

function buildMessageSnapshot(
  global: GlobalState,
  message: ApiMessage,
  editVersion: number | null,
): ImHubMessageSnapshot {
  const platformMessageId = buildImHubTelegramMessageId(message.chatId, message.id);
  const senderExternalId = message.isOutgoing
    ? global.currentUserId!
    : message.senderId || message.chatId;
  const replyToPlatformMessageId = buildReplyMessageId(message);
  const editedAt = message.editDate ? buildTimestamp(message.editDate) : BRIDGE_NULL;

  return {
    platformConversationId: message.chatId,
    platformMessageId,
    direction: message.isOutgoing ? 'out' : 'in',
    senderExternalId,
    senderDisplayName: getPeerDisplayName(global, senderExternalId) ?? BRIDGE_NULL,
    conversationDisplayName: getPeerDisplayName(global, message.chatId) ?? BRIDGE_NULL,
    body: getMessageBody(message),
    mediaRefs: buildMediaRefs(message, platformMessageId),
    replyToPlatformMessageId,
    sentAt: buildTimestamp(message.date),
    editedAt,
    editVersion: editedAt ? editVersion : BRIDGE_NULL,
    raw: {
      groupedId: message.groupedId,
      isSilent: Boolean(message.isSilent),
      isFromScheduled: Boolean(message.isFromScheduled),
      isAction: Boolean(message.content.action),
    },
  };
}

function buildReplyMessageId(message: ApiMessage): string | null {
  const replyInfo = message.replyInfo;
  if (!replyInfo || replyInfo.type !== 'message' || !replyInfo.replyToMsgId) return BRIDGE_NULL;
  const replyChatId = replyInfo.replyToPeerId || message.chatId;
  if (replyChatId !== message.chatId) return BRIDGE_NULL;
  return buildImHubTelegramMessageId(replyChatId, replyInfo.replyToMsgId);
}

function getMessageBody(message: ApiMessage): string {
  if (message.content.text) return message.content.text.text;
  if (message.content.richMessage) return getRichMessagePreviewText(message.content.richMessage);
  return '';
}

function buildMediaRefs(message: ApiMessage, platformMessageId: string): ImHubMessageSnapshot['mediaRefs'] {
  const {
    photo, video, audio, voice, document, sticker,
  } = message.content;
  const refs: ImHubMessageSnapshot['mediaRefs'] = [];
  if (photo) {
    refs.push({ kind: 'image', remoteId: photo.id });
  }
  if (video) {
    refs.push({
      kind: 'video',
      remoteId: video.id,
      fileName: video.fileName,
      mimeType: video.mimeType,
      sizeBytes: normalizeSize(video.size),
    });
  }
  if (audio) {
    refs.push({
      kind: 'audio',
      remoteId: audio.id,
      fileName: audio.fileName,
      mimeType: audio.mimeType,
      sizeBytes: normalizeSize(audio.size),
    });
  }
  if (voice) {
    refs.push({
      kind: 'audio',
      remoteId: `${platformMessageId}:voice`,
      mimeType: 'audio/ogg',
      sizeBytes: normalizeSize(voice.size),
    });
  }
  if (document) {
    refs.push({
      kind: 'file',
      remoteId: document.id || `${platformMessageId}:document`,
      fileName: document.fileName,
      mimeType: document.mimeType,
      sizeBytes: normalizeSize(document.size),
    });
  }
  if (sticker) {
    refs.push({ kind: 'sticker', remoteId: sticker.id });
  }
  return refs;
}

function getPeerDisplayName(global: GlobalState, peerId: string): string | undefined {
  const peer = selectPeer(global, peerId);
  if (!peer) return undefined;
  if ('title' in peer) return peer.title;
  return [peer.firstName, peer.lastName].filter(Boolean).join(' ') || undefined;
}

function normalizeSize(size: number): number | undefined {
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function normalizeEditVersion(editVersion?: number): number | null {
  return Number.isSafeInteger(editVersion)
    && editVersion !== undefined
    && editVersion >= 0
    && editVersion <= NATIVE_EDIT_VERSION_MAX
    ? editVersion
    : BRIDGE_NULL;
}

function buildTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Telegram message timestamp is invalid');
  return new Date(seconds * 1_000).toISOString();
}
