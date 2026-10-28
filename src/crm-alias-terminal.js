'use strict';

function clean(value, limit = 5000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, limit);
}
function token(value = '') { return clean(value, 320).replace(/^@/, '').toLocaleLowerCase(); }
function isFallbackChatId(value = '') { return /^name:/i.test(clean(value, 320)); }
function splitAliases(contact = {}) {
  return Array.isArray(contact?.identityAliases) ? contact.identityAliases.map(token).filter(Boolean) : [];
}
function safeAliasKeys(contacts = {}, { accountId = '', chatId = '', displayName = '', handle = '' } = {}) {
  const account = clean(accountId, 128);
  const qChat = token(chatId);
  const qName = token(displayName);
  const qHandle = token(handle || (!isFallbackChatId(chatId) ? chatId : ''));
  if (!account || (!qChat && !qName && !qHandle)) return [];

  const result = [];
  for (const [key, contact] of Object.entries(contacts || {})) {
    if (!contact || typeof contact !== 'object') continue;
    if (clean(contact.accountId, 128) !== account) continue;
    const cChatRaw = clean(contact.chatId, 320);
    const cChat = token(cChatRaw);
    const cName = token(contact.displayName);
    const aliases = splitAliases(contact);
    const explicit = cChat && !isFallbackChatId(cChatRaw);

    let match = false;
    if (qChat && (cChat === qChat || aliases.includes(qChat))) match = true;
    if (qHandle && (cChat === qHandle || aliases.includes(qHandle))) match = true;

    // Name matching is intentionally restricted to fallback/legacy records.
    // Never update another concrete @handle merely because it shares a nickname.
    if (!match && qName) {
      const fallbackNameMatch = isFallbackChatId(cChatRaw) && (cName === qName || cChat === `name:${qName}`);
      const legacyNoChatMatch = !cChat && cName === qName;
      const aliasNameMatch = !explicit && aliases.includes(qName);
      if (fallbackNameMatch || legacyNoChatMatch || aliasNameMatch) match = true;
    }
    if (match) result.push(key);
  }
  return [...new Set(result)];
}

function ensureAddedTag(value = '') {
  const tags = clean(value, 600).split(/[,，、;；/\n]+/).map(v => v.trim()).filter(Boolean)
    .filter(v => !/^(?:已添加\s*LINE|LINE\s*已添加)$/i.test(v));
  tags.push('已添加LINE');
  return [...new Set(tags)].join('，').slice(0, 300);
}

function applyLineAddedTerminalToAliases(contacts = {}, query = {}, {
  evidence = '', now = new Date().toISOString(), businessFields = () => ({})
} = {}) {
  const keys = safeAliasKeys(contacts, query);
  const updatedKeys = [];
  const blockedKeys = [];
  for (const key of keys) {
    const existing = contacts[key];
    if (!existing || typeof existing !== 'object') continue;
    if (clean(existing.stage, 40) === '无效/暂停') { blockedKeys.push(key); continue; }
    const lifecycle = existing._autoLifecycle && typeof existing._autoLifecycle === 'object' ? { ...existing._autoLifecycle } : {};
    Object.assign(lifecycle, {
      stage:'LINE已添加', stageLocked:false, stageUpdatedAt:now,
      stageReason:'客户已明确确认添加 LINE', lastInferredStage:'LINE已添加',
      lastInferredReason:'客户已明确确认添加 LINE', lastAnalyzedAt:now
    });
    const journey = existing._lineJourney && typeof existing._lineJourney === 'object' ? { ...existing._lineJourney } : {};
    Object.assign(journey, {
      intent:'high', progress:'added', score:100,
      evidence:clean(evidence || existing.lineEvidence, 360),
      reason:'客户已明确确认添加 LINE', lastDetectedEvent:'added', updatedAt:now
    });
    contacts[key] = {
      ...existing,
      ...businessFields('LINE已添加'),
      stage:'LINE已添加',
      tags:ensureAddedTag(existing.tags),
      lineIntent:'high', lineIntentScore:100, lineProgress:'added',
      lineEvidence:clean(evidence || existing.lineEvidence, 360),
      _autoLifecycle:lifecycle, _lineJourney:journey, updatedAt:now
    };
    updatedKeys.push(key);
  }
  return { keys, updatedKeys, blockedKeys };
}

function terminalSatisfied(contact = {}) {
  return clean(contact.stage, 40) === 'LINE已添加'
    && clean(contact.lineProgress, 40) === 'added'
    && clean(contact.lineIntent, 30) === 'high'
    && Number(contact.lineIntentScore || 0) === 100
    && /(?:已添加\s*LINE|LINE\s*已添加)/i.test(clean(contact.tags, 300));
}

module.exports = { safeAliasKeys, applyLineAddedTerminalToAliases, terminalSatisfied, ensureAddedTag };

// V1.24.3: shared, production-grade detector for an explicit customer
// confirmation that LINE was already added. Keep this matcher conservative:
// it must describe a completed add/registration action and mention LINE.
function looksLikeConfirmedLineAddedText(text = '') {
  const value = clean(text, 900);
  if (!value) return false;
  return /(?:\bLINE\b|ライン).{0,48}(?:追加しました|追加した|追加済み|登録しました|登録した|友達追加しました|友だち追加しました|加了|添加了|加好了|添加好了|已经添加|已添加|already\s+added|added)/iu.test(value)
    || /(?:追加しました|追加した|追加済み|登録しました|登録した|友達追加しました|友だち追加しました|加了|添加了|加好了|添加好了|已经添加|已添加|already\s+added|added).{0,40}(?:\bLINE\b|ライン)/iu.test(value);
}

function reconcileLineAddedTerminalAliases(contacts = {}, query = {}, options = {}) {
  const keys = safeAliasKeys(contacts, query);
  const terminalKeys = keys.filter(key => terminalSatisfied(contacts[key] || {}));
  if (!terminalKeys.length) return { reconciled:false, keys, terminalKeys, updatedKeys:[], blockedKeys:[] };
  const pendingKeys = keys.filter(key => {
    const contact = contacts[key] || {};
    return clean(contact.stage, 40) !== '无效/暂停' && !terminalSatisfied(contact);
  });
  if (!pendingKeys.length) return { reconciled:true, keys, terminalKeys, updatedKeys:[], blockedKeys:[] };
  const result = applyLineAddedTerminalToAliases(contacts, query, options);
  return { reconciled:true, terminalKeys, ...result };
}

module.exports.looksLikeConfirmedLineAddedText = looksLikeConfirmedLineAddedText;
module.exports.reconcileLineAddedTerminalAliases = reconcileLineAddedTerminalAliases;
