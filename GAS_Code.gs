/**
 * DROP Engagement AI 分析 — Google Apps Script（Web アプリ）
 * ------------------------------------------------------------
 * details_drop_engagement.html から上位投稿のみを受け取り、
 * 外部ファイル（GitHub 上の Markdown）のプロンプトで Azure OpenAI に分析させ、JSON で返す。
 *
 * ■ アクション（POST / Content-Type: text/plain / body は JSON 文字列）
 *   { "action":"login",   "password":"..." }
 *       → { ok:true, token:"...", expires_in:秒 }
 *   { "action":"analyze", "token":"...", "context":{...}, "posts":[...], "force":false }
 *       → { ok:true, cached:bool, elapsed_ms, model, prompt_version, generated_at, result:{...} }
 *   エラー時 → { ok:false, code:"AUTH|LOCKED|LIMIT|BUSY|BAD_REQUEST|CONFIG|AI|SERVER", message:"..." }
 *
 * ■ スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   必須
 *     APP_PASSWORD        … 画面で入力させるパスワード
 *     AZURE_API_KEY_LUNA  … Azure OpenAI デプロイの API キー（※リポジトリには絶対に書かない）
 *     PROMPT_URL          … プロンプトの URL（GitHub の raw URL。github.com/.../blob/... も自動変換）
 *   任意（括弧内は既定値）
 *     REASONING_EFFORT    (none)   … 推論量。空文字にすると送らない。未対応環境では自動で外して再送
 *     MAX_OUTPUT_TOKENS   (2000)   … 推論トークンも含む上限。日本語 JSON は 1000 だと途切れやすい
 *     TOKEN_TTL_SEC       (21600)  … ログイン有効期間（CacheService 上限 6 時間）
 *     RESULT_CACHE_SEC    (21600)  … 同一条件の分析結果キャッシュ
 *     PROMPT_CACHE_SEC    (300)    … プロンプトのキャッシュ（GitHub raw 側にも数分のキャッシュあり）
 *     DAILY_LIMIT         (100)    … AI 呼び出し回数 / 日（キャッシュヒット・失敗は数えない）
 *     MAX_FAILS           (10)     … パスワード連続失敗でロックする回数（15 分窓）
 *     MAX_POSTS           (20)     … 受け付ける投稿数の上限
 *     MAX_TEXT            (300)    … 投稿本文 1 件あたりの最大文字数
 *
 * ■ デプロイ
 *   デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *     次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *   発行された /exec URL を HTML の AI_CONFIG.GAS_URL に設定する。
 *   ※ コード修正後は「デプロイを管理 → 編集 → 新バージョン」で同じ URL のまま更新。
 */

/* ============================== 設定 ============================== */

/** Azure OpenAI の接続先（API キー以外は機密ではない） */
const AZURE_MODEL = {
  name: 'gpt-6-luna',
  deployment: 'gpt-6-luna',
  endpoint: 'https://uhr65-mkgfgxtk-eastus2.openai.azure.com/',
  api_version: '2025-04-01-preview',
  secret: 'AZURE_API_KEY_LUNA' // ← この名前のスクリプトプロパティに API キーを登録
};

const DEFAULTS = {
  REASONING_EFFORT: 'none',
  MAX_OUTPUT_TOKENS: 2000,
  TOKEN_TTL_SEC: 21600,
  RESULT_CACHE_SEC: 21600,
  PROMPT_CACHE_SEC: 300,
  DAILY_LIMIT: 100,
  MAX_FAILS: 10,
  MAX_POSTS: 20,
  MAX_TEXT: 300
};

const CACHE_MAX_SEC = 21600;   // CacheService の上限（6 時間）
const FAIL_WINDOW_SEC = 900;   // パスワード失敗カウントの窓（15 分）
const KEY = {
  FAIL: 'auth_fail',
  PROMPT: 'prompt_v2',
  TOKEN: 'tok_',
  RESULT: 'res_',
  QUOTA: 'count_'
};
const LIMITS = { TRAITS: 3, EVIDENCE: 3, GAP: 3, RECOMMENDATIONS: 3, CAVEATS: 2 };

/** クライアントに返してよいエラー */
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 文字列プロパティ（未設定なら DEFAULTS、無ければ null） */
function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== undefined) return v;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? String(DEFAULTS[key]) : null;
}

/** 数値プロパティ（未設定・不正値は既定値にフォールバック） */
function numProp_(key) {
  const raw = prop_(key);
  const n = Number(raw);
  return raw === null || raw === '' || !isFinite(n) ? Number(DEFAULTS[key]) : n;
}

function azureUrl_() {
  return AZURE_MODEL.endpoint.replace(/\/+$/, '') +
    '/openai/deployments/' + encodeURIComponent(AZURE_MODEL.deployment) +
    '/chat/completions?api-version=' + encodeURIComponent(AZURE_MODEL.api_version);
}

/* ============================ エントリ ============================ */

function doPost(e) {
  try {
    let req;
    try {
      req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      throw new AppError('BAD_REQUEST', 'リクエストが JSON ではありません');
    }
    switch (req && req.action) {
      case 'login':   return handleLogin_(req);
      case 'analyze': return handleAnalyze_(req);
      default:        throw new AppError('BAD_REQUEST', '不明な action です');
    }
  } catch (err) {
    if (err instanceof AppError) return fail_(err.code, err.message);
    // 内部情報（ファイル名・URL・スタック等）はクライアントに返さず、実行ログにだけ残す
    console.error((err && err.stack) || err);
    return fail_('SERVER', 'サーバーエラーが発生しました。管理者は GAS の実行ログを確認してください');
  }
}

/** 疎通確認用（ブラウザで /exec を開くと表示） */
function doGet() {
  return json_({ ok: true, service: 'drop-engagement-ai', time: new Date().toISOString() });
}

/* ============================ ログイン ============================ */

function handleLogin_(req) {
  const expected = prop_('APP_PASSWORD');
  if (!expected) throw new AppError('CONFIG', 'APP_PASSWORD が未設定です');

  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(KEY.FAIL) || 0);
  if (fails >= numProp_('MAX_FAILS')) {
    throw new AppError('LOCKED', 'パスワードの失敗回数が上限に達しました。15 分ほど待ってから再試行してください');
  }

  const pw = String((req && req.password) || '');
  if (!pw || !safeEqual_(sha256_(pw), sha256_(expected))) {
    cache.put(KEY.FAIL, String(fails + 1), FAIL_WINDOW_SEC);
    Utilities.sleep(800); // 総当たり対策の遅延
    throw new AppError('AUTH', 'パスワードが違います');
  }

  cache.remove(KEY.FAIL);
  const ttl = Math.min(numProp_('TOKEN_TTL_SEC'), CACHE_MAX_SEC);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put(KEY.TOKEN + sha256_(token), '1', ttl);
  return json_({ ok: true, token: token, expires_in: ttl });
}

function checkToken_(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get(KEY.TOKEN + sha256_(String(token))) === '1';
}

/* ============================== 分析 ============================== */

function handleAnalyze_(req) {
  const t0 = Date.now();
  if (!checkToken_(req.token)) {
    throw new AppError('AUTH', 'ログインの有効期限が切れました。パスワードを再入力してください');
  }
  const apiKey = prop_(AZURE_MODEL.secret);
  if (!apiKey) throw new AppError('CONFIG', 'スクリプトプロパティ ' + AZURE_MODEL.secret + ' が未設定です');

  // 入力の検証・整形（ホワイトリスト方式。想定外の項目は捨てる）
  const posts = sanitizePosts_(req.posts);
  if (!posts.length) throw new AppError('BAD_REQUEST', '分析対象の投稿がありません');
  const context = sanitizeContext_(req.context);

  const prompt = loadPrompt_();
  const model = AZURE_MODEL.name;

  // 結果キャッシュ（データ・プロンプト・モデルが同じなら再利用）
  const cache = CacheService.getScriptCache();
  const cacheKey = KEY.RESULT + sha256_(JSON.stringify([model, prompt.version, context, posts]));
  if (!req.force) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const saved = JSON.parse(hit);
      saved.cached = true;
      saved.elapsed_ms = Date.now() - t0;
      return json_(saved);
    }
  }

  // 1 日あたりの呼び出し上限（失敗したら返却する）
  if (!adjustDailyQuota_(+1)) throw new AppError('LIMIT', '本日の AI 分析回数の上限に達しました');

  const ids = posts.map(p => p.id);
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: fillTemplate_(prompt.user, {
      CONTEXT: JSON.stringify(context),
      POSTS: JSON.stringify(posts),
      POST_IDS: ids.join(', ')
    }) }
  ];

  let data;
  try {
    data = callAzureOpenAI_(apiKey, messages);
  } catch (err) {
    adjustDailyQuota_(-1);
    throw err;
  }

  const payload = {
    ok: true,
    cached: false,
    model: model,
    prompt_version: prompt.version,
    generated_at: new Date().toISOString(),
    result: normalizeResult_(data, new Set(ids))
  };
  try {
    cache.put(cacheKey, JSON.stringify(payload), Math.min(numProp_('RESULT_CACHE_SEC'), CACHE_MAX_SEC));
  } catch (e) { /* 100KB 超などは無視 */ }
  payload.elapsed_ms = Date.now() - t0;
  return json_(payload);
}

function sanitizePosts_(raw) {
  if (!Array.isArray(raw)) return [];
  const maxText = numProp_('MAX_TEXT');
  const num = v => (isFinite(Number(v)) ? Number(v) : 0);
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  return raw
    .filter(p => p && typeof p === 'object')
    .slice(0, numProp_('MAX_POSTS'))
    .map((p, i) => {
      const o = {
        id: /^P\d{1,3}$/.test(String(p.id)) ? String(p.id) : 'P' + (i + 1),
        groups: (Array.isArray(p.groups) ? p.groups : []).filter(g => g === 'like_top' || g === 'pv_top'),
        like_rank: num(p.like_rank),
        pv_rank: num(p.pv_rank),
        like: num(p.like),
        pv: num(p.pv),
        like_rate: num(p.like_rate),
        date: str(p.date, 10),
        hour: str(p.hour, 2),
        gender: str(p.gender, 10),
        age: str(p.age, 10),
        text_len: num(p.text_len),
        text: str(p.text, maxText)
      };
      if (p.name) o.name = str(p.name, 40);
      return o;
    });
}

function sanitizeContext_(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = v => (isFinite(Number(v)) ? Number(v) : 0);
  const arr = v => (Array.isArray(v) ? v.slice(0, 20).map(x => String(x).slice(0, 20)) : []);
  return {
    event: String(c.event || '').slice(0, 60),
    date_from: String(c.date_from || '').slice(0, 10),
    date_to: String(c.date_to || '').slice(0, 10),
    genders: arr(c.genders),
    ages: arr(c.ages),
    total_posts: num(c.total_posts),
    total_likes: num(c.total_likes),
    total_pv: num(c.total_pv),
    avg_like: num(c.avg_like),
    avg_pv: num(c.avg_pv),
    avg_like_rate: num(c.avg_like_rate),
    top_n: num(c.top_n)
  };
}

/** AI 出力を画面が想定する形に整える（件数上限の強制・存在しない ID の除去） */
function normalizeResult_(data, validIds) {
  const d = data && typeof data === 'object' ? data : {};
  const list = (v, max) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, max) : []);
  const group = g => {
    const x = g && typeof g === 'object' ? g : {};
    return {
      summary: String(x.summary || ''),
      traits: list(x.traits, LIMITS.TRAITS),
      evidence_ids: list(x.evidence_ids, Infinity).filter(id => validIds.has(id)).slice(0, LIMITS.EVIDENCE)
    };
  };
  return {
    headline: String(d.headline || ''),
    like_top: group(d.like_top),
    pv_top: group(d.pv_top),
    gap_insights: list(d.gap_insights, LIMITS.GAP),
    recommendations: list(d.recommendations, LIMITS.RECOMMENDATIONS),
    caveats: list(d.caveats, LIMITS.CAVEATS)
  };
}

/* ============================ プロンプト ============================ */

/**
 * プロンプトファイル書式（Markdown / テキスト）
 *   ## SYSTEM  （または ### SYSTEM）
 *   （システムプロンプト）
 *   ## USER    （または ### USER）
 *   （ユーザープロンプト。{{CONTEXT}} {{POSTS}} {{POST_IDS}} を置換）
 * <!-- --> コメントは送信前に除去する。
 */
function loadPrompt_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(KEY.PROMPT);
  if (hit) return JSON.parse(hit);

  const url = normalizePromptUrl_(prop_('PROMPT_URL'));
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('プロンプトファイルを取得できません (HTTP ' + res.getResponseCode() + ') ' + url);
  }
  const prompt = parsePrompt_(res.getContentText('UTF-8'));
  cache.put(KEY.PROMPT, JSON.stringify(prompt), Math.min(numProp_('PROMPT_CACHE_SEC'), CACHE_MAX_SEC));
  return prompt;
}

/** github.com/<owner>/<repo>/blob/<ref>/<path> → raw.githubusercontent.com に変換 */
function normalizePromptUrl_(url) {
  if (!url) throw new Error('PROMPT_URL を設定してください');
  const m = String(url).trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  return m ? 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] : String(url).trim();
}

function parsePrompt_(rawText) {
  if (/^\s*<(!doctype|html)/i.test(rawText)) {
    throw new Error('プロンプトが HTML で返りました。PROMPT_URL に raw URL（raw.githubusercontent.com）を指定してください');
  }
  const text = rawText
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '');
  // 見出しは ## / ### どちらも可。行頭のみ対象（本文中の #### 見出しとは区別される）
  const m = text.match(/^#{2,3}[ \t]*SYSTEM[ \t]*\n([\s\S]*?)^#{2,3}[ \t]*USER[ \t]*\n([\s\S]*)$/im);
  if (!m) throw new Error('プロンプトファイルに「## SYSTEM」「## USER」の見出しがありません');
  return { system: m[1].trim(), user: m[2].trim(), version: sha256_(text).slice(0, 10) };
}

function fillTemplate_(tpl, vars) {
  // Markdown のエスケープ（{{POST\_IDS}}）が混ざっても置換できるようにする
  return tpl.replace(/\{\{\s*([\w\\]+?)\s*\}\}/g, (all, k) => {
    const name = k.replace(/\\/g, '');
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all;
  });
}

/** プロンプトを書き換えた直後にすぐ反映したいとき、エディタから実行 */
function clearPromptCache() {
  CacheService.getScriptCache().remove(KEY.PROMPT);
  console.log('プロンプトのキャッシュを削除しました');
}

/* ============================== Azure OpenAI ============================== */

/** 画面の描画と対応する出力スキーマ（HTML 側と合わせて変更すること） */
const OUTPUT_SCHEMA = (() => {
  const strArr = { type: 'array', items: { type: 'string' } };
  const group = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'traits', 'evidence_ids'],
    properties: { summary: { type: 'string' }, traits: strArr, evidence_ids: strArr }
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'like_top', 'pv_top', 'gap_insights', 'recommendations', 'caveats'],
    properties: {
      headline: { type: 'string' },
      like_top: group,
      pv_top: group,
      gap_insights: strArr,
      recommendations: strArr,
      caveats: strArr
    }
  };
})();

/** Chat Completions を呼び、パース済みの出力 JSON を返す（失敗時は AppError） */
function callAzureOpenAI_(apiKey, messages) {
  const body = {
    messages: messages,
    max_completion_tokens: numProp_('MAX_OUTPUT_TOKENS'),
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'drop_engagement_analysis', strict: true, schema: OUTPUT_SCHEMA }
    }
  };
  const effort = prop_('REASONING_EFFORT');
  if (effort) body.reasoning_effort = effort;

  let r = postAzure_(apiKey, body);
  // reasoning_effort（の値）に未対応なら、外して 1 回だけ再送
  if (r.code === 400 && body.reasoning_effort && /reasoning/i.test(r.text)) {
    console.warn('reasoning_effort=' + body.reasoning_effort + ' が拒否されたため外して再送します: ' + r.text);
    delete body.reasoning_effort;
    r = postAzure_(apiKey, body);
  }

  let json;
  try {
    json = JSON.parse(r.text);
  } catch (e) {
    throw new AppError('AI', 'Azure OpenAI の応答を解釈できません (HTTP ' + r.code + ')');
  }
  if (r.code !== 200) {
    console.error('Azure OpenAI error', r.code, r.text);
    const m = String((json.error && json.error.message) || '').slice(0, 200);
    if (r.code === 401) throw new AppError('AI', 'API キーが無効です（' + AZURE_MODEL.secret + ' を確認してください）');
    if (r.code === 404) throw new AppError('AI', 'デプロイ「' + AZURE_MODEL.deployment + '」または api-version が見つかりません');
    if (r.code === 429) throw new AppError('AI', 'Azure OpenAI の利用上限に達しました。少し待ってから再実行してください');
    throw new AppError('AI', 'Azure OpenAI エラー (HTTP ' + r.code + '): ' + m);
  }

  const choice = json.choices && json.choices[0];
  const msg = choice && choice.message;
  if (!msg) throw new AppError('AI', 'AI の応答が空です');
  if (msg.refusal) throw new AppError('AI', 'AI が回答を拒否しました: ' + String(msg.refusal).slice(0, 200));
  if (choice.finish_reason === 'content_filter') throw new AppError('AI', 'Azure のコンテンツフィルターにより応答が停止されました');
  if (choice.finish_reason === 'length') throw new AppError('AI', '出力が上限で途切れました。MAX_OUTPUT_TOKENS を増やすか、プロンプトで出力量を減らしてください');
  if (json.usage) console.log('usage', JSON.stringify(json.usage));
  try {
    return JSON.parse(msg.content);
  } catch (e) {
    throw new AppError('AI', 'AI の出力が JSON ではありません');
  }
}

function postAzure_(apiKey, body) {
  const res = UrlFetchApp.fetch(azureUrl_(), {
    method: 'post',
    contentType: 'application/json',
    headers: { 'api-key': apiKey },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), text: res.getContentText() };
}

/* ============================== 共通 ============================== */

/**
 * 1 日の呼び出し回数を増減する（delta=+1: 消費 / -1: 返却）。
 * 消費で上限超過なら false。前日以前のカウンタは掃除する。
 */
function adjustDailyQuota_(delta) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    throw new AppError('BUSY', 'アクセスが集中しています。少し待ってから再実行してください');
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const key = KEY.QUOTA + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    const n = Number(props.getProperty(key) || 0);
    if (delta > 0 && n >= numProp_('DAILY_LIMIT')) return false;
    props.setProperty(key, String(Math.max(0, n + delta)));
    if (delta > 0) {
      props.getKeys()
        .filter(k => k.indexOf(KEY.QUOTA) === 0 && k !== key)
        .forEach(k => props.deleteProperty(k));
    }
    return true;
  } finally {
    lock.releaseLock();
  }
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(code, message) { return json_({ ok: false, code: code, message: message }); }

/* ============================ 動作確認用 ============================ */

/** 設定とプロンプトの読み込みを確認（エディタから実行） */
function checkSetup() {
  ['APP_PASSWORD', AZURE_MODEL.secret, 'PROMPT_URL'].forEach(k => console.log(k + ': ' + (prop_(k) ? '設定済み' : '★未設定')));
  console.log('MODEL: ' + AZURE_MODEL.name + ' / URL: ' + azureUrl_());
  console.log('REASONING_EFFORT: ' + (prop_('REASONING_EFFORT') || '(送らない)') + ' / MAX_OUTPUT_TOKENS: ' + numProp_('MAX_OUTPUT_TOKENS'));
  clearPromptCache();
  const p = loadPrompt_();
  console.log('プロンプト version=' + p.version + ' system=' + p.system.length + '字 user=' + p.user.length + '字');
}

/** ダミーデータで Azure OpenAI まで通しの確認と所要時間の計測（エディタから実行） */
function testAnalyze() {
  const login = JSON.parse(handleLogin_({ password: prop_('APP_PASSWORD') }).getContent());
  const t0 = Date.now();
  const out = JSON.parse(handleAnalyze_({
    token: login.token,
    force: true,
    context: { event: 'test', total_posts: 3, total_likes: 3, total_pv: 30, top_n: 2 },
    posts: [
      { id: 'P1', groups: ['like_top', 'pv_top'], like_rank: 1, pv_rank: 1, like: 2, pv: 16, like_rate: 12.5, date: '2026-10-19', hour: '18', text_len: 40, text: '夜の蔵はレトロな趣が深まり、昼とは違う魅力があります。' },
      { id: 'P2', groups: ['pv_top'], like_rank: 2, pv_rank: 2, like: 1, pv: 12, like_rate: 8.3, date: '2026-10-19', hour: '11', text_len: 35, text: '二重螺旋階段と噴水。カラフルな照明の段裏に注目。' }
    ]
  }).getContent());
  console.log('所要 ' + (Date.now() - t0) + 'ms');
  console.log(JSON.stringify(out, null, 2));
}
