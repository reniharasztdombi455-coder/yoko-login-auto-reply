'use strict';

function clean(value, max = 600) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizedName(value = '') {
  return clean(value, 220).toLocaleLowerCase();
}

function weakNameIdentity(value = '') {
  return /^name:/i.test(clean(value, 520));
}

function strongConversationIdentity(value = '') {
  const id = clean(value, 520);
  return !!id && !weakNameIdentity(id);
}

function durableThreadToken(value = '') {
  const id = clean(value, 520);
  const match = id.match(/^(?:fb|mb)-thread:(.+)$/i);
  return match ? clean(match[1], 500).toLocaleLowerCase() : '';
}

function sameDurableConversationId(a = '', b = '') {
  const left = clean(a, 520);
  const right = clean(b, 520);
  if (!strongConversationIdentity(left) || !strongConversationIdentity(right)) return false;
  if (left === right) return true;
  const lt = durableThreadToken(left);
  const rt = durableThreadToken(right);
  return !!lt && !!rt && lt === rt;
}

function legacyIdentityDecision({ legacyContact = null, accountId = '', chatId = '', displayName = '' } = {}) {
  if (!legacyContact || typeof legacyContact !== 'object') return { matched:false, collision:false, reason:'missing-legacy' };
  const requestedAccount = clean(accountId, 160);
  const storedAccount = clean(legacyContact.accountId, 160);
  if (requestedAccount && storedAccount && requestedAccount !== storedAccount) {
    return { matched:false, collision:true, reason:'account-mismatch' };
  }

  const requestedChat = clean(chatId, 520);
  const storedChat = clean(legacyContact.chatId, 520);
  if (requestedChat) {
    // A name-derived id is not identity proof. Never migrate a legacy name key
    // into it automatically, otherwise a second customer with the same display
    // name can inherit the first customer's CRM profile.
    if (!strongConversationIdentity(requestedChat)) {
      return { matched:false, collision:true, reason:'weak-name-identity' };
    }
    if (sameDurableConversationId(requestedChat, storedChat)) {
      return { matched:true, collision:false, reason:'same-strong-chat-id' };
    }
    return { matched:false, collision:true, reason:storedChat ? 'chat-id-mismatch' : 'legacy-missing-chat-id' };
  }

  // Name-only callers exist for old/manual views. They may read the legacy row,
  // but this path must never be used when a stronger chat identity is available.
  const requestedName = normalizedName(displayName);
  const storedName = normalizedName(legacyContact.displayName || legacyContact.name);
  if (requestedName && storedName && requestedName !== storedName) {
    return { matched:false, collision:true, reason:'name-mismatch' };
  }
  return { matched:true, collision:false, reason:'name-only-legacy-read' };
}

function facebookCrossSurfaceIdentityMatch(contact = {}, { chatId = '' } = {}) {
  const requested = clean(chatId, 520);
  const stored = clean(contact?.chatId, 520);
  // Never bridge Facebook/Meta records by display name alone. Only a durable
  // thread id (same canonical token across fb-thread:/mb-thread:) is proof.
  return sameDurableConversationId(requested, stored);
}

function tokenList(value = '') {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,，、;；/|\n]+/);
  return [...new Set(raw.map(v => clean(v, 500)).filter(Boolean))];
}

function evidenceIdentityConflict(evidence = null, { accountId = '', chatId = '' } = {}) {
  if (!evidence || typeof evidence !== 'object') return false;
  const expectedAccount = clean(accountId, 160);
  const sourceAccount = clean(evidence.accountId, 160);
  if (expectedAccount && sourceAccount && expectedAccount !== sourceAccount) return true;
  const expectedChat = clean(chatId, 520);
  const sourceChat = clean(evidence.chatId, 520);
  return strongConversationIdentity(expectedChat) && strongConversationIdentity(sourceChat) && !sameDurableConversationId(expectedChat, sourceChat);
}

function isolateAutoOwnedContact(contact = {}, { accountId = '', chatId = '', stableKey = '' } = {}) {
  if (!contact || typeof contact !== 'object') return { contact:{}, changed:false, quarantined:[] };
  const next = { ...contact };
  const auto = contact._autoExtract && typeof contact._autoExtract === 'object'
    ? { ...contact._autoExtract }
    : {};
  auto.fieldEvidence = auto.fieldEvidence && typeof auto.fieldEvidence === 'object' ? { ...auto.fieldEvidence } : {};
  const priorScope = auto.identityScope && typeof auto.identityScope === 'object' ? auto.identityScope : null;
  const scopeConflict = !!priorScope?.stableKey && !!stableKey && clean(priorScope.stableKey, 128) !== clean(stableKey, 128);
  const quarantined = [];
  let changed = false;

  for (const field of ['name','region','age','occupation']) {
    const current = clean(next[field], field === 'age' ? 40 : 600);
    const owner = clean(auto[field], field === 'age' ? 40 : 600);
    const evidence = auto.fieldEvidence?.[field] || null;
    if (!owner || current !== owner) continue; // manual edit: never touch
    if (!scopeConflict && !evidenceIdentityConflict(evidence,{accountId,chatId})) continue;
    quarantined.push({ field, value:current, reason:scopeConflict?'identity-scope-mismatch':'evidence-chat-mismatch', evidence });
    next[field] = '';
    delete auto[field];
    delete auto.fieldEvidence[field];
    changed = true;
  }

  const currentInterests = tokenList(next.interests);
  const ownedInterests = tokenList(auto.interests);
  if (currentInterests.length && ownedInterests.length) {
    const evidenceRows = Array.isArray(auto.fieldEvidence?.interests) ? auto.fieldEvidence.interests : [];
    const conflictingTokens = new Set();
    if (scopeConflict) ownedInterests.forEach(v => conflictingTokens.add(v));
    else {
      for (const row of evidenceRows) {
        if (!evidenceIdentityConflict(row,{accountId,chatId})) continue;
        for (const value of tokenList(row?.value || row?.values || '')) conflictingTokens.add(value);
      }
    }
    if (conflictingTokens.size) {
      const kept = currentInterests.filter(v => !(conflictingTokens.has(v) && ownedInterests.includes(v)));
      const nextOwned = ownedInterests.filter(v => !conflictingTokens.has(v));
      if (kept.join('，') !== currentInterests.join('，')) {
        next.interests = kept.join('，');
        changed = true;
      }
      auto.interests = nextOwned;
      auto.fieldEvidence.interests = evidenceRows.filter(row => !evidenceIdentityConflict(row,{accountId,chatId}));
      quarantined.push(...[...conflictingTokens].map(value => ({field:'interests',value,reason:scopeConflict?'identity-scope-mismatch':'evidence-chat-mismatch'})));
    }
  }

  auto.identityScope = {
    stableKey:clean(stableKey,128),
    accountId:clean(accountId,160),
    chatId:clean(chatId,520),
    strength:strongConversationIdentity(chatId)?'strong':'weak-name'
  };
  if (quarantined.length) {
    auto.identityQuarantine = [...(Array.isArray(auto.identityQuarantine)?auto.identityQuarantine:[]), ...quarantined].slice(-40);
  }
  next._autoExtract = auto;
  return { contact:next, changed, quarantined };
}

module.exports = {
  clean,
  normalizedName,
  weakNameIdentity,
  strongConversationIdentity,
  durableThreadToken,
  sameDurableConversationId,
  legacyIdentityDecision,
  facebookCrossSurfaceIdentityMatch,
  evidenceIdentityConflict,
  isolateAutoOwnedContact
};
