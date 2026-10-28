'use strict';

// V1.27.82 — translation quality helpers. Keep this module pure so the quality
// rules can be unit-tested without booting Electron or a provider.

const EMOJI_RE = /(?:[\u{1F1E6}-\u{1F1FF}]{2}|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?)/gu;

function clean(value = '') {
  return String(value || '').replace(/\u0000/g, '').trim();
}

function extractEmojiTokens(text = '') {
  const out = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(EMOJI_RE)) {
    const token = String(match[0] || '');
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function decodeBasicEntities(value = '') {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function normalizePhraseKey(text = '') {
  let value = String(text || '').normalize('NFKC').trim();
  value = value.replace(EMOJI_RE, '');
  value = value
    .replace(/[\s\uFE0F]+/g, ' ')
    .replace(/[。．.!！?？…~〜～]+$/g, '')
    .trim()
    .toLowerCase();
  return value;
}

const SHORT_JA_ZH = new Map([
  ['はい', '是的'],
  ['うん', '嗯'],
  ['ううん', '不是'],
  ['そうです', '是的'],
  ['そうだね', '是啊'],
  ['そうですね', '是啊'],
  ['そうなんだ', '原来如此'],
  ['そうなんですね', '原来如此啊'],
  ['わかった', '明白了'],
  ['分かった', '明白了'],
  ['了解', '明白'],
  ['ありがとう', '谢谢'],
  ['ありがとうございます', '谢谢你'],
  ['おはよう', '早上好'],
  ['おはようございます', '早上好'],
  ['こんにちは', '你好'],
  ['こんばんは', '晚上好'],
  ['おやすみ', '晚安'],
  ['おやすみなさい', '晚安'],
  ['さようなら', '再见'],
  ['またね', '回头见'],
  ['いいね', '不错呢'],
  ['頑張って', '加油'],
  ['がんばって', '加油'],
  ['頑張ろう', '一起加油吧'],
  ['がんばろう', '一起加油吧'],
  ['本当', '真的吗？'],
  ['ほんと', '真的吗？'],
  ['もっとrelax', '再放松一点'],
  ['see u', '回头见'],
  ['see you', '回头见']
]);

function looksLikeJapaneseShortChat(text = '') {
  const key = normalizePhraseKey(text);
  if (!key) return false;
  if (SHORT_JA_ZH.has(key)) return true;
  // Pure-kanji Japanese chat can otherwise be mistaken for Chinese by a cheap
  // script detector. Keep this list deliberately small and conversational.
  return /^(?:大丈夫|仕事|朝食|昼食|夕食|本気|残念|元気|素敵|最高|無理|安心|心配|幸せ|久々|久しぶり|初対面|返信|連絡|感謝|約束|気分|休日|休憩|散歩|運動|東京|大阪|日本)$/u.test(key);
}

function canonicalShortChatTranslation(text, source = 'auto', target = 'zh') {
  const raw = clean(text);
  if (!raw) return '';
  const sourceCode = String(source || 'auto').toLowerCase();
  const targetCode = String(target || 'zh').toLowerCase();
  if (!['auto', 'ja', 'japanese'].includes(sourceCode)) return '';
  if (!['zh', 'zh-cn', 'zh-hans', 'chinese', 'simplified chinese'].includes(targetCode)) return '';
  const key = normalizePhraseKey(raw);
  const mapped = SHORT_JA_ZH.get(key);
  if (!mapped) return '';
  const emojis = extractEmojiTokens(raw);
  let out = mapped;
  for (const emoji of emojis) if (!out.includes(emoji)) out += emoji;
  return out;
}

function finalizeTranslationQuality({ text = '', translated = '', source = 'auto', target = 'zh' } = {}) {
  const original = clean(text);
  let result = decodeBasicEntities(translated)
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^(?:翻译|译文|Translation)\s*[:：]\s*/i, '')
    .trim();
  if (!result) throw new Error('翻译没有返回有效译文。');

  const leakage = /(?:RECENT CONTEXT|CURRENT MESSAGE|SOURCE LANGUAGE|TARGET LANGUAGE|reference only|return translated text only)/i;
  if (leakage.test(result) && !leakage.test(original)) {
    throw new Error('翻译结果包含提示词/上下文泄漏，已阻止显示。');
  }

  const sourceLen = [...original].length;
  const resultLen = [...result].length;
  if (sourceLen > 0 && sourceLen <= 18 && resultLen > Math.max(56, sourceLen * 6)) {
    throw new Error('短消息译文异常扩写，已阻止显示。');
  }

  // Providers occasionally drop emoji even though it carries chat tone. Restore
  // only emoji that existed in the source; never invent a new one.
  for (const emoji of extractEmojiTokens(original)) {
    if (!result.includes(emoji)) result += emoji;
  }

  return result.trim();
}

module.exports = {
  extractEmojiTokens,
  normalizePhraseKey,
  canonicalShortChatTranslation,
  looksLikeJapaneseShortChat,
  finalizeTranslationQuality
};
