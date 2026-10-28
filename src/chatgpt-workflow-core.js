const crypto = require('node:crypto');

function normalizeChatgptText(value = '') {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b\u2060\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chatgptPromptFingerprint(value = '') {
  const normalized = normalizeChatgptText(value);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

class ChatgptWorkflowAuthority {
  constructor() {
    this.selectionEpoch = 0;
    this.selectionTargetKey = '';
    this.selectionReason = '';
    this.operationSeq = 0;
    this.activeMutation = null;
    this.staleRejectCount = 0;
    this.selectionChangeCount = 0;
  }

  noteSelection(targetKey = '', { sameLogical = false, reason = 'selection' } = {}) {
    const key = String(targetKey || '').trim();
    if (!key) return this.selectionEpoch;
    if (!this.selectionTargetKey) {
      this.selectionTargetKey = key;
      this.selectionReason = String(reason || 'selection');
      return this.selectionEpoch;
    }
    if (this.selectionTargetKey === key || sameLogical) {
      // Weak->strong identity hydration for the same human must not invalidate
      // an in-flight mutation lease merely because the platform changed its key.
      // Keep the lease's canonical key until that mutation finishes.
      if (!this.activeMutation) this.selectionTargetKey = key;
      this.selectionReason = String(reason || 'selection');
      return this.selectionEpoch;
    }
    this.selectionEpoch += 1;
    this.selectionChangeCount += 1;
    this.selectionTargetKey = key;
    this.selectionReason = String(reason || 'selection');
    this.activeMutation = null;
    return this.selectionEpoch;
  }

  clearSelection(reason = 'clear') {
    if (this.selectionTargetKey || this.activeMutation) this.selectionEpoch += 1;
    this.selectionTargetKey = '';
    this.selectionReason = String(reason || 'clear');
    this.activeMutation = null;
    return this.selectionEpoch;
  }

  beginMutation(targetKey = '', purpose = 'mutation') {
    const key = String(targetKey || '').trim();
    const lease = {
      id: ++this.operationSeq,
      targetKey: key,
      purpose: String(purpose || 'mutation'),
      selectionEpoch: this.selectionEpoch,
      startedAt: Date.now()
    };
    this.activeMutation = lease;
    return { ...lease };
  }

  isCurrent(lease = null, targetKey = '') {
    if (!lease || !this.activeMutation) return false;
    const key = String(targetKey || lease.targetKey || '').trim();
    return Number(lease.id || 0) === Number(this.activeMutation.id || 0)
      && Number(lease.selectionEpoch || 0) === Number(this.selectionEpoch || 0)
      && String(lease.targetKey || '') === key
      && String(this.selectionTargetKey || key) === key;
  }

  rejectStale() {
    this.staleRejectCount += 1;
  }

  finish(lease = null) {
    if (lease && this.activeMutation && Number(lease.id || 0) === Number(this.activeMutation.id || 0)) {
      this.activeMutation = null;
      return true;
    }
    return false;
  }

  snapshot() {
    return {
      selectionEpoch: this.selectionEpoch,
      selectionTargetKey: this.selectionTargetKey,
      selectionReason: this.selectionReason,
      selectionChangeCount: this.selectionChangeCount,
      staleRejectCount: this.staleRejectCount,
      activeMutation: this.activeMutation ? { ...this.activeMutation } : null
    };
  }
}

module.exports = {
  normalizeChatgptText,
  chatgptPromptFingerprint,
  ChatgptWorkflowAuthority
};
