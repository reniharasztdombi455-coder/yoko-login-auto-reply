'use strict';

function clean(v, n = 2000) {
  return String(v || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function normalizeIdentity(raw = {}) {
  return {
    name: clean(raw?.name || raw?.displayName, 180),
    handle: clean(raw?.handle, 180).replace(/^@/, '')
  };
}

/**
 * Verify that a preload message snapshot still belongs to the CRM target that
 * initiated the request. A fresh native-click hint may prove identity when the
 * TikTok header itself is temporarily blank. Explicit handle disagreement is a
 * hard conflict and must never be written through to the previous customer.
 */
function preloadSnapshotMatchesTarget(target = {}, snapshotIdentity = {}, hintIdentity = {}) {
  const t = normalizeIdentity(target);
  const s = normalizeIdentity(snapshotIdentity);
  const h = normalizeIdentity(hintIdentity);

  const snapshotConflict = !!(t.handle && s.handle && t.handle !== s.handle) ||
    !!(!t.handle && t.name && s.name && t.name !== s.name);
  const hintConflict = !!(t.handle && h.handle && t.handle !== h.handle) ||
    !!(!t.handle && t.name && h.name && t.name !== h.name);
  const verified = !snapshotConflict && !hintConflict && !!(
    (t.handle && (s.handle === t.handle || h.handle === t.handle)) ||
    (!t.handle && t.name && (s.name === t.name || h.name === t.name))
  );
  return { verified, conflict:snapshotConflict || hintConflict, target:t, snapshot:s, hint:h };
}

/**
 * Consume the exact privacy-local message snapshot emitted by external-preload.
 * This deliberately trusts only rows already classified as `customer` by the
 * production crmMessageRole() path used by GPT/customer-memory extraction.
 */
function findConfirmedCustomerLineAddedEvidence(rows = [], textMatcher = null) {
  const normalized = (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({
      role: clean(row?.role, 40).toLowerCase(),
      text: clean(row?.text, 2000),
      delivered: Number(row?.delivered || 0) || 0,
      timeText: clean(row?.timeText, 80),
      index
    }))
    .filter(row => row.text && (row.role === 'customer' || row.role === 'me'));

  const customer = normalized.filter(row => row.role === 'customer');
  const matches = typeof textMatcher === 'function'
    ? customer.filter(row => !!textMatcher(row.text))
    : [];
  const last = matches[matches.length - 1] || null;
  return {
    evidence: last?.text || '',
    messageCount: normalized.length,
    customerCount: customer.length,
    terminalCount: matches.length,
    evidenceDelivered: Number(last?.delivered || 0) || 0,
    evidenceTimeText: last?.timeText || ''
  };
}

module.exports = { findConfirmedCustomerLineAddedEvidence, preloadSnapshotMatchesTarget };
