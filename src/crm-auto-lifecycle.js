'use strict';

function clean(value, limit = 2000) {
  return String(value || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeRows(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map(item => ({
      // Keep lifecycle inference aligned with CRM memory extraction: web DOM
      // snapshots must carry an explicit direction. Unknown object roles are
      // ignored instead of being silently treated as customer messages.
      role: String(typeof item === 'string' ? 'customer' : (item?.role || '')).toLowerCase(),
      text: clean(typeof item === 'string' ? item : item?.text, 1600)
    }))
    .filter(row => row.text && ['customer','incoming','me','outgoing'].includes(row.role))
    .map(row => ({ ...row, role:(row.role === 'me' || row.role === 'outgoing') ? 'me' : 'customer' }));
}

const LEAD_STAGES = ['新进线','已接待','有效聊天','准备引导LINE','已邀请LINE','LINE已添加','无效/暂停'];
const LEAD_STAGE_RANK = new Map(LEAD_STAGES.map((stage, index) => [stage, index]));

function uniqueTexts(rows, role) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (row.role !== role) continue;
    const key = row.text.toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row.text);
  }
  return out;
}

function looksPositiveShortReply(text = '') {
  const value = clean(text, 120);
  return /^(?:(?:はい|ええ)[、,\s]*)?(?:あります|あるよ|ありますよ|持ってます|持っています|使ってます|使っています|可以|有|有的|有啊|可以啊|好啊|可以的|yes|yeah|yep|sure)[。！!\s]*$/iu.test(value);
}

function looksLikeLineQuestion(text = '') {
  const value = clean(text, 500);
  return /(?:\bLINE\b|ライン).{0,36}(?:ありますか|ある\?|使っていますか|使ってますか|持っていますか|持ってますか|交換|教えて|ID|追加|友達|できますか|できる|嗎|吗|有吗|有嗎|交换|交換|加一下|加好友|do you have|use line|line id)/iu.test(value)
    || /(?:ありますか|ある\?|交換|追加|教えて|ID).{0,24}(?:\bLINE\b|ライン)/iu.test(value);
}

function looksLikeCustomerLineInterest(text = '') {
  const value = clean(text, 800);
  if (/(?:\bLINE\b|ライン).{0,32}(?:ありません|使っていません|使ってない|持っていません|持ってない|やっていません|やってない|不要|使わない|没有|沒有|不用|不使用|don't use|do not use|no line)/iu.test(value)) return false;
  return /(?:\bLINE\b|ライン).{0,48}(?:あります|あるよ|使って|持って|交換|教えて|ID|追加|友達|できます|できる|欲しい|ほしい|想加|可以加|交换|交換|加好友|add|exchange|id)/iu.test(value)
    || /(?:交換|追加|教えて|ID|加好友|交换|add|exchange).{0,30}(?:\bLINE\b|ライン)/iu.test(value);
}

function looksLikeOperatorLineInvite(text = '') {
  const value = clean(text, 1000);
  const mentionsLine = /(?:\bLINE\b|ライン)/iu.test(value);
  if (!mentionsLine) return false;
  return /(?:私の|僕の|こちら|これが|我的|这是我的|這是我的).{0,22}(?:\bLINE\b|ライン)/iu.test(value)
    || /(?:\bLINE\b|ライン).{0,46}(?:ID|アイディー|追加してください|追加して|友達追加|交換しませんか|交換しましょう|QR|リンク|link|加我|添加我|加一下|好友|exchange|add me)/iu.test(value)
    || /(?:ID|QR|リンク|link).{0,30}(?:\bLINE\b|ライン)/iu.test(value);
}

function looksLikeLineAddedConfirmation(text = '') {
  const value = clean(text, 500);
  return /(?:\bLINE\b|ライン).{0,32}(?:追加しました|追加した|登録しました|登録した|友達追加しました|加了|添加了|加好了|添加好了|added|sent)/iu.test(value)
    || /(?:追加しました|追加した|登録しました|登録した|加了|添加了|加好了|添加好了|added).{0,24}(?:\bLINE\b|ライン)/iu.test(value);
}

function lineSignals(rows = []) {
  let customerInterest = false;
  let operatorInvite = false;
  let customerAdded = false;
  let previous = null;
  for (const row of rows) {
    if (row.role === 'me') {
      if (looksLikeOperatorLineInvite(row.text)) operatorInvite = true;
      previous = row;
      continue;
    }
    if (looksLikeLineAddedConfirmation(row.text)) customerAdded = true;
    if (looksLikeCustomerLineInterest(row.text)) customerInterest = true;
    if (previous?.role === 'me' && looksLikeLineQuestion(previous.text) && looksPositiveShortReply(row.text)) customerInterest = true;
    if (previous?.role === 'me' && looksLikeOperatorLineInvite(previous.text) && /^(?:(?:私は|僕は|わたしは|こちらは)\s*)?(?:(?:もう|すでに|先ほど)\s*)?(?:(?:あなた|優子さん|Yoko)を\s*)?(?:友達追加しました|追加しました|追加したよ|登録しました|登録したよ|できました|加了|添加了|添加好了|加好了|added)(?:[。！!、,\s]|$)/iu.test(clean(row.text, 240))) customerAdded = true;
    previous = row;
  }
  return { customerInterest, operatorInvite, customerAdded };
}

function inferredLeadStage(messages = [], facts = {}) {
  const rows = normalizeRows(messages);
  const customers = uniqueTexts(rows, 'customer');
  const operators = uniqueTexts(rows, 'me');
  const signals = lineSignals(rows);
  if (signals.customerAdded) return { stage:'LINE已添加', reason:'客户已确认添加 LINE', signals, metrics:{ customers:customers.length, operators:operators.length } };
  if (signals.operatorInvite) return { stage:'已邀请LINE', reason:'已发送明确 LINE 引导', signals, metrics:{ customers:customers.length, operators:operators.length } };
  if (signals.customerInterest) return { stage:'准备引导LINE', reason:'客户出现 LINE 意向', signals, metrics:{ customers:customers.length, operators:operators.length } };

  const factCount = ['name','age','region','occupation'].filter(key => clean(facts?.[key], 200)).length + (Array.isArray(facts?.interests) && facts.interests.length ? 1 : 0);
  const customerChars = customers.reduce((sum, text) => sum + clean(text, 500).length, 0);
  const substantive = operators.length >= 1 && customers.length >= 2 && (customerChars >= 18 || factCount >= 2);
  if (substantive) return { stage:'有效聊天', reason:'已经形成有效双向聊天', signals, metrics:{ customers:customers.length, operators:operators.length } };
  if (operators.length >= 1) return { stage:'已接待', reason:'已经完成首次接待回复', signals, metrics:{ customers:customers.length, operators:operators.length } };
  return { stage:'新进线', reason:'等待首次接待', signals, metrics:{ customers:customers.length, operators:operators.length } };
}

function chooseSafeLeadStage(currentStage = '新进线', inferred = {}, meta = {}) {
  const current = LEAD_STAGE_RANK.has(currentStage) ? currentStage : clean(currentStage, 40) || '新进线';
  const next = LEAD_STAGE_RANK.has(inferred?.stage) ? inferred.stage : current;
  if (current === '无效/暂停' || current === 'LINE已添加') return { stage:current, changed:false, locked:true, reason:'terminal-stage' };
  // V1.24.0 Hotfix6: LINE-added is a confirmed terminal conversion fact, not
  // merely another inferred intermediate stage. The confirmation can come from
  // the lifecycle signal in the current snapshot OR from the persisted LINE
  // journey state. This repairs contacts whose LINE progress was already saved
  // as `added` while a stale manual lock kept the CRM stage at 准备引导LINE /
  // 已邀请LINE. Explicit 无效/暂停 above still remains authoritative.
  const confirmedLineAdded = inferred?.confirmedLineAdded === true
    || inferred?.signals?.customerAdded === true
    || inferred?.lineProgress === 'added'
    || inferred?.lineJourney?.progress === 'added';
  if (next === 'LINE已添加' && confirmedLineAdded) {
    return { stage:'LINE已添加', changed:current !== 'LINE已添加', locked:false, reason:'客户已明确确认添加 LINE' };
  }
  if (meta?.stageLocked === true) return { stage:current, changed:false, locked:true, reason:'manual-stage' };
  const currentRank = LEAD_STAGE_RANK.get(current);
  const nextRank = LEAD_STAGE_RANK.get(next);
  if (!Number.isFinite(currentRank) || !Number.isFinite(nextRank) || nextRank <= currentRank) return { stage:current, changed:false, locked:false, reason:'no-forward-progress' };
  return { stage:next, changed:true, locked:false, reason:clean(inferred?.reason, 160) };
}

function interestTokens(value = '') {
  return String(value || '').split(/[,，、;；/|\n]+/).map(item => clean(item, 60)).filter(Boolean);
}

function buildAutoSummary(contact = {}, stage = '新进线') {
  const age = clean(contact?.age, 20);
  const region = clean(contact?.region, 100);
  const occupation = clean(contact?.occupation, 120);
  const interests = interestTokens(contact?.interests).slice(0, 6);
  const facts = [];
  if (age) facts.push(`${age}岁`);
  if (region) facts.push(`地区：${region}`);
  if (occupation) facts.push(`工作：${occupation}`);
  if (interests.length) facts.push(`兴趣：${interests.join('、')}`);

  const stageText = {
    '新进线':'新进线，等待首次接待。',
    '已接待':'已经接待，继续观察互动质量。',
    '有效聊天':'已形成有效聊天，可持续了解并寻找自然的 LINE 切入点。',
    '准备引导LINE':'客户已出现 LINE 意向，可自然引导添加。',
    '已邀请LINE':'已发送 LINE 引导，等待客户添加确认。',
    'LINE已添加':'客户已进入 LINE，后续转入关系维护。',
    '无效/暂停':'当前已暂停或标记为无效客户。'
  }[stage] || `当前阶段：${clean(stage, 40)}。`;

  const profile = facts.length ? `${facts.join('，')}。` : '基础资料仍在采集中。';
  const lineProgress = String(contact?.lineProgress || '').trim();
  const lineText = ({
    interested:'LINE：已识别客户意向。',
    waiting_add:'LINE：已邀请，等待客户添加。',
    added:'LINE：客户已确认添加。',
    declined:'LINE：客户暂不使用或暂不希望添加。'
  })[lineProgress] || '';
  const memoryCount = Array.isArray(contact?.memoryItems) ? contact.memoryItems.length : 0;
  const memoryText = memoryCount ? `长期记忆：${memoryCount}条。` : '';
  return clean(`${profile}${stageText}${lineText}${memoryText}`, 900);
}

module.exports = {
  LEAD_STAGES,
  normalizeRows,
  lineSignals,
  inferredLeadStage,
  chooseSafeLeadStage,
  buildAutoSummary,
  looksLikeLineQuestion,
  looksLikeCustomerLineInterest,
  looksLikeOperatorLineInvite,
  looksLikeLineAddedConfirmation
};
