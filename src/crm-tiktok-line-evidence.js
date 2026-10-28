'use strict';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clean(v, n = 900) { return String(v || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0,n); }

/**
 * Decide whether a browser-reported TikTok bubble is safe to treat as customer-authored.
 * Strong semantic/avatar evidence wins. Geometry is only a conservative fallback.
 * The geometry rule intentionally accepts a bubble whose RIGHT edge stays in the
 * left ~84% of the real message lane; TikTok outgoing bubbles hug the right edge.
 */
function classifyTikTokBubble(candidate = {}) {
  const semantic = clean(candidate.semantic, 30).toLowerCase();
  if (semantic === 'customer' || semantic === 'incoming') return 'customer';
  if (semantic === 'me' || semantic === 'outgoing') return 'me';
  const avatarSide = clean(candidate.avatarSide, 20).toLowerCase();
  if (avatarSide === 'left') return 'customer';
  if (avatarSide === 'right') return 'me';

  const b = candidate.bubble || {};
  const r = candidate.root || {};
  const rootLeft = num(r.left), rootRight = num(r.right);
  const rootWidth = num(r.width) || Math.max(0, rootRight-rootLeft);
  if (rootWidth < 120) return '';
  const left = num(b.left), right = num(b.right);
  if (!(right > left)) return '';
  const leftRatio = (left-rootLeft)/rootWidth;
  const rightRatio = (right-rootLeft)/rootWidth;
  const centerRatio = (((left+right)/2)-rootLeft)/rootWidth;

  // Strong right-lane outgoing evidence first.
  if (rightRatio >= 0.89 && centerRatio >= 0.50) return 'me';
  // Conservative customer fallback. This is aimed at short confirmation bubbles
  // such as "もうLINEを追加しました。", not arbitrary full-width content.
  if (rightRatio <= 0.84 && leftRatio <= 0.50 && centerRatio <= 0.58) return 'customer';
  return '';
}

function confirmedCustomerLineAddedCandidate(candidate = {}, textMatcher = null) {
  const text = clean(candidate.text, 900);
  if (!text || typeof textMatcher !== 'function' || !textMatcher(text)) return false;
  return classifyTikTokBubble(candidate) === 'customer';
}

module.exports = { classifyTikTokBubble, confirmedCustomerLineAddedCandidate };
