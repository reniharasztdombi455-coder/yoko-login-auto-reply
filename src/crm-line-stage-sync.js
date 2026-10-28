'use strict';

function text(value, max = 500) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max);
}

function score(value) {
  return Math.max(0, Math.min(100, Number(value || 0) || 0));
}

function cloneObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function validPauseSnapshot(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value) && (
    text(value.lineIntent, 30) || text(value.lineProgress, 40) || text(value.targetLineAccountId, 128)
  ));
}

function capturePauseSnapshot(contact = {}, now = new Date().toISOString()) {
  const existing = contact?._linePauseSnapshot;
  // Re-saving an already paused customer must never replace the original state
  // with "paused / paused". The first pre-pause snapshot remains authoritative.
  if (validPauseSnapshot(existing)) return { ...existing };
  const currentIntent = text(contact?.lineIntent, 30);
  const currentProgress = text(contact?.lineProgress, 40);
  return {
    lineIntent: currentIntent && currentIntent !== 'paused' ? currentIntent : 'none',
    lineIntentScore: currentIntent === 'paused' ? 0 : score(contact?.lineIntentScore),
    lineProgress: currentProgress && currentProgress !== 'paused' ? currentProgress : 'not_started',
    lineEvidence: text(contact?.lineEvidence, 360),
    lineJourney: cloneObject(contact?._lineJourney),
    targetLineAccountId: text(contact?.targetLineAccountId, 128),
    targetLineAccountName: text(contact?.targetLineAccountName, 160),
    capturedAt: text(existing?.capturedAt || now, 80)
  };
}

function pausedLineState(contact = {}, now = new Date().toISOString()) {
  const snapshot = capturePauseSnapshot(contact, now);
  const priorJourney = cloneObject(contact?._lineJourney);
  return {
    lineIntent: 'paused',
    lineIntentScore: 0,
    lineProgress: 'paused',
    lineEvidence: '客户已人工标记为无效/暂停；LINE 跟进同步暂停。',
    _lineJourney: {
      ...priorJourney,
      intent: 'paused',
      progress: 'paused',
      score: 0,
      paused: true,
      pauseReason: 'operator-invalid-paused',
      pausedAt: text(priorJourney?.pausedAt || now, 80)
    },
    _linePauseSnapshot: snapshot,
    restored: false,
    paused: true,
    snapshot
  };
}

function restoredLineState(contact = {}, now = new Date().toISOString()) {
  const snapshot = validPauseSnapshot(contact?._linePauseSnapshot) ? contact._linePauseSnapshot : null;
  if (!snapshot) {
    return {
      lineIntent: 'none', lineIntentScore: 0, lineProgress: 'not_started', lineEvidence: '',
      _lineJourney: { ...cloneObject(contact?._lineJourney), paused: false, resumedAt: text(now, 80) },
      _linePauseSnapshot: null, restored: true, paused: false, snapshot: null,
      targetLineAccountId: '', targetLineAccountName: ''
    };
  }
  const journey = cloneObject(snapshot.lineJourney);
  return {
    lineIntent: text(snapshot.lineIntent, 30) || 'none',
    lineIntentScore: score(snapshot.lineIntentScore),
    lineProgress: text(snapshot.lineProgress, 40) || 'not_started',
    lineEvidence: text(snapshot.lineEvidence, 360),
    _lineJourney: { ...journey, paused: false, resumedAt: text(now, 80) },
    _linePauseSnapshot: null,
    restored: true,
    paused: false,
    snapshot: { ...snapshot },
    targetLineAccountId: text(snapshot.targetLineAccountId, 128),
    targetLineAccountName: text(snapshot.targetLineAccountName, 160)
  };
}

function synchronizeLineStateForStage(contact = {}, stage = '', now = new Date().toISOString()) {
  const normalizedStage = text(stage, 40);
  if (['无效/暂停','无效'].includes(normalizedStage)) return pausedLineState(contact, now);
  if (text(contact?.lineIntent, 30) === 'paused' || text(contact?.lineProgress, 40) === 'paused') {
    return restoredLineState(contact, now);
  }
  return {
    lineIntent: text(contact?.lineIntent, 30) || 'none',
    lineIntentScore: score(contact?.lineIntentScore),
    lineProgress: text(contact?.lineProgress, 40) || 'not_started',
    lineEvidence: text(contact?.lineEvidence, 360),
    _lineJourney: cloneObject(contact?._lineJourney),
    _linePauseSnapshot: validPauseSnapshot(contact?._linePauseSnapshot) ? { ...contact._linePauseSnapshot } : null,
    restored: false,
    paused: false,
    snapshot: validPauseSnapshot(contact?._linePauseSnapshot) ? { ...contact._linePauseSnapshot } : null,
    targetLineAccountId: text(contact?.targetLineAccountId, 128),
    targetLineAccountName: text(contact?.targetLineAccountName, 160)
  };
}

function needsPausedLineRepair(contact = {}) {
  return text(contact?.platform, 20).toLowerCase() !== 'line'
    && ['无效/暂停','无效'].includes(text(contact?.stage, 40))
    && (text(contact?.lineIntent, 30) !== 'paused' || text(contact?.lineProgress, 40) !== 'paused');
}

module.exports = {
  capturePauseSnapshot,
  pausedLineState,
  restoredLineState,
  synchronizeLineStateForStage,
  needsPausedLineRepair
};
