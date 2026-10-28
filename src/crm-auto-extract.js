'use strict';

const crypto = require('crypto');

function cleanText(value, limit = 2000) {
  return String(value || '').replace(/[\u200b\u2060\ufeff]/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isYokoToolbarArtifactText(value) {
  const text = String(value || '').replace(/[\u200b\u2060\ufeff]/g, '').replace(/\u00a0/g, ' ').trim();
  if (!text) return false;
  const compact = text.replace(/\s+/g, '');
  return /^(?:⧉)?(?:复制|複製|Copy)(?:↻)?(?:重译|重譯)(?:↗)?GPT$/i.test(compact)
    || /^(?:复制|複製|Copy)(?:重译|重譯)GPT$/i.test(compact);
}

function stripYokoUiArtifacts(value, limit = 2000) {
  let text = String(value || '').replace(/\r\n/g, '\n').replace(/[\u200b\u2060\ufeff]/g, '').replace(/\u00a0/g, ' ');
  if (!text) return '';
  const toolbarTail = /\s*(?:⧉\s*)?(?:复制|複製|Copy)\s*(?:↻\s*)?(?:重译|重譯)\s*(?:↗\s*)?GPT\s*$/i;
  text = text.split('\n').map(line => {
    const raw = String(line || '');
    if (isYokoToolbarArtifactText(raw)) return '';
    return raw.replace(toolbarTail, '').trimEnd();
  }).filter(line => !isYokoToolbarArtifactText(line)).join('\n');
  return cleanText(text, limit);
}

function obviousConversationNoise(value, field = '') {
  const text = cleanText(value, 180);
  if (!text) return true;
  if (isYokoToolbarArtifactText(text)) return true;
  if (/^(?:ですか|ですね|ですよ|だよ|だね|そう(?:なん)?ですね|そうです|なるほど|了解|大丈夫|ありがとう|ありがとうございます|よろしく|宜しく|はい|いいえ)$/u.test(text)) return true;
  if (field === 'name' && /(?:優子|Yoko|好き|大好き|愛して|かわいい|可愛い|会いたい|ことが好き|ちゃん)/iu.test(text)) return true;
  if (field === 'region' && /(?:仕事|職業|楽しい|良い事|いい事|好き|ありがとう|よろしく|頑張|ですか|ですね|ですよ)/u.test(text)) return true;
  if (field === 'occupation' && /(?:楽しい|良い事|いい事|好き|ありがとう|よろしく|頑張|お疲れ|ですか|ですね|ですよ|そうなん|朝食|ランニング|返信|返事)/u.test(text)) return true;
  return false;
}

function uniqueTokens(value) {
  const raw = String(value || '')
    .split(/[,，、;；/|\n]+/)
    .map(item => item.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeTokens(existing, additions, limit = 500) {
  const out = uniqueTokens(existing);
  const seen = new Set(out.map(item => item.toLocaleLowerCase()));
  for (const raw of additions || []) {
    const item = cleanText(raw, 80);
    if (!item) continue;
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.join('、').slice(0, limit);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanText(match[1], 120);
  }
  return '';
}

function normalizeName(value) {
  const name = cleanText(value, 60)
    .replace(/^(?:私は|僕は|俺は|わたしは|名前は|名前が|本名は|呼び名は|ニックネームは|我叫|我是|名字叫|姓名是|my name is)\s*/i, '')
    // V1.23.65: keep the actual customer name and drop an optional kana/romanized
    // reading, e.g. 甜甜（ティエンティエン） / 山田太郎(やまだたろう).
    .replace(/\s*[（(][^）)]{1,40}[）)]\s*$/u, '')
    .replace(/(?:と申します|といいます|と言います|です|と呼んでください|と呼んで|と呼ばれています|と呼ばれてます|と呼ばれます)$/u, '')
    .replace(/[。！？!?,，、：:]$/u, '')
    .trim();
  if (!name || name.length > 40) return '';
  // V1.27.36: a CRM name must look like a durable person name, not a whole
  // conversational/action sentence. Real Meta chats commonly contain short
  // phrases such as "そろそろ休んでください" / "仕事頑張って" immediately
  // after a name question; old contextual extraction could store those as the
  // customer's name. Reject verb/action/status language and sentence endings.
  if (/(?:仕事|工作|上班|下班|加油|加油工作|休息|该休息|該休息|睡觉|睡覺|勤務|出勤|退勤|働|頑張|休(?:む|み|ん|んで|んだ|憩)|寝|眠|起き|帰|戻|行き|来て|食べ|飲ん|おやすみ|こんにちは|こんばんは|ありがとう|よろしく|無理|大変|好き|大好き|愛して|会いたい|かわいい|可愛い)/u.test(name)) return '';
  if (/(?:ください|下さい|ます|ました|ません|ましょう|してね|して下さい|してくださ|だよ|だね|ですよ|ですね|ですか)$/u.test(name)) return '';
  if (/[。！？!?]/u.test(name)) return '';
  if (/^(?:大丈夫|元気|そう|そうです|はい|いいえ|了解|分かりました|わかりました|谢谢|謝謝|没关系|沒關係|休み|休日|仕事|工作|加油|お疲れ様|おつかれさま)$/u.test(name)) return '';
  // V1.27.26: generic "私は X です" may describe a location/nationality.
  if (JAPAN_REGIONS.some(region => name.startsWith(region) && /[都道府県市区町村郡]/u.test(name))) return '';
  if (/^(?:スリランカ|日本|中国|韓国|台湾|タイ|ベトナム|フィリピン|インド|ネパール|アメリカ|英国|イギリス)(?:人|国籍)$/u.test(name)) return '';
  if (/^(?:会社員|学生|店員|自営業|無職|退休|退休了|上班族|日本|中国|台湾|大阪|東京|福岡|よろしく|こんにちは|こんばんは)$/i.test(name)) return '';
  if (/^\d+$/.test(name)) return '';
  return name;
}

function extractName(text) {
  // V1.27.17: conversational self-introductions such as \"俺は秀君だよ\" are
  // common in social DMs and should be treated the same as formal \"と申します\".
  // Optional furigana / reading after a Japanese name. It is deliberately not
  // included in capture group 1 so CRM stores the canonical name only.
  const reading = String.raw`(?:\s*[（(][^）)]{1,40}[）)])?`;
  const nameChars = String.raw`([一-龯々ぁ-んァ-ヶA-Za-z][一-龯々ぁ-んァ-ヶA-Za-z・ー\s]{0,30}?)`;
  const explicit = firstMatch(text, [
    new RegExp(String.raw`(?:(?:私|わたし|僕|ぼく|俺)の)?(?:名前|本名|お名前)(?:は|が|：|:)\s*${nameChars}${reading}(?=\s*(?:です|と申します|といいます|と言います|[。！？!?、,]|$))`, 'u'),
    new RegExp(String.raw`(?:私は|わたしは|僕は|ぼくは|俺は)\s*${nameChars}${reading}\s*(?:です|だ(?:よ|ね)?|と申します|といいます|と言います)`, 'u'),
    new RegExp(String.raw`${nameChars}${reading}\s*(?:と申します|といいます|と言います)`, 'u'),
    new RegExp(String.raw`(?:呼び名|ニックネーム)(?:は|が|：|:)\s*${nameChars}${reading}(?=\s*(?:です|[。！？!?、,]|$))`, 'u'),
    new RegExp(String.raw`(?:皆には|みんなには|友達には|周りからは)?\s*${nameChars}${reading}\s*(?:と呼ばれています|と呼ばれてます|と呼ばれます)`, 'u'),
    /(?:我叫|名字叫|姓名是)\s*([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z·・\s]{0,24}?)(?:\s*[（(][^）)]{1,40}[）)])?(?=[。！？!?，,、\s]|$)/u,
    /\bmy\s+name\s+is\s+([A-Za-z][A-Za-z .'-]{0,35}?)(?:\s*[（(][^）)]{1,40}[）)])?(?=[.!?,]|$)/i
  ]);
  return normalizeName(explicit);
}

function extractAge(text) {
  const source = cleanText(text, 800);
  // Normal explicit age forms: 44歳 / 44才 / 44 years old.
  let match = source.match(/(?:(?:今年|年齢(?:は|が|：|:)?|年龄(?:是|：|:)?|年齡(?:是|：|:)?|I(?:'m| am)?|age(?: is|:)?))?\s*(\d{1,3})\s*(?:歳|才|岁|years?\s*old)/iu);
  // V1.27.29: Japanese social DMs very often answer an age question with the
  // natural shorthand `私は44です` / `僕は52です` and omit 歳 completely.
  // Only accept this as age when it is a first-person numeric copula and falls
  // inside the existing human-age range, so ordinary numbers are not captured.
  if (!match) match = source.match(/(?:^|[。！？!?、,\s])(?:私は|わたしは|僕は|ぼくは|俺は)\s*(\d{2,3})\s*(?:です|ですよ|ですね)(?=[。！？!?、,\s]|$)/u);
  if (!match) return '';
  const age = Number(match[1]);
  return age >= 15 && age <= 100 ? String(age) : '';
}

const JAPAN_REGIONS = [
  '北海道','青森','岩手','宮城','秋田','山形','福島','茨城','栃木','群馬','埼玉','千葉','東京','神奈川','新潟','富山','石川','福井','山梨','長野','岐阜','静岡','愛知','三重','滋賀','京都','大阪','兵庫','奈良','和歌山','鳥取','島根','岡山','広島','山口','徳島','香川','愛媛','高知','福岡','佐賀','長崎','熊本','大分','宮崎','鹿児島','沖縄'
];

function extractRegion(text) {
  // Prefer first-person prefecture/city declarations over nearby questions.
  for (const region of JAPAN_REGIONS) {
    const declared = text.match(new RegExp(`(?:私は|わたしは|僕は|ぼくは|俺は)\\s*(${region}(?:都|道|府|県)?[^。！？!?、,]{0,18}?)\\s*(?:です|に住んでいます|に住んでる|に住んでます|在住です)`, 'u'));
    if (declared?.[1]) return cleanText(declared[1], 60);
  }
  const explicit = firstMatch(text, [
    /(?:住まい|住居|住所|居住地|地域|お住まい)(?:は|が|：|:)\s*([^。！？!?、,]{1,40})/u,
    /(?:私は|わたしは|僕は|ぼくは|俺は)?\s*([^。！？!?、,]{1,40}?)\s*(?:に住んでいます|に住んでる|に住んでます|在住です|在住)/u,
    /(?:住在|住的是|住址是|目前在)\s*([\u4e00-\u9fffA-Za-z0-9省市区县縣台臺北中南东東西]{1,28})/u,
    /(?:出身は|出身地は|来自)\s*([^。！？!?、,]{1,28})/u,
    /(?:^|[。！？!?、,\s])([^。！？!?、,]{1,28}?)\s*(?:出身です|出身で|出身)(?=[。！？!?、,\s]|$)/u
  ]);
  if (explicit) return explicit;
  if (/(?:住|在住|出身|来自)/u.test(text)) {
    for (const region of JAPAN_REGIONS) {
      if (text.includes(region)) return region;
    }
  }
  // V1.27.38: birthplace is a useful geographic fallback when the customer has
  // not stated a current residence yet. `東京生まれ、アメリカ育ちです` stores
  // region=東京 while the full sentence also remains in long-term origin/growth
  // memory. A later explicit current residence is still auto-owned and replaces
  // this fallback normally.
  if (/(?:生まれ|出生|born\s+in)/iu.test(text)) {
    for (const region of JAPAN_REGIONS) {
      if (new RegExp(`${region}(?:都|道|府|県)?[^。！？!?、,]{0,12}(?:生まれ|出生)`, 'u').test(text)) return region;
    }
    const born = firstMatch(text, [
      /([^。！？!?、,\s]{1,28}?)\s*(?:生まれ|出生(?:です)?)(?=[。！？!?、,\s]|$)/u,
      /\bborn\s+in\s+([^.!?,]{1,40})/i
    ]);
    if (born) return cleanText(born,60);
  }
  return '';
}

function normalizeOccupation(value) {
  const occupation = cleanText(value, 140)
    .replace(/^(?:私は|わたしは|僕は|ぼくは|俺は|現在は|今は|現在|今)\s*/u, '')
    .replace(/^(?:仕事は|職業は)\s*/u, '')
    .replace(/(?:で働いています|で働いてます|で働いてる|で働く|に勤めています|に勤めてます|に勤めてる|勤務しています|勤務してます|勤務です|をしています|をしてます|です)[。！？!?]*$/u, '')
    .replace(/(?:从事|做)?(?:这份|這份)?工作$/u, '')
    .replace(/[。！？!?，,、]+$/u, '')
    .trim();
  if (!occupation || occupation.length > 120) return '';
  // V1.27.28: temporary work-state/action sentences are not occupations.
  // Examples: "仕事に戻ります", "これから仕事です", "刚下班".
  // CRM work must describe a durable job/industry/position, not what the customer
  // happens to be doing right now.
  if (/^(?:仕事(?:に戻り(?:ます|ました)?|へ戻り(?:ます|ました)?|に行き(?:ます|ました)?|へ行き(?:ます|ました)?|を始め(?:ます|ました)?|です|中です)|働きに行き(?:ます|ました)?|出勤(?:します|です|しました)?|勤務に戻り(?:ます|ました)?|上班(?:了|去|中)?|去上班(?:了)?|去工作(?:了)?|回去工作(?:了)?|工作中|刚下班|剛下班|下班了)$/u.test(occupation)) return '';
  if (/^(?:今日は|今日も|明日は|明日も|今から|これから|これより|もう|まだ|あとで|後で|今夜は|朝から)?\s*(?:仕事|勤務|出勤)(?:です|します|に戻ります|へ戻ります|に行きます|へ行きます|をします|中です)$/u.test(occupation)) return '';
  // V1.27.41: encouragement/reaction language is not a job title. Old Meta
  // context extraction could turn `お仕事頑張ってください` into
  // `頑張ってください`, or persist a reaction such as `なんですね`.
  if (/(?:頑張って|頑張れ|がんばって|加油|休んで|休みましょう|寝てください|おやすみ|よろしく|宜しく)/u.test(occupation)) return '';
  if (/^(?:なんですね|そうなんですね|そうですね|なるほど|分かりました|わかりました|了解|大丈夫)(?:[。！？!?]*)$/u.test(occupation)) return '';
  if (/(?:ください|下さい|ましょう)$/u.test(occupation)) return '';
  return occupation;
}

function extractOccupation(text) {
  const source = cleanText(text, 1600);
  // V1.27.28: activity/state language is not profile occupation evidence.
  // Do this before generic `仕事...` patterns, otherwise `仕事に戻ります`
  // is captured as the bogus value `に戻ります`.
  if (/(?:^|[。！？!?、,\s])(?:(?:今日は|今日も|明日は|明日も|今から|これから|これより|もう|まだ|あとで|後で|今夜は|朝から)\s*)?(?:仕事(?:に戻り(?:ます|ました)?|へ戻り(?:ます|ました)?|に行き(?:ます|ました)?|へ行き(?:ます|ました)?|を始め(?:ます|ました)?|中です|です)|勤務(?:に戻り(?:ます|ました)?|へ戻り(?:ます|ました)?|中です|です)|出勤(?:します|しました|です)|働きに行き(?:ます|ました)?)(?:[。！？!?、,\s]|$)/u.test(source)) return '';
  if (/(?:^|[。！？!?、,\s])(?:去上班|去工作|回去工作|工作中|上班中|刚下班|剛下班|下班了)(?:[。！？!?、,\s]|$)/u.test(source)) return '';
  if (/(?:お?仕事|工作|勤務).{0,12}(?:頑張って|頑張れ|がんばって|加油)|(?:休んで|寝てください).{0,16}(?:仕事|工作)/u.test(source)) return '';
  const raw = firstMatch(source, [
    /(?:仕事|職業|職種|勤務先|勤め先)(?:は|が|：|:)?\s*([^。！？!?、,]{2,80})/u,
    /(?:私は|わたしは|僕は|ぼくは|俺は)?\s*([^。！？!?、,]{2,80}?)\s*(?:で働いています|で働いてます|で働いてる|に勤めています|に勤めてます|に勤めてる|勤務しています|勤務してます|勤務です)/u,
    /(?:仕事は|職業は)?\s*([^。！？!?、,]{2,50}?)\s*(?:をしています|をしてます)/u,
    /(?:我的工作是|职业是|職業是|工作是|我在)\s*([^。！？!?，,]{2,55})/u,
    /\bi\s+(?:work|am working)\s+(?:as|in|at)\s+([^.!?]{2,55})/i
  ]);
  if (!raw) return '';
  return normalizeOccupation(raw);
}

const INTEREST_RULES = [
  ['跑步', /(?:ランニング|ジョギング|走るのが好き|跑步|慢跑|running|jogging)/iu],
  ['健身', /(?:筋トレ|ジム|フィットネス|トレーニング|健身|健身房|workout|gym|fitness)/iu],
  ['温泉', /(?:温泉|onsen)/iu],
  ['旅行', /(?:旅行|旅が好き|観光|旅游|旅遊|travel|travelling|trip)/iu],
  ['网球', /(?:テニス|网球|網球|tennis)/iu],
  ['高尔夫', /(?:ゴルフ|高尔夫|高爾夫|golf)/iu],
  ['钓鱼', /(?:釣り|フィッシング|钓鱼|釣魚|fishing)/iu],
  ['自驾', /(?:ドライブ|車で旅行|自驾|自駕|road\s*trip|driving)/iu],
  ['料理', /(?:料理|自炊|クッキング|做饭|做飯|烹饪|烹飪|cooking)/iu],
  ['音乐', /(?:音楽|音乐|音樂|music)/iu],
  ['电影', /(?:映画|电影|電影|movies?|cinema)/iu],
  ['摄影', /(?:写真(?:を?撮る|撮影|が趣味|が好き|好き)|撮影|カメラ|摄影|攝影|photography)/iu],
  ['购物', /(?:買い物|ショッピング|购物|購物|shopping)/iu],
  ['散步', /(?:散歩|ウォーキング|散步|walking)/iu],
  ['读书', /(?:読書|本を読む|看书|看書|阅读|閱讀|reading)/iu],
  ['动漫', /(?:アニメ|漫画|动漫|動漫|anime|manga)/iu],
  ['游戏', /(?:ゲーム|游戏|遊戲|gaming|video games?)/iu],
  ['登山', /(?:登山|山登り|ハイキング|爬山|hiking)/iu],
  ['露营', /(?:キャンプ|露营|露營|camping)/iu],
  ['摩托车', /(?:バイク|オートバイ|ハーレー|摩托|机车|機車|motorcycle)/iu],
  ['棒球', /(?:野球|棒球|baseball)/iu],
  ['足球', /(?:サッカー|足球|soccer|football)/iu],
  ['羽毛球', /(?:バドミントン|羽毛球|badminton)/iu],
  ['游泳', /(?:水泳|泳ぐ|游泳|swimming)/iu],
  ['赛马', /(?:競馬|赛马|賽馬|horse racing)/iu],
  ['宠物', /(?:ペット|犬|猫|愛犬|愛猫|宠物|寵物|dog|cat|pets?)/iu],
  ['咖啡', /(?:コーヒー|カフェ|咖啡|coffee|cafe)/iu],
  ['美食', /(?:食べ歩き|グルメ|美食|restaurants?|foodie)/iu],
  ['园艺', /(?:家庭菜園|園芸|ガーデニング|园艺|園藝|gardening)/iu]
];

function extractInterests(text) {
  const out = [];
  for (const [label, pattern] of INTEREST_RULES) if (pattern.test(text)) out.push(label);
  return out;
}

// V1.27.174: one translated customer bubble may contain a complete profile
// dump. Parse it clause-by-clause so one field cannot swallow neighboring
// fields (for example Chinese `现在住在大阪` accidentally matching Japanese
// `在住`, or an occupation capture consuming the following hobby text).
function splitProfileClauses(value) {
  const text = stripYokoUiArtifacts(value, 1600);
  if (!text) return [];
  return text
    .split(/[\n，,。；;！!]+/u)
    .map(part => cleanText(part, 280))
    .filter(Boolean);
}

function bundledAgeFromClause(value) {
  const text = cleanText(value, 280);
  if (!text || questionLike(text)) return '';
  const candidates = [];
  const agePattern = /(\d{1,3})\s*(?:岁|歲|歳|才|years?\s*old)/giu;
  let match;
  while ((match = agePattern.exec(text))) {
    const age = Number(match[1]);
    if (age < 15 || age > 100) continue;
    const prefix = text.slice(Math.max(0, match.index - 18), match.index);
    if (/(?:不是(?:的)?|并非|並非|不对|不對|否认|否認|not(?:\s+really)?|ではない|じゃない)\s*$/iu.test(prefix)) continue;
    candidates.push({ value:String(age), index:match.index });
  }
  if (!candidates.length) {
    const short = text.match(/(?:今年|年龄(?:是|为|為|：|:)?|年齡(?:是|为|為|：|:)?|年令(?:是|：|:)?)\s*(\d{1,3})(?!\d)/u);
    const age = Number(short?.[1] || 0);
    if (age >= 15 && age <= 100) return String(age);
    return '';
  }
  // In a correction such as `不是43岁，是44岁`, the denied value is skipped
  // and the last surviving positive value is the authoritative one.
  return candidates[candidates.length - 1].value;
}

function bundledRegionFromClause(value) {
  const text = cleanText(value, 280);
  if (!text || questionLike(text)) return '';
  if (!/(?:住在|住于|住於|居住在|家住|家在|来自|來自|出身|住んで|在住|^(?:我)?(?:现在|現在|目前)?住(?!院))/u.test(text)) return '';
  const known = text.match(new RegExp(CONTEXT_REGION_HINTS.source, 'u'));
  if (known?.[0]) return cleanText(known[0], 60);
  const raw = firstMatch(text, [
    /(?:我(?:现在|現在|目前)?(?:住在|住于|住於|住)|(?:现在|現在|目前)?(?:住在|居住在|住)|家(?:住|在)|来自|來自)\s*([^。！？!?，,、；;]{1,32})/u,
    /(?:私は|わたしは|僕は|ぼくは|俺は)?\s*([^。！？!?、,]{1,32}?)\s*(?:に住んでいます|に住んでる|に住んでます|在住です)/u
  ]);
  return normalizeRegionValue(raw);
}

function occupationStatusOnly(value) {
  const text = cleanText(value, 120);
  return /^(?:很忙|忙|比较忙|比較忙|特别忙|特別忙|很累|累|辛苦|很辛苦|还好|還好|一般|普通|稳定|穩定|不稳定|不穩定|开心|開心|高兴|高興|有点忙|有點忙|忙しい|大変|疲れた|疲れています)$/u.test(text);
}

function likelyOccupationLabel(value) {
  const text = cleanText(value, 100);
  if (!text || occupationStatusOnly(text)) return false;
  return /(?:工程师|工程師|程序员|程序員|程式設計|开发|開發|教师|教師|老师|老師|医生|醫生|护士|護士|经理|經理|店长|店長|店员|店員|厨师|廚師|司机|司機|销售|銷售|建筑|建築|餐饮|餐飲|金融|银行|銀行|保险|保險|IT|互联网|互聯網|贸易|貿易|物流|制造|製造|房地产|房地產|公务员|公務員|自营|自營|自由职业|自由職業|会社員|公務員|自営業|経営者|会社経営|営業|技師|エンジニア|教師|医師|看護師|建設|飲食|金融|不動産|製造|物流)/iu.test(text);
}

function bundledOccupationFromClause(value) {
  const text = cleanText(value, 280);
  if (!text || questionLike(text)) return '';
  let raw = firstMatch(text, [
    /(?:我的)?(?:工作|职业|職業|職種)(?:是|为|為|：|:)?\s*([^。！？!?，,、；;]{1,60})/u,
    /(?:我)?(?:现在|現在|目前)?(?:做|从事|從事)\s*([^。！？!?，,、；;]{1,60})/u,
    /(?:我)?在\s*([^。！？!?，,、；;]{2,60}?)(?:工作|上班)(?=$|[。！？!?，,、；;])/u,
    /(?:仕事|職業|職種)(?:は|が|：|:)?\s*([^。！？!?、,]{2,60})/u,
    /(?:私は|わたしは|僕は|ぼくは|俺は)?\s*([^。！？!?、,]{2,60}?)\s*(?:で働いています|で働いてます|に勤めています|勤務しています)/u
  ]);
  if (!raw) {
    const copula = text.match(/^(?:我是|本人是|私は|わたしは|僕は|ぼくは|俺は)\s*([^。！？!?，,、；;]{1,50})(?:です)?$/u);
    if (copula?.[1] && likelyOccupationLabel(copula[1])) raw = cleanText(copula[1], 80);
  }
  const occupation = normalizeOccupation(raw);
  if (!occupation || occupationStatusOnly(occupation) || obviousConversationNoise(occupation, 'occupation')) return '';
  // `我在大阪工作` states a work location, not an occupation.
  if (new RegExp(`^(?:${CONTEXT_REGION_HINTS.source})$`, 'u').test(occupation)) return '';
  return occupation;
}

function bundledNameFromClause(value, allowAmbiguousCopula = false) {
  const text = cleanText(value, 160);
  if (!text || questionLike(text)) return '';
  let name = extractName(text);
  if (!name && allowAmbiguousCopula) {
    const match = text.match(/^(?:我是|本人是)\s*([\u4e00-\u9fff一-龯々ぁ-んァ-ヶA-Za-z][\u4e00-\u9fff一-龯々ぁ-んァ-ヶA-Za-z·・ー .'-]{0,24})$/u);
    if (match?.[1]) name = normalizeName(match[1]);
  }
  if (!name) return '';
  if (CONTEXT_REGION_HINTS.test(name)) return '';
  if (/(?:公司|会社|工程师|工程師|程序员|程式設計|教师|教師|老师|老師|医生|醫生|护士|護士|店员|店員|经理|經理|老板|老闆|職員|職業|工作|自営業|会社員|公務員|学生|學生)/u.test(name)) return '';
  return name;
}

function bundledInterestsFromClause(value) {
  const text = cleanText(value, 500);
  if (!text || questionLike(text)) return [];
  const pieces = text.split(/(?:但是|但|不过|不過|然而|可是|けど|ですが|でも|しかし)/u).map(part => cleanText(part, 240)).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const piece of pieces) {
    if (/(?:不喜欢|不喜歡|不爱|不愛|讨厌|討厭|嫌い|興味がない|兴趣不大|興趣不大|don't\s+like|do\s+not\s+like)/iu.test(piece)) continue;
    if (!/(?:^(?:我)?(?:喜欢|喜歡|爱|愛)|我(?:平时|平時|平常|通常|休息时|休息時|闲时|閒時)?(?:喜欢|喜歡|爱|愛)|(?:平时|平時|平常|通常|休息时|休息時|闲时|閒時)(?:喜欢|喜歡)|(?:我的)?(?:兴趣|興趣|爱好|愛好)(?:是|有|包括)?|(?:私は|わたしは|僕は|ぼくは|俺は).*(?:好き|趣味)|趣味(?:は|が)|好き(?:なの)?(?:は|なこと)|I\s+(?:like|love|enjoy)|my\s+hobb)/iu.test(piece)) continue;
    for (const label of extractInterests(piece)) {
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

function extractBundledProfileFacts(value) {
  const text = stripYokoUiArtifacts(value, 1600);
  const empty = { name:'', age:'', region:'', occupation:'', interests:[], clauses:{}, fieldCount:0, hasNameStatement:false, hasAgeStatement:false, hasRegionStatement:false, hasOccupationStatement:false, hasInterestStatement:false };
  if (!text || questionLike(text)) return empty;
  const clauses = splitProfileClauses(text);
  if (clauses.length < 2) return empty;

  const found = { ...empty, clauses:{} };
  let ambiguousName = '';
  let ambiguousNameClause = '';
  const interestSeen = new Set();
  for (const clause of clauses) {
    if (/(?:我叫|我的名字|名字(?:叫|是)|姓名(?:叫|是)|名前|本名|ニックネーム|my\s+name|^(?:我是|本人是)\s*)/iu.test(clause)) found.hasNameStatement = true;
    if (/(?:\d{1,3}\s*(?:岁|歲|歳|才|years?\s*old)|今年\s*\d{1,3}|年龄|年齡|年令)/iu.test(clause)) found.hasAgeStatement = true;
    if (/(?:住在|住于|住於|居住|家住|家在|来自|來自|出身|住んで|在住|^(?:我)?(?:现在|現在|目前)?住(?!院))/u.test(clause)) found.hasRegionStatement = true;
    if (/(?:工作|职业|職業|職種|勤務|勤め|働|^(?:我)?(?:现在|現在|目前)?(?:做|从事|從事)|^(?:我是|本人是|私は|わたしは|僕は|ぼくは|俺は))/u.test(clause)) found.hasOccupationStatement = true;
    const name = bundledNameFromClause(clause, false);
    if (name) { found.name = name; found.clauses.name = clause; }
    else if (!ambiguousName) {
      const maybeName = bundledNameFromClause(clause, true);
      if (maybeName) { ambiguousName = maybeName; ambiguousNameClause = clause; }
    }

    const age = bundledAgeFromClause(clause);
    if (age) { found.age = age; found.clauses.age = clause; }
    const region = bundledRegionFromClause(clause);
    if (region) { found.region = region; found.clauses.region = clause; }
    const occupation = bundledOccupationFromClause(clause);
    if (occupation) { found.occupation = occupation; found.clauses.occupation = clause; }
    if (/(?:喜欢|喜歡|爱好|愛好|兴趣|興趣|趣味|好き|嫌い|hobb|\blike\b|\blove\b|\benjoy\b)/iu.test(clause)) found.hasInterestStatement = true;
    const interests = bundledInterestsFromClause(clause);
    if (interests.length) {
      found.clauses.interests = found.clauses.interests || [];
      found.clauses.interests.push(clause);
      for (const label of interests) if (!interestSeen.has(label)) { interestSeen.add(label); found.interests.push(label); }
    }
  }
  let count = ['name','age','region','occupation'].filter(field => !!found[field]).length + (found.interests.length ? 1 : 0);
  // `我是田中` is ambiguous by itself (it could be a role/nationality). It is
  // accepted only when the same bubble independently contains at least one more
  // durable profile field, making this a genuine multi-field self-introduction.
  if (!found.name && ambiguousName && count >= 1) {
    found.name = ambiguousName;
    found.clauses.name = ambiguousNameClause;
    count += 1;
  }
  found.fieldCount = count;
  return count >= 2 ? found : empty;
}

function normalizeShortAnswer(text, limit = 80) {
  return cleanText(text, limit)
    .replace(/^(?:はい[、,。\s]*|ええ[、,。\s]*|そうですね[、,。\s]*)/u, '')
    .replace(/(?:です|ですよ|ですね|と申します|といいます|と言います)[。！？!?]*$/u, '')
    .replace(/[。！？!?，,、]+$/u, '')
    .trim();
}

const PROFILE_QUESTION_PATTERNS = {
  name: /(?:お?名前|なんて呼|何と呼|叫什么|叫什麼|姓名|your\s+name|what(?:'s| is)\s+your\s+name)/iu,
  age: /(?:何歳|おいくつ|年齢|多大|几岁|幾歲|年龄|年齡|how\s+old|your\s+age)/iu,
  region: /(?:どこに住|どちらに住|どこにお住まい|お住まいは(?:どこ|どちら)|住まいは(?:どこ|どちら)|出身は(?:どこ|どちら)|どこ出身|哪里住|哪裡住|住哪里|住哪裡|住在哪里|住在哪裡|住哪儿|住哪兒|来自哪里|來自哪裡|住在什么地方|住在什麼地方|where\s+(?:do\s+you\s+live|are\s+you\s+from)|where.*(?:live|from))/iu,
  occupation: /(?:何のお?仕事|どんな仕事|お仕事は(?:何|なん)|仕事は(?:何|なん)|職業は|職種は|何をして(?:います|る).*(?:仕事|職業)?|做什么工作|做什麼工作|什么职业|什麼職業|从事什么|從事什麼|what\s+do\s+you\s+do|what(?:'s| is)\s+your\s+job|occupation)/iu,
  interests: /(?:趣味|好きなこと|何が好き|興味|兴趣|興趣|爱好|愛好|喜欢做什么|喜歡做什麼|hobb|what.*like.*do)/iu
};

function profileQuestionFields(value) {
  const text = stripYokoUiArtifacts(value, 600);
  if (!text) return [];
  return Object.entries(PROFILE_QUESTION_PATTERNS).filter(([, pattern]) => pattern.test(text)).map(([field]) => field);
}

// V1.27.173: a bare confirmation/denial only has meaning when it is tied to a
// concrete value in Yoko's immediately preceding profile question. Keep this
// classifier deliberately strict: loose conversational agreement must never
// manufacture CRM facts.
function answerPolarity(value) {
  const text = stripYokoUiArtifacts(value, 500).trim();
  if (!text || questionLike(text)) return '';
  const compact = text.replace(/^[\s「『“"'（(]+|[\s」』”"'）)]+$/gu, '').trim();
  if (/^(?:不是(?:的)?|不对|不對|并不是|並不是|没有|沒有|没|沒|否|いいえ|違います|違う|ちがいます|ちがう|no(?:pe)?\b|not\s+really\b)/iu.test(compact)) return 'deny';
  if (/^(?:是的|是呀|是啊|是|对(?:的)?|對(?:的)?|没错|沒錯|嗯+|嗯嗯|对啊|對啊|はい|ええ|そうです|そうですね|その通り|間違いない|yes\b|yeah\b|yep\b|correct\b|exactly\b)(?:[，,。！!；;、\s]|$)/iu.test(compact)) return 'affirm';
  return '';
}

function denialCorrectionPayload(value) {
  const text = stripYokoUiArtifacts(value, 800).trim();
  if (answerPolarity(text) !== 'deny') return '';
  const cue = /^(?:不是(?:的)?|不对|不對|并不是|並不是|没有|沒有|いいえ|違います|違う|ちがいます|ちがう|no(?:pe)?\b|not\s+really\b)/iu;
  let rest = text.replace(cue, '').trim();
  if (!rest) return '';
  const correctionCueMatch = rest.match(/(?:而是|其实是|其實是|实际是|實際是|正确的是|正確的是|应该是|應該是|改成|訂正(?:すると)?|正しくは|実は)\s*(.+)$/iu);
  if (correctionCueMatch?.[1]) return cleanText(correctionCueMatch[1], 700);
  const separated = rest.match(/^[^，,。；;、！!]{0,80}[，,。；;、！!]\s*(.+)$/u);
  if (separated?.[1]) return cleanText(separated[1].replace(/^(?:而是|是|其实是|其實是|実は|正しくは)\s*/u, ''), 700);
  // `不是，我在京都` reaches here after the cue is removed as `，我在京都`.
  rest = rest.replace(/^[，,。；;、！!：:\-—–\s]+/u, '').trim();
  if (/^(?:我|我是|我叫|我住|我在|我做|我从事|我從事|我的|其实|其實|実は|私は|わたしは|僕は|ぼくは|俺は|I\b)/iu.test(rest)) return cleanText(rest, 700);
  return '';
}


function affirmationPayload(value) {
  const text = stripYokoUiArtifacts(value, 800).trim();
  if (answerPolarity(text) !== 'affirm') return '';
  const cue = /^(?:是的|是呀|是啊|是|对(?:的)?|對(?:的)?|没错|沒錯|嗯+|对啊|對啊|はい|ええ|そうです|そうですね|その通り|間違いない|yes\b|yeah\b|yep\b|correct\b|exactly\b)/iu;
  let rest = text;
  for (let i=0;i<3;i++) {
    const next = rest.replace(cue, '').replace(/^[，,。；;、！!：:\-—–\s]+/u, '').trim();
    if (next === rest) break;
    rest = next;
  }
  return cleanText(rest, 700);
}

function contextualAnswerNoise(value, field = '') {
  const raw = stripYokoUiArtifacts(value, 180);
  if (!raw || questionLike(raw)) return true;
  const text = normalizeShortAnswer(raw, 180);
  if (!text) return true;
  if (/^(?:嗯+|哦+|啊+|好(?:的)?|好的呀|可以|行|知道了|明白了|稍等(?:一下)?|等一下|等会儿|等會兒|一会儿|一會兒|不知道|不清楚|不方便说|不方便說|以后再说|以後再說|为什么|為什麼|怎么了|怎麼了|是吗|是嗎|真的吗|真的嗎|谢谢|謝謝|多谢|多謝|没事|沒事|没关系|沒關係|哈哈+|呵呵+|笑)$/u.test(text)) return true;
  if (field === 'region' && /(?:工作|上班|下班|忙|累|开心|開心|高兴|高興|吃饭|吃飯|睡觉|睡覺|休息|天气|天氣|今天|明天|昨天|早上|晚上)/u.test(text)) return true;
  if (field === 'occupation' && /(?:住在|来自|來自|年龄|年齡|岁|歲|几岁|幾歲)/u.test(text)) return true;
  return obviousConversationNoise(text, field);
}

const CONTEXT_REGION_HINTS = /(?:北海道|青森|岩手|宫城|宮城|秋田|山形|福岛|福島|茨城|栃木|群马|群馬|埼玉|千叶|千葉|东京|東京|神奈川|新潟|富山|石川|福井|山梨|长野|長野|岐阜|静冈|静岡|爱知|愛知|三重|滋贺|滋賀|京都|大阪|兵库|兵庫|奈良|和歌山|鸟取|鳥取|岛根|島根|冈山|岡山|广岛|廣島|山口|德岛|徳島|香川|爱媛|愛媛|高知|福冈|福岡|佐贺|佐賀|长崎|長崎|熊本|大分|宫崎|宮崎|鹿儿岛|鹿児島|冲绳|沖縄|札幌|仙台|横滨|横浜|川崎|名古屋|神户|神戸|北九州|台北|台中|高雄|香港|澳门|澳門|纽约|紐約|洛杉矶|洛杉磯|伦敦|倫敦|巴黎|新加坡|曼谷|首尔|首爾|美国|美國|加拿大|澳大利亚|澳大利亞|英国|英國|法国|法國|德国|德國|中国|中國|台湾|臺灣|台灣|韩国|韓國|泰国|泰國|越南|菲律宾|菲律賓|印度|尼泊尔|尼泊爾)/u;

function normalizeContextRegionAnswer(value) {
  return normalizeShortAnswer(value, 100)
    .replace(/^(?:我是住在|我是住|我(?:现在|現在|目前)?(?:住在|住|在)|我是在|目前在|现在在|現在在|家在|家住|住在)\s*/u, '')
    .replace(/^(?:私は|わたしは|僕は|ぼくは|俺は|今は|現在は)\s*/u, '')
    .replace(/(?:に住んでいます|に住んでる|に住んでます|在住です|在住|にいます|に居ます)$/u, '')
    .replace(/[。！？!?，,、]+$/u, '')
    .trim();
}

function plausibleContextRegion(value) {
  const text = normalizeContextRegionAnswer(value);
  if (!text || text.length > 40 || contextualAnswerNoise(text, 'region')) return '';
  if (CONTEXT_REGION_HINTS.test(text)) return text;
  if (/(?:省|市|县|縣|区|區|镇|鎮|乡|鄉|州|府|都|道|町|村|郡|岛|島)$/u.test(text) && text.length <= 24) return text;
  return '';
}

function confirmationQuestionCandidates(value) {
  const text = stripYokoUiArtifacts(value, 700);
  const out = { name:'', age:'', region:'', occupation:'', interests:[] };
  if (!text || !questionLike(text)) return out;
  // Never turn Yoko's own self-check into customer data: `我44岁，对吗？`.
  if (/(?:我|我的|本人|私は|わたしは|僕は|ぼくは|俺は|I\s*(?:am|'m)\b)/iu.test(text)) return out;
  // Alternative-choice questions do not have one safe yes/no candidate.
  if (/(?:还是|還是|或者|或是|\bor\b)/iu.test(text)) return out;

  const ageMatch = text.match(/(?:^|\D)(\d{1,3})\s*(?:岁|歲|歳|才|years?\s*old)(?:\D|$)/iu);
  if (ageMatch?.[1]) {
    const age = Number(ageMatch[1]);
    if (age >= 15 && age <= 100) out.age = String(age);
  }

  const regionMatches = [...text.matchAll(new RegExp(CONTEXT_REGION_HINTS.source, 'gu'))].map(match => cleanText(match[0], 60));
  const uniqueRegions = [...new Set(regionMatches)];
  if (uniqueRegions.length === 1 && /(?:你|您|住|居住|来自|來自|在|live|from)/iu.test(text)) out.region = uniqueRegions[0];

  let nameMatch = text.match(/(?:你|您).{0,8}(?:叫|名字(?:是|叫)?|姓名(?:是|叫)?)\s*([^，,。！？!?吗嗎]{1,30}?)(?:吗|嗎|呢)?[？?]?$/u);
  if (nameMatch?.[1]) out.name = normalizeName(nameMatch[1]);

  let occMatch = text.match(/(?:你|您).{0,10}(?:是|在)?(?:做|从事|從事)\s*([^，,。！？!?吗嗎]{1,50}?)(?:方面|行业|行業)?(?:的)?(?:吗|嗎|呢)?[？?]?$/u);
  if (!occMatch) occMatch = text.match(/(?:你|您).{0,8}(?:是)?\s*([^，,。！？!?吗嗎]{1,40}?)(?:行业|行業|职业|職業)(?:的)?(?:吗|嗎|呢)?[？?]?$/u);
  if (occMatch?.[1]) {
    const occupation = normalizeOccupation(occMatch[1]);
    if (occupation && !obviousConversationNoise(occupation, 'occupation')) out.occupation = occupation;
  }

  if (/(?:你|您|喜欢|喜歡|爱好|愛好|兴趣|興趣|趣味|hobb|like|enjoy)/iu.test(text)) out.interests = extractInterests(text);
  return out;
}

function confirmationCandidateFields(candidates = {}) {
  return ['name','age','region','occupation','interests'].filter(field => field === 'interests' ? Array.isArray(candidates.interests) && candidates.interests.length : !!candidates[field]);
}

function declarativePrefixBeforeQuestion(value) {
  const text = stripYokoUiArtifacts(value, 1600);
  if (!questionLike(text)) return text;
  const pieces = text.split(/[，,。；;！!]+/u).map(part => cleanText(part, 500)).filter(Boolean);
  if (pieces.length < 2) return '';
  const prefix = pieces.slice(0, -1).join('。');
  return /(?:^|[。\s])(?:我|我的|本人|我是|我叫|我住|我在|我今年|我的年龄|我的年齡|我的工作|我的职业|我的職業|我喜欢|我喜歡|私は|わたしは|僕は|ぼくは|俺は|自分は)/u.test(prefix) ? prefix : '';
}

function contextualFacts(question, answer, forcedFields = []) {
  const q = stripYokoUiArtifacts(question, 500);
  const a = stripYokoUiArtifacts(answer, 500);
  const out = { name:'', age:'', region:'', occupation:'', interests:[] };
  if (!q || !a || isYokoToolbarArtifactText(a)) return out;
  const fields = new Set([...profileQuestionFields(q), ...(Array.isArray(forcedFields) ? forcedFields : [])]);

  if (fields.has('name') && !contextualAnswerNoise(a, 'name')) {
    const short = normalizeShortAnswer(a, 60);
    if (short && short.length <= 30 && !/[。！？!?].+[。！？!?]/u.test(short)) out.name = normalizeName(short);
  }
  if (fields.has('age') && !contextualAnswerNoise(a, 'age')) {
    const match = a.match(/(?:^|\D)(\d{1,3})(?:\s*(?:岁|歲|歳|才|years?\s*old))?(?:\D|$)/iu);
    const age = Number(match?.[1] || 0);
    if (age >= 15 && age <= 100) out.age = String(age);
  }
  if (fields.has('region')) out.region = plausibleContextRegion(a);
  if (fields.has('occupation') && !contextualAnswerNoise(a, 'occupation')) {
    const short = normalizeShortAnswer(a, 140)
      .replace(/^(?:我是|我做|我从事|我從事|主要做|工作是|职业是|職業是)\s*/u, '')
      .replace(/(?:方面(?:的)?工作|这一行|這一行)$/u, '方面')
      .trim();
    const occupation = normalizeOccupation(short);
    if (occupation && occupation.length <= 120 && !obviousConversationNoise(occupation, 'occupation')) out.occupation = occupation;
  }
  if (fields.has('interests') && !contextualAnswerNoise(a, 'interests')) out.interests = extractInterests(a);
  return out;
}



const SMART_FACT_EXTRACTION_VERSION = 'v127179-monotonic-message-time-closure';

function questionLike(value) {
  const text = cleanText(value, 500);
  if (!text) return false;
  return /[?？]\s*$/u.test(text)
    || /(?:ですか|ますか|でしょうか|でしょう|なの|かな|かい)[。！？!?]*$/u.test(text)
    || /(?:吗|嗎|呢)[？?。！!]*$/u.test(text);
}

function correctionCue(value) {
  return /(?:実は|正しくは|訂正|今は|現在は|今住んで|引っ越|転居|転職|今年は|actually|currently|now\s+i|其实|其實|实际上|實際上|更正|纠正|糾正|现在|現在|搬家|换工作|換工作)/iu.test(cleanText(value, 800));
}

// V1.27.175: profile fields represent the customer's CURRENT state. Historical
// statements remain useful as memory/audit evidence, but they must not silently
// overwrite current CRM fields. Current/correction cues are intentionally strict.
function currentStateCue(value) {
  return /(?:现在|現在|目前|如今|现居|現居|当前|當前|已经搬|已經搬|搬到|搬去|搬回|搬来|搬來|定居|换工作|換工作|转职|轉職|转行|轉行|改行|重新喜欢|重新喜歡|再次喜欢|再次喜歡|又开始喜欢|又開始喜歡|最近重新喜欢|最近重新喜歡|今は|現在は|今住んで|引っ越|転居|転職|また好き|再び好き|いまは|currently|now\b|moved\s+to|changed\s+jobs?|like.{0,24}again|love.{0,24}again|enjoy.{0,24}again)/iu.test(cleanText(value, 1000));
}

function historicalStateCue(value) {
  return /(?:以前|之前|原来|原來|过去|過去|曾经|曾經|从前|從前|以前は|前は|昔は|かつて|formerly|previously|used\s+to)/iu.test(cleanText(value, 1000));
}

function temporalState(value) {
  const text = cleanText(value, 1000);
  if (!text) return 'stable';
  if (/(?:更正|纠正|糾正|訂正|正しくは|其实|其實|実は|说错|說錯|間違|actually)/iu.test(text)) return 'correction';
  if (currentStateCue(text)) return 'current';
  if (historicalStateCue(text)) return 'historical';
  return 'stable';
}

function historicalOnly(value) {
  const text = cleanText(value, 1000);
  return !!text && historicalStateCue(text) && !currentStateCue(text) && temporalState(text) !== 'correction';
}

function lastRegionHintAfter(value, start = 0) {
  const text = cleanText(value, 1200);
  const matches = [...text.matchAll(new RegExp(CONTEXT_REGION_HINTS.source, 'gu'))]
    .filter(match => Number(match.index || 0) >= Math.max(0, Number(start || 0)));
  if (!matches.length) return '';
  return cleanText(matches[matches.length - 1][0], 60);
}

function extractCurrentRegion(value) {
  const text = cleanText(value, 1200);
  if (!text || questionLike(text)) return '';
  const cue = /(?:现在|現在|目前|如今|现居|現居|当前|當前|搬到|搬去|搬回|搬来|搬來|定居在?|今は|現在は|今住んで|引っ越|転居|currently|now\b|moved\s+to)/giu;
  let last = null, match;
  while ((match = cue.exec(text))) last = match;
  if (last) {
    const region = lastRegionHintAfter(text, last.index);
    if (region) return region;
    const tail = text.slice(last.index);
    const raw = firstMatch(tail, [
      /(?:住在|居住在|定居在|搬到|搬去|搬回|搬来|搬來|(?:我(?:现在|現在|目前)?|现在|現在|目前)\s*在)\s*([^。！？!?，,、；;]{1,32})/u,
      /(?:今は|現在は)?\s*([^。！？!?、,]{1,32}?)\s*(?:に住んでいます|に住んでる|に住んでます|へ引っ越|に引っ越)/u,
      /(?:moved\s+to|now\s+live\s+in|currently\s+live\s+in)\s+([^.!?,]{1,40})/iu
    ]);
    const normalized = normalizeRegionValue(raw);
    if (normalized && !obviousConversationNoise(normalized, 'region')) return normalized;
  }
  if (historicalOnly(text)) return '';
  return '';
}

function extractCurrentAge(value) {
  const text = cleanText(value, 900);
  if (!text || questionLike(text) || historicalOnly(text)) return '';
  if (!currentStateCue(text) && temporalState(text) !== 'correction') return '';
  const ages=[];
  for (const match of text.matchAll(/(\d{1,3})\s*(?:岁|歲|歳|才|years?\s*old)/giu)) {
    const age=Number(match[1]);
    if (age>=15 && age<=100) ages.push(String(age));
  }
  if (ages.length) return ages[ages.length-1];
  const short=text.match(/(?:现在|現在|目前|如今|今年|今は|現在は).{0,12}?(\d{2,3})(?!\d)/u);
  const age=Number(short?.[1]||0);
  return age>=15&&age<=100?String(age):'';
}

function extractCurrentOccupation(value) {
  const text = cleanText(value, 1200);
  if (!text || questionLike(text) || historicalOnly(text)) return '';
  let raw = firstMatch(text, [
    /(?:现在|現在|目前|如今|当前|當前)(?:(?:已经|已經)?(?:换工作|換工作|转职|轉職|转行|轉行)(?:后|後)?(?:是|做|从事|從事|工作是|职业是|職業是)?|(?:是|做|从事|從事|工作是|职业是|職業是))\s*([^。！？!?，,、；;]{1,60})/u,
    /(?:换工作|換工作|转职|轉職|转行|轉行|改行)(?:了|后|後)?(?:去|到|做|从事|從事|成了|成为|成為)?\s*([^。！？!?，,、；;]{1,60})/u,
    /(?:今は|現在は|転職して|転職後)\s*([^。！？!?、,]{1,60}?)(?:で働いています|で働いてます|をしています|です)(?=[。！？!?、,]|$)/u,
    /(?:currently|now)\s+(?:work|working)\s+(?:as|in|at)\s+([^.!?]{1,60})/iu
  ]);
  raw = cleanText(raw, 120).replace(/^(?:工作是|职业是|職業是|做|从事|從事)\s*/u,'').replace(/(?:了|啦)$/u,'').trim();
  let occupation = normalizeOccupation(raw);
  if (occupation && !occupationStatusOnly(occupation) && !obviousConversationNoise(occupation,'occupation') && !new RegExp(`^(?:${CONTEXT_REGION_HINTS.source})$`, 'u').test(occupation)) return occupation;
  if (currentStateCue(text)) {
    const tailStart=Math.max(text.lastIndexOf('现在'),text.lastIndexOf('現在'),text.lastIndexOf('目前'),text.lastIndexOf('换工作'),text.lastIndexOf('換工作'),text.lastIndexOf('转职'),text.lastIndexOf('轉職'),text.lastIndexOf('転職'),text.lastIndexOf('今は'),text.lastIndexOf('現在は'));
    const tail=tailStart>=0?text.slice(tailStart):text;
    raw=firstMatch(tail,[/(?:做|从事|從事)\s*([^。！？!?，,、；;]{1,60})/u,/(?:工作|职业|職業)(?:是|为|為|：|:)?\s*([^。！？!?，,、；;]{1,60})/u]);
    occupation=normalizeOccupation(cleanText(raw,120).replace(/(?:了|啦)$/u,''));
    if (occupation && !occupationStatusOnly(occupation) && !obviousConversationNoise(occupation,'occupation') && !new RegExp(`^(?:${CONTEXT_REGION_HINTS.source})$`, 'u').test(occupation)) return occupation;
  }
  return '';
}

function extractNegatedInterests(value) {
  const text = cleanText(value, 1200);
  if (!text) return [];
  const out=[];
  const seen=new Set();
  const pieces=text.split(/[，,。；;！!]|(?:但是|但|不过|不過|然而|可是|けど|ですが|でも|しかし)/u).map(v=>cleanText(v,300)).filter(Boolean);
  for (const piece of pieces) {
    if (!/(?:不喜欢|不喜歡|不爱|不愛|讨厌|討厭|嫌い|興味がない|兴趣不大|興趣不大|もう好きではない|don't\s+like|do\s+not\s+like|not\s+into)/iu.test(piece)) continue;
    for (const label of extractInterests(piece)) if (!seen.has(label)) { seen.add(label); out.push(label); }
  }
  return out;
}

function normalizeRegionValue(value) {
  return cleanText(value, 100)
    .replace(/^(?:私は|わたしは|僕は|ぼくは|俺は|自分は|今は|現在は|現在|今|目前は?|我现在|我現在|目前|现在|現在)\s*/u, '')
    .replace(/(?:に住んでいます|に住んでる|に住んでます|在住です|在住|にいます|に居ます)$/u, '')
    .replace(/[。！？!?，,、]+$/u, '')
    .trim();
}

function fieldEvidence(field, value, kind, text, question = '', rowIndex = -1, confidence = 0, rawEvidence = '') {
  const evidence = cleanText(text, 500);
  const q = cleanText(question, 300);
  const raw = cleanText(rawEvidence, 500);
  let score = Math.max(0, Math.min(100, Number(confidence || 0)));
  if (correctionCue(evidence)) score = Math.min(100, score + 3);
  return {
    field:String(field || ''), value:cleanText(value, 500), kind:String(kind || 'explicit'),
    confidence:score, evidence, rawEvidence:raw, question:q, rowIndex:Number(rowIndex), source:'customer', textSource:'translated',
    temporal:temporalState(evidence)
  };
}

function interestEvidence(text, previousOperatorText = '', rowIndex = -1) {
  const source = stripYokoUiArtifacts(text, 1200);
  const negated = new Set(extractNegatedInterests(source));
  const labels = extractInterests(source).filter(label => !negated.has(label));
  if (!labels.length) return [];
  const q = stripYokoUiArtifacts(previousOperatorText, 500);
  const directQuestion = /(?:趣味|好きなこと|何が好き|興味|兴趣|興趣|爱好|愛好|喜欢做什么|喜歡做什麼|hobb|what.*like.*do)/iu.test(q);
  const selfMarker = /(?:私は|わたしは|僕は|ぼくは|俺は|自分は|(?:今は|現在は).{0,24}(?:好き|趣味|興味)|趣味(?:は|が)|好き(?:です|で|なの|なもの)|大好き|興味(?:が|は)|よく(?:します|やります|行きます)|休日(?:は|に)|休みの日(?:は|に)|我(?:(?:现在|現在|目前|最近|又|重新|再次|开始|開始)\s*){0,4}(?:喜欢|喜歡|爱|愛)|我的爱好|我的愛好|I\s+(?:like|love|enjoy)|my\s+hobb)/iu.test(source);
  const addressedOther = /(?:優子|Yoko|あなた|君|きみ|そちら).{0,20}(?:好き|趣味|興味|旅行|テニス|ゴルフ|音楽|映画|読書|料理)/iu.test(source);
  // A customer asking Yoko "旅行は好きですか？" is not evidence that the
  // customer likes travel. A short answer after our direct hobby question is.
  if (questionLike(source) && !selfMarker) return [];
  if (addressedOther && !/(?:私は|わたしは|僕は|ぼくは|俺は|自分は)/u.test(source)) return [];
  const kind = selfMarker ? 'explicit' : (directQuestion ? 'contextual' : 'mention');
  const confidence = selfMarker ? 94 : (directQuestion ? 88 : 0);
  if (confidence < 80) return [];
  return labels.map(label => fieldEvidence('interests', label, kind, source, q, rowIndex, confidence));
}

function evidenceSummaryRecord(facts, field, value, evidence) {
  if (!value || !evidence || !evidenceShouldReplace(facts.fieldEvidence[field], evidence)) return false;
  facts[field] = value;
  facts.fieldEvidence[field] = evidence;
  facts.confidence[field] = evidence.confidence;
  if (evidence.kind === 'explicit') {
    if (!facts.explicitFields.includes(field)) facts.explicitFields.push(field);
    facts.contextualFields = facts.contextualFields.filter(name => name !== field);
  } else if (!facts.explicitFields.includes(field) && !facts.contextualFields.includes(field)) {
    facts.contextualFields.push(field);
  }
  return true;
}

function normalizedEvidenceKey(value) {
  return cleanText(value, 1600).toLocaleLowerCase();
}

function stripMirroredOutgoingFragments(value, outgoingValues = []) {
  let text = stripYokoUiArtifacts(value, 1600);
  if (!text) return '';
  const candidates = [...new Set((Array.isArray(outgoingValues) ? outgoingValues : []).map(v => cleanText(v, 1600)).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const outgoing of candidates) {
    const lower = text.toLocaleLowerCase();
    const needle = outgoing.toLocaleLowerCase();
    if (lower === needle) return '';
    const wrappers = [[`「${outgoing}」`, `「${needle}」`], [`『${outgoing}』`, `『${needle}』`], [`“${outgoing}”`, `“${needle}”`], [`\"${outgoing}\"`, `\"${needle}\"`]];
    let removed = false;
    for (const [wrapped, wrappedNeedle] of wrappers) {
      if (lower.startsWith(wrappedNeedle)) {
        text = cleanText(text.slice(wrapped.length).replace(/^[：:\-—–>》」』”\s]+/u, ''), 1600);
        removed = true;
        break;
      }
    }
    if (removed) continue;
    if (lower.startsWith(needle)) {
      const rest = text.slice(outgoing.length);
      if (/^[：:\-—–>》」』”\s，,。；;]+/u.test(rest)) text = cleanText(rest.replace(/^[：:\-—–>》」』”\s，,。；;]+/u, ''), 1600);
    }
  }
  return text;
}

function recentProfileQuestion(rows, currentPos, consumed = new Set()) {
  let operatorRows = 0;
  let customerRows = 0;
  for (let pos = currentPos - 1; pos >= 0 && currentPos - pos <= 8; pos--) {
    const row = rows[pos];
    if (!row) continue;
    if (row.role === 'customer' || row.role === 'incoming') {
      customerRows += 1;
      if (customerRows > 2) break;
      continue;
    }
    if (row.role !== 'me' && row.role !== 'outgoing') continue;
    operatorRows += 1;
    const candidates = confirmationQuestionCandidates(row.text);
    const allFields = [...new Set([...profileQuestionFields(row.text), ...confirmationCandidateFields(candidates)])];
    const fields = allFields.filter(field => !consumed.has(`${row.index}:${field}`));
    if (fields.length) return { row, fields, candidates, distance: currentPos - pos };
    if (operatorRows >= 4) break;
  }
  return null;
}

function evidenceShouldReplace(previous, candidate) {
  if (!candidate) return false;
  if (!previous) return true;
  const chronology=evidenceChronology(previous,candidate);
  // V1.27.179: array/IPC arrival order is not chronology. Once both rows carry
  // a real source timestamp, an older row can never replace newer field evidence.
  if (chronology.known && chronology.deltaMs < 0) return false;
  if (candidate.kind === 'explicit' && previous.kind !== 'explicit') return true;
  if (correctionCue(candidate.evidence) && candidate.rowIndex >= previous.rowIndex && candidate.confidence >= previous.confidence - 8) return true;
  if (candidate.confidence > previous.confidence) return true;
  if (candidate.confidence === previous.confidence && candidate.rowIndex >= previous.rowIndex) return true;
  return false;
}
function messageTimestampMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (value instanceof Date) {
    const ms=value.getTime();
    return Number.isFinite(ms)&&ms>0?ms:0;
  }
  if (typeof value === 'number') {
    let ms=Number(value)||0;
    if (ms>0 && ms<1e11) ms*=1000;
    return Number.isFinite(ms)&&ms>0?ms:0;
  }
  const raw=cleanText(value,160);
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    let ms=Number(raw)||0;
    if (ms>0 && ms<1e11) ms*=1000;
    return Number.isFinite(ms)&&ms>0?ms:0;
  }
  const parsed=Date.parse(raw);
  return Number.isFinite(parsed)&&parsed>0?parsed:0;
}

function normalizedMessageTimestamp(value) {
  const ms=messageTimestampMs(value);
  if (!ms) return cleanText(value,120);
  try { return new Date(ms).toISOString(); } catch { return cleanText(value,120); }
}

function evidenceTimestampMs(evidence = {}) {
  if (!evidence || typeof evidence !== 'object') return 0;
  return messageTimestampMs(evidence.messageTimestamp || evidence.timestamp || evidence.delivered || evidence.createdAt || evidence.sentAt || evidence.time || evidence.ts || '');
}

function evidenceChronology(previousEvidence = {}, incomingEvidence = {}) {
  const previousMs=evidenceTimestampMs(previousEvidence);
  const incomingMs=evidenceTimestampMs(incomingEvidence);
  if (!previousMs || !incomingMs) return {known:false,previousMs,incomingMs,deltaMs:0};
  return {known:true,previousMs,incomingMs,deltaMs:incomingMs-previousMs};
}

function stableMessageEvidenceKey(row = {}) {
  const direct=cleanText(row.messageId,240);
  if (direct) return direct;
  const payload=[row.role,row.text,row.rawText,row.messageTimestamp,row.platform,row.accountId,row.chatId].map(v=>String(v||'')).join('\u001f');
  return `sha256:${crypto.createHash('sha256').update(payload).digest('hex').slice(0,24)}`;
}

function attachMessageProvenance(evidence, row = {}, questionRow = null) {
  if (!evidence || typeof evidence!=='object') return evidence;
  const out={...evidence};
  out.messageId=cleanText(row.messageId,240);
  out.messageKey=stableMessageEvidenceKey(row);
  out.messageTimestamp=normalizedMessageTimestamp(row.messageTimestamp);
  out.platform=cleanText(row.platform,40);
  out.accountId=cleanText(row.accountId,160);
  out.chatId=cleanText(row.chatId,320);
  out.messageRole=String(row.role||'customer');
  if (questionRow) {
    out.questionMessageId=cleanText(questionRow.messageId,240);
    out.questionMessageKey=stableMessageEvidenceKey(questionRow);
    out.questionTimestamp=normalizedMessageTimestamp(questionRow.messageTimestamp);
  }
  return out;
}

function extractCustomerFacts(messages) {
  const rows = (Array.isArray(messages) ? messages : [])
    .map((item, index) => ({
      index,
      role: String(typeof item === 'string' ? 'customer' : (item?.role || 'customer')).toLowerCase(),
      text: stripYokoUiArtifacts(typeof item === 'string' ? item : item?.text, 1600),
      rawText: stripYokoUiArtifacts(typeof item === 'string' ? '' : (item?.rawText || item?.originalText || ''), 1600),
      quotedTexts: typeof item === 'string' ? [] : [item?.quotedText,item?.quoteText,item?.replyPreviewText,item?.replyContextText,item?.referencedText].map(v=>stripYokoUiArtifacts(v,1600)).filter(Boolean),
      translated: typeof item === 'string' ? true : item?.translated !== false,
      messageId: typeof item === 'string' ? '' : cleanText(item?.messageId || item?.id || item?.mid || item?.externalId || item?.eventId || item?.token || '', 240),
      messageTimestamp: typeof item === 'string' ? '' : normalizedMessageTimestamp(item?.messageTimestamp || item?.timestamp || item?.createdAt || item?.sentAt || item?.time || item?.ts || item?.delivered || ''),
      platform: typeof item === 'string' ? '' : cleanText(item?.platform || '', 40),
      accountId: typeof item === 'string' ? '' : cleanText(item?.accountId || '', 160),
      chatId: typeof item === 'string' ? '' : cleanText(item?.chatId || '', 320)
    }))
    .filter(item => item.text && ['customer','incoming','me','outgoing'].includes(item.role));
  const facts = {
    version:SMART_FACT_EXTRACTION_VERSION, provenanceContract:'v127176-message-level-field-provenance',
    name:'', age:'', region:'', occupation:'', interests:[], interestRemovals:[], interestRemovalEvidence:[], evidence:[],
    confidence:{ name:0, age:0, region:0, occupation:0, interests:0 },
    fieldEvidence:{ name:null, age:null, region:null, occupation:null, interests:[] },
    explicitFields:[], contextualFields:[]
  };
  const outgoingValues = [];
  const outgoingTexts = new Set();
  for (const row of rows.filter(row => row.role === 'me' || row.role === 'outgoing')) {
    for (const value of [row.text,row.rawText]) {
      const clean=cleanText(value,1600);
      const key=normalizedEvidenceKey(clean);
      if(key) { outgoingTexts.add(key); outgoingValues.push(clean); }
    }
  }
  const consumedQuestions = new Set();
  const interestSeen = new Set();
  for (let pos=0; pos<rows.length; pos++) {
    const row=rows[pos];
    if (row.role === 'me' || row.role === 'outgoing') continue;
    let text = row.text;
    if (outgoingTexts.has(normalizedEvidenceKey(text)) || (row.rawText && outgoingTexts.has(normalizedEvidenceKey(row.rawText)))) continue;
    text = stripMirroredOutgoingFragments(text, [...outgoingValues, ...row.quotedTexts]);
    if (!text) continue;

    const qInfo = recentProfileQuestion(rows, pos, consumedQuestions);
    const questionText = qInfo?.row?.text || '';
    const candidateFields = qInfo ? confirmationCandidateFields(qInfo.candidates) : [];
    const hasConfirmationCandidate = candidateFields.length > 0;
    const polarity = qInfo ? answerPolarity(text) : '';
    const correctionPayload = polarity === 'deny' ? denialCorrectionPayload(text) : '';
    const affirmedPayload = polarity === 'affirm' && hasConfirmationCandidate ? affirmationPayload(text) : '';
    // Pure yes/no contains no customer fact text. `不是，我在京都` exposes only
    // `我在京都`; `是的，我44岁` exposes only `我44岁` plus the confirmed value.
    const factText = polarity === 'deny' ? correctionPayload : ((polarity === 'affirm' && hasConfirmationCandidate) ? affirmedPayload : text);
    const contextual = contextualFacts(questionText, factText, qInfo?.fields || []);
    const declarativeSource = declarativePrefixBeforeQuestion(factText);
    const directSource = factText ? (questionLike(factText) ? declarativeSource : factText) : '';
    const directAllowed = field => polarity !== 'deny' || !!qInfo?.fields?.includes(field);

    const bundle = directSource ? extractBundledProfileFacts(directSource) : { name:'', age:'', region:'', occupation:'', interests:[], clauses:{}, fieldCount:0, hasNameStatement:false, hasAgeStatement:false, hasRegionStatement:false, hasOccupationStatement:false, hasInterestStatement:false };
    const bundleActive = bundle.fieldCount >= 2;
    const directName = directSource && directAllowed('name') ? (bundle.name || ((bundleActive && bundle.hasNameStatement) ? '' : extractName(directSource))) : '';
    const directAge = directSource && directAllowed('age') ? (bundle.age || extractCurrentAge(directSource) || ((bundleActive && bundle.hasAgeStatement) || historicalOnly(directSource) ? '' : extractAge(directSource))) : '';
    const directRegionRaw = directSource && directAllowed('region') ? (bundle.region || extractCurrentRegion(directSource) || ((bundleActive && bundle.hasRegionStatement) || historicalOnly(directSource) ? '' : normalizeRegionValue(extractRegion(directSource)))) : '';
    const directRegion = directRegionRaw && !obviousConversationNoise(directRegionRaw,'region') ? directRegionRaw : '';
    const directOccupationRaw = directSource && directAllowed('occupation') ? (bundle.occupation || extractCurrentOccupation(directSource) || ((bundleActive && bundle.hasOccupationStatement) || historicalOnly(directSource) ? '' : extractOccupation(directSource))) : '';
    const directOccupation = directOccupationRaw && !occupationStatusOnly(directOccupationRaw) && !new RegExp(`^(?:${CONTEXT_REGION_HINTS.source})$`, 'u').test(directOccupationRaw) && !obviousConversationNoise(directOccupationRaw,'occupation') ? directOccupationRaw : '';
    const directEvidence = (field, value, confidence) => {
      const clauseEvidence = bundle[field] ? cleanText(bundle.clauses?.[field] || '', 280) : '';
      let ev = fieldEvidence(field, value, 'explicit', clauseEvidence || text, '', row.index, bundle[field] ? Math.max(98, confidence) : confidence, row.rawText);
      if (bundle[field]) { ev.multiField = true; ev.clauseEvidence = clauseEvidence; ev.messageEvidence = cleanText(text, 500); }
      ev=attachMessageProvenance(ev,row);
      return ev;
    };

    const qDistance = Number(qInfo?.distance || 0);
    const qIndex = Number(qInfo?.row?.index ?? -1);
    const withContext = ev => ({ ...attachMessageProvenance(ev,row,qInfo?.row||null), questionRowIndex:qIndex, contextDistance:qDistance });

    if (directName) evidenceSummaryRecord(facts, 'name', directName, directEvidence('name', directName, polarity === 'deny' ? 99 : 98));
    else if (contextual.name && qInfo?.fields.includes('name')) evidenceSummaryRecord(facts, 'name', contextual.name, withContext(fieldEvidence('name', contextual.name, polarity === 'deny' ? 'corrected-contextual' : 'contextual', text, questionText, row.index, polarity === 'deny' ? 97 : 91, row.rawText)));

    if (directAge) evidenceSummaryRecord(facts, 'age', directAge, directEvidence('age', directAge, polarity === 'deny' ? 99 : 98));
    else if (contextual.age && qInfo?.fields.includes('age')) evidenceSummaryRecord(facts, 'age', contextual.age, withContext(fieldEvidence('age', contextual.age, polarity === 'deny' ? 'corrected-contextual' : 'contextual', text, questionText, row.index, polarity === 'deny' ? 97 : 92, row.rawText)));

    if (directRegion) {
      const birthplaceOnly = /(?:生まれ|出生|born\s+in)/iu.test(text) && !/(?:住んで|在住|住在|live\s+in)/iu.test(text);
      evidenceSummaryRecord(facts, 'region', directRegion, directEvidence('region', directRegion, polarity === 'deny' ? 99 : (birthplaceOnly ? 84 : 96)));
    } else if (contextual.region && qInfo?.fields.includes('region')) {
      const contextualRegion = normalizeRegionValue(contextual.region);
      if (contextualRegion) evidenceSummaryRecord(facts, 'region', contextualRegion, withContext(fieldEvidence('region', contextualRegion, polarity === 'deny' ? 'corrected-contextual' : 'contextual', text, questionText, row.index, polarity === 'deny' ? 97 : 90, row.rawText)));
    }

    if (directOccupation) evidenceSummaryRecord(facts, 'occupation', directOccupation, directEvidence('occupation', directOccupation, polarity === 'deny' ? 98 : 96));
    else if (contextual.occupation && qInfo?.fields.includes('occupation')) evidenceSummaryRecord(facts, 'occupation', contextual.occupation, withContext(fieldEvidence('occupation', contextual.occupation, polarity === 'deny' ? 'corrected-contextual' : 'contextual', text, questionText, row.index, polarity === 'deny' ? 97 : 90, row.rawText)));

    // Confirmation-only replies inherit ONLY explicit candidates from Yoko's
    // question. They never infer a value from a generic `是的` by itself.
    if (polarity === 'affirm' && qInfo?.candidates) {
      const c = qInfo.candidates;
      if (!directName && !contextual.name && c.name) evidenceSummaryRecord(facts, 'name', c.name, withContext(fieldEvidence('name', c.name, 'confirmed-contextual', text, questionText, row.index, 96, row.rawText)));
      if (!directAge && !contextual.age && c.age) evidenceSummaryRecord(facts, 'age', c.age, withContext(fieldEvidence('age', c.age, 'confirmed-contextual', text, questionText, row.index, 97, row.rawText)));
      if (!directRegion && !contextual.region && c.region) evidenceSummaryRecord(facts, 'region', c.region, withContext(fieldEvidence('region', c.region, 'confirmed-contextual', text, questionText, row.index, 96, row.rawText)));
      if (!directOccupation && !contextual.occupation && c.occupation) evidenceSummaryRecord(facts, 'occupation', c.occupation, withContext(fieldEvidence('occupation', c.occupation, 'confirmed-contextual', text, questionText, row.index, 95, row.rawText)));
    }

    const interestRemovalSource = polarity === 'deny' ? factText : text;
    for (const label of extractNegatedInterests(interestRemovalSource)) {
      if (!facts.interestRemovals.includes(label)) facts.interestRemovals.push(label);
      facts.interestRemovalEvidence.push(attachMessageProvenance({ value:label, evidence:cleanText(interestRemovalSource,500), rawEvidence:cleanText(row.rawText,500), rowIndex:row.index, source:'customer', textSource:'translated', temporal:temporalState(interestRemovalSource) },row));
    }
    const interestSource = polarity === 'deny' ? factText : text;
    const interests = bundle.fieldCount >= 2 && bundle.hasInterestStatement
      ? bundle.interests.map(label => {
          const clauseEvidence = cleanText(Array.isArray(bundle.clauses?.interests) ? bundle.clauses.interests.join('；') : (bundle.clauses?.interests || ''), 500);
          const ev = attachMessageProvenance(fieldEvidence('interests', label, 'explicit', clauseEvidence || text, '', row.index, 98, row.rawText),row);
          ev.multiField = true;
          ev.clauseEvidence = clauseEvidence;
          ev.messageEvidence = cleanText(text, 500);
          return ev;
        })
      : (interestSource ? interestEvidence(interestSource, questionText, row.index) : []);
    if (polarity === 'affirm' && qInfo?.candidates?.interests?.length && !interests.length) {
      for (const label of qInfo.candidates.interests) interests.push(withContext(fieldEvidence('interests', label, 'confirmed-contextual', text, questionText, row.index, 94, row.rawText)));
    }
    for (const ev0 of interests) {
      const baseEv=ev0.messageKey?ev0:attachMessageProvenance(ev0,row);
      const ev = qInfo?.fields.includes('interests') && baseEv.kind === 'contextual' ? withContext(baseEv) : baseEv;
      if (!interestSeen.has(ev.value)) { interestSeen.add(ev.value); facts.interests.push(ev.value); }
      const at = facts.fieldEvidence.interests.findIndex(item => item?.value === ev.value);
      if (at >= 0) { if (evidenceShouldReplace(facts.fieldEvidence.interests[at], ev)) facts.fieldEvidence.interests[at] = ev; }
      else facts.fieldEvidence.interests.push(ev);
      facts.confidence.interests = Math.max(facts.confidence.interests, ev.confidence);
    }
    if (interests.some(ev => ev.kind === 'explicit') && !facts.explicitFields.includes('interests')) facts.explicitFields.push('interests');
    else if (interests.length && !facts.explicitFields.includes('interests') && !facts.contextualFields.includes('interests')) facts.contextualFields.push('interests');

    if (qInfo) {
      const answered = {name:directName || contextual.name, age:directAge || contextual.age, region:directRegion || contextual.region, occupation:directOccupation || contextual.occupation, interests:interests.length};
      // A yes/no answer closes a confirmation question even when it contributes
      // no value (pure denial). This prevents the next unrelated customer line
      // from being attached to an already answered question.
      for (const field of qInfo.fields) if (answered[field] || polarity === 'deny' || (polarity === 'affirm' && hasConfirmationCandidate)) consumedQuestions.add(`${qInfo.row.index}:${field}`);
    }
    if (directName || contextual.name || directAge || contextual.age || directRegion || contextual.region || directOccupation || contextual.occupation || interests.length) facts.evidence.push(text.slice(0, 500));
  }
  facts.signature = crypto.createHash('sha256').update(rows.map(row => `${stableMessageEvidenceKey(row)}:${row.role}:${row.text}:${row.rawText || ''}`).join('\u001f')).digest('hex');
  return facts;
}

function normalizedEvidenceValue(value) {
  return cleanText(value, 500).toLocaleLowerCase();
}

function evidenceHash(evidence = {}) {
  const payload=[evidence.field,evidence.value,evidence.kind,evidence.confidence,evidence.evidence,evidence.rawEvidence,evidence.question,evidence.textSource].map(v=>String(v??'')).join('\u001f');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0,24);
}

function scalarEvidenceRank(evidence = {}) {
  if (!evidence || typeof evidence !== 'object') return 0;
  const kind=String(evidence.kind||'');
  let rank=Number(evidence.confidence||0);
  if (kind==='explicit') rank+=12;
  else if (kind==='corrected-contextual') rank+=11;
  else if (kind==='confirmed-contextual') rank+=7;
  else if (kind==='contextual') rank+=3;
  const temporal=String(evidence.temporal||temporalState(evidence.evidence||''));
  if (temporal==='correction') rank+=14;
  else if (temporal==='current') rank+=10;
  else if (temporal==='historical') rank-=30;
  if (evidence.multiField) rank+=2;
  return rank;
}

function boundedPush(list, item, limit = 8) {
  const out=Array.isArray(list)?[...list]:[];
  out.push(item);
  return out.slice(-Math.max(1,limit));
}

function legacyAcceptedEvidence(meta, field, value) {
  const fromState=meta?.fieldState?.[field];
  if (fromState && typeof fromState==='object' && normalizedEvidenceValue(fromState.value)===normalizedEvidenceValue(value)) return { ...fromState };
  const fromEvidence=meta?.fieldEvidence?.[field];
  if (fromEvidence && typeof fromEvidence==='object' && !Array.isArray(fromEvidence)) return { ...fromEvidence };
  const confidence=Number(meta?.confidence?.[field]||0);
  return value ? { field, value, kind:'legacy-auto', confidence, evidence:'', rawEvidence:'', source:'customer', textSource:'translated', temporal:'stable' } : null;
}

function conflictDecision({ field, currentValue, nextValue, previousEvidence, incomingEvidence, history = [] } = {}) {
  const current=cleanText(currentValue,500), next=cleanText(nextValue,500);
  if (!next) return {accept:false,reason:'empty-incoming'};
  const incoming={...(incomingEvidence||{}),value:next,field};
  const previous=previousEvidence||{};
  const chronology=evidenceChronology(previous,incoming);
  // V1.27.179 monotonic fence: arrival order, retry order and backfill order can
  // all differ from the source message order. A fact observed from an older
  // source message can never rewrite the state/evidence owned by a newer one.
  if (chronology.known && chronology.deltaMs < 0) {
    return {accept:false,reason:normalizedEvidenceValue(current)===normalizedEvidenceValue(next)?'older-same-value-evidence':'older-message'};
  }
  if (!current) return {accept:true,reason:'empty-field'};
  if (incoming.historyBackfill === true && !evidenceTimestampMs(incoming)) return {accept:false,reason:'history-backfill-unknown-time'};
  const temporal=String(incoming.temporal||temporalState(incoming.evidence||''));
  if (evidenceTimestampMs(previous) && !evidenceTimestampMs(incoming) && !['current','correction'].includes(temporal)) return {accept:false,reason:'missing-source-time'};
  if (normalizedEvidenceValue(current)===normalizedEvidenceValue(next)) return {accept:true,reason:'same-value'};
  const confidence=Number(incoming.confidence||0);
  if (temporal==='historical') return {accept:false,reason:'historical-only'};
  const resurrected=(Array.isArray(history)?history:[]).some(item=>normalizedEvidenceValue(item?.value)===normalizedEvidenceValue(next));
  if (resurrected && temporal!=='current' && temporal!=='correction') return {accept:false,reason:'stale-resurrection'};
  if ((temporal==='current'||temporal==='correction') && confidence>=88) return {accept:true,reason:temporal==='correction'?'explicit-correction':'current-state'};
  const kind=String(incoming.kind||'');
  if ((kind==='explicit'||kind==='corrected-contextual') && confidence>=95) return {accept:true,reason:'strong-new-explicit'};
  const previousConfidence=Number(previous.confidence||0);
  const previousKind=String(previous.kind||'');
  if ((previousKind==='explicit'||previousKind==='corrected-contextual') && kind==='contextual' && confidence<previousConfidence) return {accept:false,reason:'weaker-contextual-conflict'};
  if (scalarEvidenceRank(incoming)>=scalarEvidenceRank(previous)+2 && confidence>=90) return {accept:true,reason:'stronger-evidence'};
  return {accept:false,reason:'insufficient-conflict-evidence'};
}

function mergeCrmAutoFacts(existing = {}, facts = {}, options = {}) {
  const meta = existing?._autoExtract && typeof existing._autoExtract === 'object' ? JSON.parse(JSON.stringify(existing._autoExtract)) : {};
  const contact = { ...existing };
  let changed = false;
  if (!meta.fieldEvidence || typeof meta.fieldEvidence!=='object') meta.fieldEvidence={};
  if (!meta.confidence || typeof meta.confidence!=='object') meta.confidence={};
  if (!meta.fieldState || typeof meta.fieldState!=='object') meta.fieldState={};
  if (!meta.fieldHistory || typeof meta.fieldHistory!=='object') meta.fieldHistory={};
  if (!meta.rejectedEvidence || typeof meta.rejectedEvidence!=='object') meta.rejectedEvidence={};

  // Existing self-heal guards are now owner-gated. Even a strange-looking
  // operator-entered value is manual truth until the operator changes it; only a
  // field whose CURRENT value exactly matches its recorded auto owner may be
  // automatically cleared as historical pollution.
  const storedName=cleanText(contact.name,500);
  const nameAutoOwned=!!storedName && cleanText(meta.name,500)===storedName;
  if (nameAutoOwned && (!normalizeName(storedName) || obviousConversationNoise(storedName,'name') || isYokoToolbarArtifactText(storedName))) {
    contact.name=''; meta.name=''; changed=true;
  }
  const storedRegion = cleanText(contact.region,500);
  const regionAutoOwned=!!storedRegion && cleanText(meta.region,500)===storedRegion;
  if (regionAutoOwned && (isYokoToolbarArtifactText(storedRegion) || obviousConversationNoise(storedRegion,'region'))) {
    contact.region = ''; meta.region = ''; changed = true;
  }
  const storedOccupation = cleanText(contact.occupation,500);
  const occupationAutoOwned=!!storedOccupation && cleanText(meta.occupation,500)===storedOccupation;
  if (occupationAutoOwned && (isYokoToolbarArtifactText(storedOccupation) || !normalizeOccupation(storedOccupation) || occupationStatusOnly(storedOccupation) || obviousConversationNoise(storedOccupation,'occupation'))) {
    contact.occupation = ''; meta.occupation = ''; changed = true;
  }

  const forceFields = new Set(Array.isArray(options.forceFields) ? options.forceFields.map(v=>String(v||'').trim()) : []);
  const now=new Date().toISOString();
  for (const field of ['name','age','region','occupation']) {
    const current=cleanText(contact[field],500);
    const oldAuto=cleanText(meta[field],500);
    const next=cleanText(facts[field],500);
    if (!next) continue;
    const displayFallback=field==='name' && !!cleanText(options.displayName,500) && current===cleanText(options.displayName,500);
    const autoOwned=!current || (!!oldAuto && current===oldAuto) || displayFallback;
    const incomingEvidence=(facts.fieldEvidence&&facts.fieldEvidence[field]) || {field,value:next,kind:'contextual',confidence:Number(facts?.confidence?.[field]||0),evidence:'',source:'customer',textSource:'translated',temporal:'stable'};
    const previousEvidence=legacyAcceptedEvidence(meta,field,current||oldAuto);

    // V1.27.175 hard rule: manual operator data wins over every automatic path.
    // forceFields may repair an AUTO-owned stale value, but can never override a
    // value whose current text no longer matches the recorded auto owner.
    if (!autoOwned) {
      if (normalizedEvidenceValue(current)!==normalizedEvidenceValue(next)) {
        meta.rejectedEvidence[field]=boundedPush(meta.rejectedEvidence[field],{value:next,reason:'manual-owned',evidence:cleanText(incomingEvidence.evidence,500),confidence:Number(incomingEvidence.confidence||0),kind:String(incomingEvidence.kind||''),temporal:String(incomingEvidence.temporal||temporalState(incomingEvidence.evidence||'')),messageId:cleanText(incomingEvidence.messageId,240),messageKey:cleanText(incomingEvidence.messageKey,280),messageTimestamp:cleanText(incomingEvidence.messageTimestamp,120),platform:cleanText(incomingEvidence.platform,40),hash:evidenceHash(incomingEvidence),at:now},6);
      }
      continue;
    }

    const decision=conflictDecision({field,currentValue:current,nextValue:next,previousEvidence,incomingEvidence,history:meta.fieldHistory[field]});
    // `force` is allowed only inside auto ownership and only upgrades a legacy
    // auto field when the incoming evidence is not historical.
    const forceRepairableReasons=new Set(['insufficient-conflict-evidence','weaker-contextual-conflict']);
    if (!decision.accept && forceFields.has(field) && autoOwned && forceRepairableReasons.has(String(decision.reason||'')) && String(incomingEvidence.temporal||temporalState(incomingEvidence.evidence||''))!=='historical' && Number(incomingEvidence.confidence||0)>=95) {
      decision.accept=true; decision.reason='forced-auto-repair';
    }
    if (!decision.accept) {
      meta.rejectedEvidence[field]=boundedPush(meta.rejectedEvidence[field],{value:next,reason:decision.reason,evidence:cleanText(incomingEvidence.evidence,500),confidence:Number(incomingEvidence.confidence||0),kind:String(incomingEvidence.kind||''),temporal:String(incomingEvidence.temporal||temporalState(incomingEvidence.evidence||'')),messageId:cleanText(incomingEvidence.messageId,240),messageKey:cleanText(incomingEvidence.messageKey,280),messageTimestamp:cleanText(incomingEvidence.messageTimestamp,120),platform:cleanText(incomingEvidence.platform,40),hash:evidenceHash(incomingEvidence),at:now},6);
      continue;
    }

    if (current && normalizedEvidenceValue(current)!==normalizedEvidenceValue(next)) {
      meta.fieldHistory[field]=boundedPush(meta.fieldHistory[field],{value:current,evidence:cleanText(previousEvidence?.evidence,500),rawEvidence:cleanText(previousEvidence?.rawEvidence,500),confidence:Number(previousEvidence?.confidence||0),kind:String(previousEvidence?.kind||'legacy-auto'),temporal:String(previousEvidence?.temporal||temporalState(previousEvidence?.evidence||'')),messageId:cleanText(previousEvidence?.messageId,240),messageKey:cleanText(previousEvidence?.messageKey,280),messageTimestamp:normalizedMessageTimestamp(previousEvidence?.messageTimestamp),platform:cleanText(previousEvidence?.platform,40),accountId:cleanText(previousEvidence?.accountId,160),chatId:cleanText(previousEvidence?.chatId,320),replacedAt:now,replacedBy:next,reason:decision.reason,hash:previousEvidence?evidenceHash(previousEvidence):''},8);
    }
    if (current!==next) changed=true;
    contact[field]=next;
    meta[field]=next;
    const accepted={...incomingEvidence,field,value:next,temporal:String(incomingEvidence.temporal||temporalState(incomingEvidence.evidence||'')),acceptedAt:now,decision:decision.reason,hash:evidenceHash(incomingEvidence)};
    meta.fieldEvidence[field]=accepted;
    meta.confidence[field]=Number(incomingEvidence.confidence||0);
    meta.fieldState[field]=accepted;
  }

  // Interests use the same monotonic source-time contract as scalar fields.
  // Positive facts are auto-owned only when YokoSCRM actually added them;
  // operator-created tags are never adopted by automation merely because a
  // customer later mentions the same word. Negative facts create tombstones so
  // delayed/old positive packets cannot resurrect a removed interest.
  if (!meta.interestEvidence || typeof meta.interestEvidence!=='object' || Array.isArray(meta.interestEvidence)) meta.interestEvidence={};
  if (!meta.interestTombstones || typeof meta.interestTombstones!=='object' || Array.isArray(meta.interestTombstones)) meta.interestTombstones={};
  if (!Array.isArray(meta.rejectedInterestEvidence)) meta.rejectedInterestEvidence=[];
  const beforeInterests=cleanText(contact.interests,500);
  let currentTokens=uniqueTokens(beforeInterests);
  let autoTokens=[...new Set((Array.isArray(meta.interests)?meta.interests:[]).map(v=>cleanText(v,80)).filter(Boolean))];
  const autoKeySet=()=>new Set(autoTokens.map(v=>normalizedEvidenceValue(v)));
  const currentKeySet=()=>new Set(currentTokens.map(v=>normalizedEvidenceValue(v)));
  const rejectInterest=(value,reason,evidence={})=>{
    meta.rejectedInterestEvidence=boundedPush(meta.rejectedInterestEvidence,{
      value:cleanText(value,80),reason:String(reason||''),evidence:cleanText(evidence?.evidence,500),rawEvidence:cleanText(evidence?.rawEvidence,500),
      confidence:Number(evidence?.confidence||0),kind:String(evidence?.kind||''),temporal:String(evidence?.temporal||temporalState(evidence?.evidence||'')),
      messageId:cleanText(evidence?.messageId,240),messageKey:cleanText(evidence?.messageKey,280),messageTimestamp:normalizedMessageTimestamp(evidence?.messageTimestamp),
      platform:cleanText(evidence?.platform,40),accountId:cleanText(evidence?.accountId,160),chatId:cleanText(evidence?.chatId,320),hash:evidenceHash(evidence),at:now
    },12);
  };
  const interestEvidenceRows=Array.isArray(facts?.fieldEvidence?.interests)?facts.fieldEvidence.interests:[];
  const removalEvidenceRows=Array.isArray(facts?.interestRemovalEvidence)?facts.interestRemovalEvidence:[];
  const evidenceFor=(rows,value)=>rows.find(row=>normalizedEvidenceValue(row?.value)===normalizedEvidenceValue(value))||null;

  for (const raw of Array.isArray(facts.interestRemovals)?facts.interestRemovals:[]) {
    const value=cleanText(raw,80); const key=normalizedEvidenceValue(value); if(!key) continue;
    // Manual/operator interest survives every automatic negative path.
    if (!autoKeySet().has(key)) continue;
    const incoming=evidenceFor(removalEvidenceRows,value)||{field:'interests',value,kind:'explicit-negative',confidence:96,evidence:'',temporal:'stable'};
    if (incoming.historyBackfill === true && !evidenceTimestampMs(incoming)) { rejectInterest(value,'history-backfill-unknown-time-interest-removal',incoming); continue; }
    const previous=meta.interestEvidence[key]||{};
    const chronology=evidenceChronology(previous,incoming);
    if (chronology.known && chronology.deltaMs < 0) { rejectInterest(value,'older-interest-removal',incoming); continue; }
    currentTokens=currentTokens.filter(token=>normalizedEvidenceValue(token)!==key);
    autoTokens=autoTokens.filter(token=>normalizedEvidenceValue(token)!==key);
    meta.interestTombstones[key]={...incoming,field:'interests',value,removedAt:now,hash:evidenceHash(incoming)};
    delete meta.interestEvidence[key];
  }

  for (const raw of Array.isArray(facts.interests)?facts.interests:[]) {
    const value=cleanText(raw,80); const key=normalizedEvidenceValue(value); if(!key) continue;
    const incoming=evidenceFor(interestEvidenceRows,value)||{field:'interests',value,kind:'contextual',confidence:Number(facts?.confidence?.interests||0),evidence:'',temporal:'stable'};
    const alreadyCurrent=currentKeySet().has(key);
    const alreadyAuto=autoKeySet().has(key);
    if (alreadyCurrent) {
      // Preserve manual ownership. If automation already owns it, refresh only
      // with non-older evidence; an old retry cannot roll accepted provenance back.
      if (!alreadyAuto) continue;
      if (incoming.historyBackfill === true && !evidenceTimestampMs(incoming)) { rejectInterest(value,'history-backfill-unknown-time-same-interest',incoming); continue; }
      const previous=meta.interestEvidence[key]||{};
      const chronology=evidenceChronology(previous,incoming);
      if (chronology.known && chronology.deltaMs < 0) { rejectInterest(value,'older-same-interest-evidence',incoming); continue; }
      if (!previous || evidenceShouldReplace(previous,incoming) || !evidenceTimestampMs(previous)) meta.interestEvidence[key]={...incoming,field:'interests',value,acceptedAt:now,hash:evidenceHash(incoming)};
      continue;
    }
    const tombstone=meta.interestTombstones[key]||null;
    if (incoming.historyBackfill === true && !evidenceTimestampMs(incoming) && (currentTokens.length > 0 || tombstone)) { rejectInterest(value,'history-backfill-unknown-time-interest-addition',incoming); continue; }
    if (tombstone) {
      const chronology=evidenceChronology(tombstone,incoming);
      const temporal=String(incoming.temporal||temporalState(incoming.evidence||''));
      const strong=Number(incoming.confidence||0)>=90 && ['explicit','confirmed-contextual','corrected-contextual'].includes(String(incoming.kind||''));
      if (chronology.known && chronology.deltaMs <= 0) { rejectInterest(value,'older-interest-resurrection',incoming); continue; }
      if (!chronology.known && !['current','correction'].includes(temporal)) { rejectInterest(value,'stale-interest-resurrection',incoming); continue; }
      if (chronology.known && chronology.deltaMs > 0 && !strong && !['current','correction'].includes(temporal)) { rejectInterest(value,'weak-interest-resurrection',incoming); continue; }
      // A genuinely newer strong/current customer statement is a legitimate
      // state change (e.g. "我现在又喜欢旅行了"). Keep the tombstone as audit
      // history, but mark it superseded rather than deleting evidence.
      meta.interestTombstones[key]={...tombstone,supersededAt:now,supersededByMessageKey:cleanText(incoming.messageKey,280),supersededByTimestamp:normalizedMessageTimestamp(incoming.messageTimestamp)};
    }
    currentTokens.push(value);
    autoTokens.push(value);
    meta.interestEvidence[key]={...incoming,field:'interests',value,acceptedAt:now,hash:evidenceHash(incoming)};
  }

  const mergedInterests=currentTokens.join('、').slice(0,500);
  if (mergedInterests!==beforeInterests) changed=true;
  contact.interests=mergedInterests;
  meta.interests=[...new Set(autoTokens.map(v=>cleanText(v,80)).filter(Boolean))];
  if (removalEvidenceRows.length) meta.lastInterestRemovalEvidence=removalEvidenceRows.slice(-6);

  if (facts.signature) meta.lastSignature=String(facts.signature);
  if (facts.version) meta.extractorVersion=String(facts.version);
  // Keep the accepted field evidence above. Observed-but-rejected evidence is
  // separately retained so diagnostics never confuse a rejected candidate with
  // the actual CRM owner.
  meta.lastObservedConfidence=facts.confidence&&typeof facts.confidence==='object'?{...facts.confidence}:{};
  meta.lastObservedFieldEvidence=facts.fieldEvidence&&typeof facts.fieldEvidence==='object'?JSON.parse(JSON.stringify(facts.fieldEvidence)):{};
  if (Array.isArray(facts.explicitFields)) meta.explicitFields=[...facts.explicitFields];
  if (Array.isArray(facts.contextualFields)) meta.contextualFields=[...facts.contextualFields];
  if (Array.isArray(facts.evidence)&&facts.evidence.length) meta.lastEvidence=facts.evidence.slice(-6);
  contact._autoExtract=meta;
  return {contact,changed};
}

module.exports = {
  cleanText,
  stripYokoUiArtifacts,
  isYokoToolbarArtifactText,
  obviousConversationNoise,
  uniqueTokens,
  mergeTokens,
  extractCustomerFacts,
  mergeCrmAutoFacts,
  extractName,
  extractAge,
  extractRegion,
  extractOccupation,
  extractInterests,
  splitProfileClauses,
  extractBundledProfileFacts,
  contextualFacts,
  profileQuestionFields,
  answerPolarity,
  denialCorrectionPayload,
  affirmationPayload,
  confirmationQuestionCandidates,
  temporalState,
  currentStateCue,
  historicalStateCue,
  extractCurrentRegion,
  extractCurrentAge,
  extractCurrentOccupation,
  extractNegatedInterests,
  conflictDecision,
  stableMessageEvidenceKey,
  attachMessageProvenance,
  SMART_FACT_EXTRACTION_VERSION
};
