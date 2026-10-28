'use strict';

const crypto = require('crypto');

function clean(value, limit = 1200) {
  return String(value || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizedRows(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map(item => ({
      // V1.24.0 Hotfix1: DOM snapshots must carry an explicit role. Never turn
      // an object with a missing/unknown role into a customer message: doing so
      // can learn Yoko's own outgoing text as customer long-term memory when a
      // web renderer temporarily loses alignment metadata during hydration.
      // Plain strings are kept as customer input for deterministic unit tests
      // and direct helper usage only.
      role: String(typeof item === 'string' ? 'customer' : (item?.role || '')).toLowerCase(),
      text: clean(typeof item === 'string' ? item : item?.text, 1800),
      delivered: Number(item?.delivered || item?.timestamp || 0) || 0
    }))
    .filter(row => row.text && ['customer','incoming','me','outgoing'].includes(row.role))
    .map(row => ({ ...row, role:(row.role === 'me' || row.role === 'outgoing') ? 'me' : 'customer' }));
}

function looksLikeLineNegative(text = '') {
  const value = clean(text, 700);
  return /(?:\bLINE\b|ライン).{0,42}(?:ありません|ないです|ないよ|使っていません|使ってない|持っていません|持ってない|やっていません|やってない|不要|使わない|苦手|没有|沒有|不用|不使用|没用|沒用|don'?t\s+use|do\s+not\s+use|no\s+line)/iu.test(value)
    || /(?:ありません|使っていません|使ってない|持っていません|持ってない|不要|没有|沒有|不用|don'?t\s+use|no).{0,28}(?:\bLINE\b|ライン)/iu.test(value);
}

function looksLikeLineHighInterest(text = '') {
  const value = clean(text, 900);
  if (looksLikeLineNegative(value)) return false;
  return /(?:\bLINE\b|ライン).{0,60}(?:交換したい|交換しよう|交換できます|交換できる|ID.*教えて|ID.*ください|追加したい|追加できます|追加できる|友達になりたい|教えて|QR|リンク|加你|加妳|加我|交换|交換|加好友|添加|给我.*ID|給我.*ID|add\s+you|add\s+me|exchange|your\s+line\s+id|line\s+id)/iu.test(value)
    || /(?:交換したい|交換しよう|ID.*教えて|追加したい|加好友|交换|exchange).{0,35}(?:\bLINE\b|ライン)/iu.test(value);
}

function looksLikeLinePositive(text = '') {
  const value = clean(text, 700);
  if (looksLikeLineNegative(value)) return false;
  return /(?:\bLINE\b|ライン).{0,42}(?:あります|あるよ|持ってます|持っています|使ってます|使っています|できます|できる|可以|有|有的|有啊|yes|yeah|sure)/iu.test(value);
}

function looksLikeLineQuestion(text = '') {
  const value = clean(text, 700);
  return /(?:\bLINE\b|ライン).{0,44}(?:ありますか|ある\?|使っていますか|使ってますか|持っていますか|持ってますか|交換|教えて|ID|追加|友達|できますか|できる|嗎|吗|有吗|有嗎|交换|交換|加一下|加好友|do you have|use line|line id)/iu.test(value)
    || /(?:ありますか|ある\?|交換|追加|教えて|ID).{0,30}(?:\bLINE\b|ライン)/iu.test(value);
}

function looksLikeShortPositive(text = '') {
  const value = clean(text, 120);
  return /^(?:(?:はい|ええ|うん)[、,\s]*)?(?:あります|あるよ|ありますよ|持ってます|持っています|使ってます|使っています|できます|できる|可以|有|有的|有啊|可以啊|好啊|可以的|yes|yeah|yep|sure|ok|okay)[。！!\s]*$/iu.test(value);
}

function looksLikeOperatorInvite(text = '') {
  const value = clean(text, 1000);
  if (!/(?:\bLINE\b|ライン)/iu.test(value)) return false;
  return /(?:私の|僕の|こちら|これが|我的|这是我的|這是我的).{0,30}(?:\bLINE\b|ライン)/iu.test(value)
    || /(?:\bLINE\b|ライン).{0,58}(?:ID|アイディー|追加してください|追加して|友達追加|交換しませんか|交換しましょう|QR|リンク|link|加我|添加我|加一下|好友|exchange|add me)/iu.test(value)
    || /(?:ID|QR|リンク|link).{0,36}(?:\bLINE\b|ライン)/iu.test(value);
}

function looksLikeAdded(text = '') {
  const value = clean(text, 700);
  return /(?:\bLINE\b|ライン).{0,38}(?:追加しました|追加した|登録しました|登録した|友達追加しました|加了|添加了|加好了|添加好了|added|sent)/iu.test(value)
    || /(?:追加しました|追加した|登録しました|登録した|加了|添加了|加好了|添加好了|added).{0,28}(?:\bLINE\b|ライン)/iu.test(value);
}

function looksLikeContextualAddedReply(text = '') {
  const value = clean(text, 240);
  // Real TikTok replies often omit the word LINE because the immediately
  // preceding outgoing bubble already contains the LINE ID / QR / link. Accept
  // natural confirmations with a short trailing sentence, e.g.
  // "追加しました。メッセージを送りました。" or "もうあなたを追加しました".
  return /^(?:(?:私は|僕は|わたしは|こちらは)\s*)?(?:(?:もう|すでに|先ほど)\s*)?(?:(?:あなた|優子さん|Yoko)を\s*)?(?:友達追加しました|追加しました|追加したよ|登録しました|登録したよ|できました|加了|添加了|添加好了|加好了|added)(?:[。！!、,\s]|$)/iu.test(value);
}

function analyzeLineJourney(messages = []) {
  const rows = normalizedRows(messages);
  let previous = null;
  const events = [];
  for (const row of rows) {
    const text = row.text;
    if (row.role === 'me') {
      if (looksLikeOperatorInvite(text)) events.push({ kind:'invite', role:'me', text, delivered:row.delivered });
      previous = row;
      continue;
    }
    if (looksLikeAdded(text)) events.push({ kind:'added', role:'customer', text, delivered:row.delivered });
    else if (looksLikeLineNegative(text)) events.push({ kind:'negative', role:'customer', text, delivered:row.delivered });
    else if (looksLikeLineHighInterest(text)) events.push({ kind:'high', role:'customer', text, delivered:row.delivered });
    else if (looksLikeLinePositive(text)) events.push({ kind:'positive', role:'customer', text, delivered:row.delivered });
    else if (previous?.role === 'me' && looksLikeLineQuestion(previous.text) && looksLikeShortPositive(text)) {
      events.push({ kind:'positive', role:'customer', text, delivered:row.delivered, contextual:true });
    }
    if (previous?.role === 'me' && looksLikeOperatorInvite(previous.text) && looksLikeContextualAddedReply(text)) {
      events.push({ kind:'added', role:'customer', text, delivered:row.delivered, contextual:true });
    }
    previous = row;
  }

  let intent = 'none';
  let progress = 'not_started';
  let evidence = '';
  let reason = '尚未识别到 LINE 意向';
  let score = 0;
  let lastRelevant = null;
  for (const event of events) {
    lastRelevant = event;
    if (event.kind === 'positive') { intent = intent === 'high' ? 'high' : 'positive'; progress = progress === 'waiting_add' ? 'waiting_add' : 'interested'; score = Math.max(score, 55); reason = '客户表示正在使用或可以使用 LINE'; }
    if (event.kind === 'high') { intent = 'high'; progress = progress === 'waiting_add' ? 'waiting_add' : 'interested'; score = Math.max(score, 85); reason = '客户主动提出交换、添加或索要 LINE'; }
    if (event.kind === 'invite') { progress = 'waiting_add'; score = Math.max(score, intent === 'high' ? 90 : 70); reason = '已向客户发送 LINE 引导，等待添加'; }
    if (event.kind === 'negative') { intent = 'negative'; progress = 'declined'; score = 0; reason = '客户表示暂不使用或不希望使用 LINE'; }
    if (event.kind === 'added') { intent = 'high'; progress = 'added'; score = 100; reason = '客户已确认添加 LINE'; }
  }
  evidence = clean(lastRelevant?.text, 360);
  return {
    intent,
    progress,
    score,
    reason,
    evidence,
    eventCount:events.length,
    lastEvent:lastRelevant?.kind || '',
    events:events.slice(-8)
  };
}

function detectPhotoExchange(messages = []) {
  const rows = normalizedRows(messages);
  let customerEvidence = '';
  let operatorEvidence = '';
  const completed = /(?:写真|画像|photo|picture|照片).{0,36}(?:交換しました|交換した|送りました|送った|送信しました|見せました|見せた|受け取りました|受け取った|收到|收到了|发了|發了|发送了|傳了|sent|shared|exchanged)/iu;
  const thanks = /(?:写真|画像|photo|picture|照片).{0,28}(?:ありがとう|ありがと|thanks?|thank you|谢谢|謝謝)/iu;
  for (const row of rows) {
    if (row.role === 'customer' && (completed.test(row.text) || thanks.test(row.text))) customerEvidence = row.text;
    if (row.role === 'me' && completed.test(row.text)) operatorEvidence = row.text;
  }
  const exchanged = !!customerEvidence || (!!operatorEvidence && rows.some(row => row.role === 'customer' && /(?:見た|見ました|ありがとう|thanks?|收到|看到了|看見了)/iu.test(row.text)));
  return { exchanged, evidence:clean(customerEvidence || operatorEvidence, 360) };
}

const MEMORY_TYPES = [
  // V1.27.26: facts without dedicated CRM boxes remain durable memories.
  { type:'relationship_status', label:'婚姻/关系状态', pattern:/(?:独身|未婚|既婚|結婚しています|結婚している|離婚|バツ[一二三123]|单身|單身|已婚|离婚|離婚|single|married|divorced)/iu },
  { type:'profile_nationality', label:'国籍/出身背景', pattern:/(?:国籍|國籍|スリランカ人|日本人|中国人|韓国人|台湾人|タイ人|ベトナム人|フィリピン人|インド人|ネパール人|アメリカ人|イギリス人|Sri Lankan|Japanese|Chinese|Korean|Taiwanese|Thai|Vietnamese|Filipino|Indian|Nepali|American|British)/iu },
  // V1.27.37: birthplace / upbringing is durable background, not current residence.
  // Example: `東京生まれ、アメリカ育ちです` must be remembered without
  // overwriting the CRM region box with Tokyo or America.
  { type:'profile_origin_growth', label:'出生/成长背景', pattern:/(?:生まれ|生れ|出生|生于|生於|出生于|出生於|育ち|育った|育ちです|長大|长大|成長|成长|grew\s+up|born\s+in)/iu },
  { type:'family', label:'家庭', pattern:/(?:母|父|両親|親|妻|夫|嫁|旦那|息子|娘|子供|子ども|孫|兄|姉|弟|妹|家族|母亲|母親|父亲|父親|父母|妻子|丈夫|儿子|兒子|女儿|女兒|孩子|孫|family|wife|husband|son|daughter|children|kids?)/iu },
  { type:'pet', label:'宠物', pattern:/(?:ペット|犬|猫|柴犬|愛犬|愛猫|ハムスター|うさぎ|宠物|寵物|狗|猫|貓|dog|cat|pet|hamster|rabbit)/iu },
  { type:'rest_day', label:'休息日', pattern:/(?:休み|休日|定休日|土日休|日曜休|周末休|週末休|休息日|day off|weekend off)/iu },
  { type:'routine', label:'生活习惯', pattern:/(?:毎朝|毎晩|毎日|いつも|習慣|朝は|夜は|下班后|下班後|每天|每日|每早|每晚|usually|every morning|every night|every day)/iu },
  { type:'plan', label:'近期计划', pattern:/(?:明日|明後日|今週|来週|今月|来月|今年|予定|行く予定|する予定|计划|計劃|打算|明天|后天|後天|下周|下週|下个月|下個月|tomorrow|next week|next month|plan to|going to)/iu },
  { type:'preference', label:'偏好', pattern:/(?:好き|大好き|好物|お気に入り|喜欢|喜歡|爱吃|愛吃|prefer|favorite|favourite|like to|likes?)/iu },
  { type:'dislike', label:'不喜欢/雷区', pattern:/(?:苦手|嫌い|好きじゃない|不喜欢|不喜歡|讨厌|討厭|不喝酒|don't like|do not like|hate|not into)/iu },
  { type:'work_schedule', label:'工作时间', pattern:/(?:仕事は|勤務|出勤|退勤|夜勤|日勤|朝\d{1,2}時|\d{1,2}時から|\d{1,2}時まで|上班|下班|工作时间|工作時間|shift|work from|work until)/iu },
  { type:'important_date', label:'重要日期', pattern:/(?:誕生日|生日|記念日|纪念日|紀念日|birthday|anniversary)/iu },
  // V1.27.17 shared profile memories are deliberately lower priority than
  // semantic memories such as family/pet/routine. For example “母と一緒に住んで
  // います” is a family fact, not an address merely because it contains 住んで.
  { type:'profile_location', label:'居住/地区', pattern:/(?:住まい|住居|住所|居住地|在住|住んで|住在|来自|出身|live in|from)/iu },
  { type:'profile_work', label:'工作', pattern:/(?:仕事|職業|職種|勤務先|勤め先|働いて|勤めて|勤務|工作|职业|職業|上班|work as|work at|occupation)/iu },
  { type:'profile_interest', label:'兴趣爱好', pattern:/(?:趣味|好き|大好き|興味|兴趣|興趣|爱好|愛好|hobby|interests?|like to)/iu },
  { type:'photo_exchange', label:'照片交换', pattern:/(?:写真|画像|photo|picture|照片).{0,36}(?:交換しました|交換した|送りました|送った|見せました|見せた|ありがとう|thanks?|收到|发了|發了|sent|shared|exchanged)/iu }
];

function sentenceFragments(text = '') {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  return raw.split(/(?<=[。！？!?])|\n+|(?<=ですか)\s+/u).map(v => clean(v, 360)).filter(Boolean);
}

function normalizedMemoryKey(type, text) {
  return `${type}:${clean(text, 260).toLocaleLowerCase().replace(/[。！？!?，,、\s]+$/u, '')}`;
}

function extractLongTermMemory(messages = []) {
  const normalized = normalizedRows(messages);
  const outgoingTexts = new Set(normalized.filter(row => row.role === 'me').map(row => clean(row.text, 1800).toLocaleLowerCase()));
  const rows = normalized.filter(row => row.role === 'customer');
  const items = [];
  const seen = new Set();
  for (const row of rows) {
    // Defensive ambiguity guard for virtualized web chat DOMs: if the exact
    // same bubble text was observed as an outgoing row in this snapshot, do
    // not persist it as customer memory. A false negative is safer than
    // contaminating the customer's profile with Yoko's own facts.
    if (outgoingTexts.has(clean(row.text, 1800).toLocaleLowerCase())) continue;
    for (const fragment of sentenceFragments(row.text)) {
      if (!fragment || fragment.length < 3 || fragment.length > 320) continue;
      if (/[?？]$/u.test(fragment) || /(?:ですか|ますか|でしょうか|吗|嗎|呢)[。？?]*$/u.test(fragment)) continue;
      for (const rule of MEMORY_TYPES) {
        if (!rule.pattern.test(fragment)) continue;
        const key = normalizedMemoryKey(rule.type, fragment);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          id: crypto.createHash('sha1').update(key).digest('hex').slice(0,16),
          type:rule.type,
          label:rule.label,
          text:clean(fragment.replace(/[。！？!?]+$/u, ''), 280),
          evidence:clean(fragment, 320),
          delivered:Number(row.delivered || 0) || 0
        });
        break;
      }
    }
  }
  return items.slice(-40);
}


function pruneLongTermMemoryAgainstOutgoing(existing = [], messages = []) {
  const rows = normalizedRows(messages);
  const customerFragments = new Set();
  const outgoingFragments = new Set();
  for (const row of rows) {
    const target = row.role === 'me' ? outgoingFragments : customerFragments;
    for (const fragment of sentenceFragments(row.text)) {
      const value = clean(fragment.replace(/[。！？!?]+$/u, ''), 280).toLocaleLowerCase();
      if (value) target.add(value);
    }
  }
  const items = [];
  const removed = [];
  for (const raw of Array.isArray(existing) ? existing : []) {
    const text = clean(raw?.text, 280);
    const key = text.toLocaleLowerCase();
    // Repair profiles polluted by older builds: remove an existing memory only
    // when the current snapshot proves the exact fact is Yoko/outgoing and no
    // customer bubble in the same snapshot says the same thing. If both sides
    // genuinely said it, keep the customer's fact.
    if (key && outgoingFragments.has(key) && !customerFragments.has(key)) {
      removed.push(raw);
      continue;
    }
    items.push(raw);
  }
  return { items, removed };
}

function mergeLongTermMemory(existing = [], incoming = [], now = new Date().toISOString()) {
  const out = [];
  const byKey = new Map();
  for (const raw of Array.isArray(existing) ? existing : []) {
    const text = clean(raw?.text, 280);
    const type = clean(raw?.type, 40) || 'other';
    if (!text) continue;
    const key = normalizedMemoryKey(type, text);
    const row = {
      id:String(raw?.id || crypto.createHash('sha1').update(key).digest('hex').slice(0,16)),
      type,
      label:clean(raw?.label, 40) || type,
      text,
      evidence:clean(raw?.evidence || text, 320),
      firstSeenAt:String(raw?.firstSeenAt || raw?.updatedAt || now),
      updatedAt:String(raw?.updatedAt || now),
      delivered:Number(raw?.delivered || 0) || 0
    };
    byKey.set(key, row);
    out.push(row);
  }
  const added = [];
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const text = clean(raw?.text, 280);
    const type = clean(raw?.type, 40) || 'other';
    if (!text) continue;
    const key = normalizedMemoryKey(type, text);
    if (byKey.has(key)) {
      const row = byKey.get(key);
      row.updatedAt = now;
      if (raw?.delivered) row.delivered = Number(raw.delivered) || row.delivered;
      continue;
    }
    const row = {
      id:String(raw?.id || crypto.createHash('sha1').update(key).digest('hex').slice(0,16)),
      type,
      label:clean(raw?.label, 40) || type,
      text,
      evidence:clean(raw?.evidence || text, 320),
      firstSeenAt:now,
      updatedAt:now,
      delivered:Number(raw?.delivered || 0) || 0
    };
    byKey.set(key, row);
    out.push(row);
    added.push(row);
  }
  out.sort((a,b) => (Number(a.delivered || 0) - Number(b.delivered || 0)) || String(a.updatedAt).localeCompare(String(b.updatedAt)));
  return { items:out.slice(-80), added };
}

function buildMemorySummary(items = [], limit = 8) {
  const rows = (Array.isArray(items) ? items : []).slice(-Math.max(1, Math.min(16, Number(limit) || 8)));
  return rows.map(row => `${clean(row?.label, 30)}：${clean(row?.text, 120)}`).filter(Boolean).join('；').slice(0, 1200);
}

function lineIntentLabel(value = '') {
  return ({ none:'暂无', positive:'有意向', high:'高意向', negative:'暂不使用', paused:'已暂停' })[String(value || '')] || '暂无';
}

function lineProgressLabel(value = '') {
  return ({ not_started:'未开始', interested:'发现意向', waiting_add:'已邀请/等待添加', added:'已添加', declined:'暂不使用LINE', paused:'暂停跟进' })[String(value || '')] || '未开始';
}

module.exports = {
  normalizedRows,
  analyzeLineJourney,
  detectPhotoExchange,
  extractLongTermMemory,
  pruneLongTermMemoryAgainstOutgoing,
  mergeLongTermMemory,
  buildMemorySummary,
  lineIntentLabel,
  lineProgressLabel,
  looksLikeLineNegative,
  looksLikeLineHighInterest,
  looksLikeLinePositive,
  looksLikeOperatorInvite,
  looksLikeAdded,
  looksLikeContextualAddedReply
};
