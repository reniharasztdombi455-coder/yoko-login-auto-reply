'use strict';

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function classifyTikTokLaneBubble({ lane = {}, bubble = {}, avatarSide = '', semanticRole = '' } = {}) {
  const semantic = String(semanticRole || '').toLowerCase();
  if (semantic === 'customer' || semantic === 'me') return semantic;
  const side = String(avatarSide || '').toLowerCase();
  if (side === 'left') return 'customer';
  if (side === 'right') return 'me';

  const ll = n(lane.left), lr = n(lane.right);
  const bl = n(bubble.left), br = n(bubble.right);
  const width = Math.max(1, lr - ll);
  if (!(lr > ll) || !(br > bl)) return '';
  const leftRatio = (bl - ll) / width;
  const rightRatio = (br - ll) / width;
  const centerRatio = (((bl + br) / 2) - ll) / width;

  // TikTok desktop: outgoing bubbles hug the right edge. Incoming bubbles sit
  // in the left/middle lane. Keep an ambiguity gap to avoid learning Yoko's own
  // messages as customer facts when TikTok stretches a long bubble.
  if (rightRatio >= 0.86 && leftRatio >= 0.10) return 'me';
  if (rightRatio <= 0.74 && centerRatio <= 0.50) return 'customer';
  if (centerRatio >= 0.60) return 'me';
  if (centerRatio <= 0.44) return 'customer';
  return '';
}

module.exports = { classifyTikTokLaneBubble };
