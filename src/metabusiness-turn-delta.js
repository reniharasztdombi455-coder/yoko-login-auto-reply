'use strict';

function clean(value, max = 1200) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function positiveMs(...values) {
  return Math.max(0, ...values.map(v => Number(v || 0) || 0));
}

// Meta Business frequently omits the unread badge.  The inbox preview itself
// still carries a strong outgoing marker for messages sent by the operator.
// Keep this deliberately prefix-based: customer text that merely contains the
// words "you sent" later in the sentence must never be reclassified as Yoko.
function metaBusinessPreviewDirection(preview = '', explicit = '') {
  const role = clean(explicit, 30).toLowerCase();
  if (role === 'me' || role === 'customer') return role;
  const value = clean(preview, 1200);
  if (!value) return '';
  if (/^(?:你|您|You|あなた)\s*[:：]/iu.test(value)) return 'me';
  if (/^(?:你|您)\s*(?:发送了|發送了|传送了|傳送了|已发送|已發送|回复了|回覆了)/u.test(value)) return 'me';
  if (/^You\s+(?:sent|replied|shared|responded)\b/iu.test(value)) return 'me';
  if (/^(?:(?:あなた|自分)が\s*)?(?:送信しました|送信した|返信しました|返信した|送った|送りました)(?:[：:\s]|$)/u.test(value)) return 'me';
  return 'customer';
}

function metaBusinessTurnBoundary(old = {}) {
  return positiveMs(old.lastIncomingAt, old.lastReplyAt, old.manualReadAt, old.handledAt);
}

function evaluateMetaBusinessTurnDelta({ old = {}, fresh = {}, observedMessageAt = 0, now = Date.now() } = {}) {
  const oldPreview = clean(old.preview || old.lastMessage, 1200);
  const freshPreview = clean(fresh.preview || fresh.lastMessage, 1200);
  const oldTime = clean(old.lastMessageAt, 180);
  const freshTime = clean(fresh.lastMessageAt, 180);
  const direction = metaBusinessPreviewDirection(freshPreview, fresh.lastDirection);
  const unreadCount = Math.max(0, Number(fresh.unreadCount || 0) || 0);
  const previewChanged = !!freshPreview && freshPreview !== oldPreview;
  const timeChanged = !!freshTime && freshTime !== oldTime;
  const freshAt = positiveMs(fresh.lastMessageTimestamp, fresh.lastIncomingAt, observedMessageAt);
  const oldIncomingAt = positiveMs(old.lastIncomingAt);
  const lastReplyAt = positiveMs(old.lastReplyAt);
  const manualReadAt = positiveMs(old.manualReadAt);
  const handledBoundaryAt = Math.max(lastReplyAt, manualReadAt);
  const turnBoundaryAt = metaBusinessTurnBoundary(old);
  const strictlyNewTime = freshAt > 0 && freshAt > turnBoundaryAt;
  const handledBoundaryActive = handledBoundaryAt > 0 && oldIncomingAt <= handledBoundaryAt;

  // A stale native unread dot is explicitly weak after reply/mark-read.  It can
  // reopen a turn only when a newer customer fact accompanies it (changed
  // preview or a timestamp later than the handled/customer boundary).
  const customerEvidenceChanged = previewChanged || strictlyNewTime;
  const customerTurn = direction === 'customer' && (
    strictlyNewTime ||
    previewChanged ||
    (!handledBoundaryActive && unreadCount > 0 && (oldIncomingAt <= 0 || freshAt <= 0 || freshAt >= oldIncomingAt))
  );

  // A list-row outgoing marker is a useful recovery path when Meta/React misses
  // the normal composer confirmation.  Never close merely because an old
  // outgoing row is still visible: require a changed preview or a newer time.
  const outgoingTurn = direction === 'me' && (
    previewChanged ||
    (freshAt > 0 && freshAt > lastReplyAt && (timeChanged || lastReplyAt <= 0))
  );

  return {
    direction,
    unreadCount,
    previewChanged,
    timeChanged,
    freshAt: freshAt || (customerTurn || outgoingTurn ? Number(now || Date.now()) || Date.now() : 0),
    oldIncomingAt,
    lastReplyAt,
    manualReadAt,
    handledBoundaryAt,
    turnBoundaryAt,
    strictlyNewTime,
    handledBoundaryActive,
    customerEvidenceChanged,
    customerTurn,
    outgoingTurn
  };
}

module.exports = {
  metaBusinessPreviewDirection,
  metaBusinessTurnBoundary,
  evaluateMetaBusinessTurnDelta
};
