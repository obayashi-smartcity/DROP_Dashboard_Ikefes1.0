/**
 * DROP Engagement AI 分析 — Google Apps Script（Web アプリ）
 * ------------------------------------------------------------
 * details_drop_engagement.html から上位投稿のみを受け取り、
 * 外部ファイルのプロンプトで Azure OpenAI（gpt-6-luna）に分析させ、JSON で返す。
 *
 * ■ アクション（POST / Content-Type: text/plain / body は JSON 文字列）
 *   { "action":"login",   "password":"..." }
 *       → { ok:true, token:"...", expires_in:秒 }
 *   { "action":"analyze", "token":"...", "context":{...}, "posts":[...], "force":false }
 *       → { ok:true, cached:bool, elapsed_ms, model, prompt_version, result:{...} }
 *   エラー時 → { ok:false, code:"AUTH|LOCKED|LIMIT|BAD_REQUEST|CONFIG|AI|SERVER", message:"..." }
 *
 * ■ AI モデル（Azure OpenAI / gpt-6-luna）
 *   接続先は下の AZURE_MODEL で設定（キー以外は機密ではないのでコードに記載）。
 *   API キーは AZURE_MODEL.secret と同じ名前のスクリプトプロパティから読む。
 *
 * ■ スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   必須
 *     APP_PASSWORD        … 画面で入力させるパスワード
 *     AZURE_API_KEY_LUNA  … Azure OpenAI（gpt-6-luna デプロイ）の API キー
 *     PROMPT_URL または PROMPT_FILE_ID
 *                         … プロンプト外部ファイル（URL か Google ドライブのファイル ID）
 *   任意（括弧内は既定値）
 *     REASONING_EFFORT    (none)     … gpt-6-luna の推論量。none が最速。
 *                                      空文字にすると送らない。none が使えない環境では自動で外して再送する
 *     MAX_OUTPUT_TOKENS   (1000)     … 応答時間に最も効く。推論トークンもここに含まれる
 *     TOKEN_TTL_SEC       (21600)    … ログイン有効期間（CacheService 上限 6 時間）
 *     RESULT_CACHE_SEC    (21600)    … 同一条件の分析結果キャッシュ
 *     PROMPT_CACHE_SEC    (300)      … プロンプトファイルのキャッシュ
 *     DAILY_LIMIT         (100)      … AI 呼び出し回数 / 日（キャッシュヒットは数えない）
 *     MAX_FAILS           (10)       … パスワード連続失敗でロックする回数（15 分窓）
 *     MAX_POSTS           (20)       … 受け付ける投稿数の上限
 *     MAX_TEXT            (300)      … 投稿本文 1 件あたりの最大文字数
 *
 * ■ デプロイ
 *   デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *     次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *   発行された /exec URL を HTML の AI_CONFIG.GAS_URL に設定する。
 *   ※ コード修正後は「デプロイを管理 → 編集 → 新バージョン」で同じ URL のまま更新。
 */

/* ============================== 設定 ============================== */

/** Azure OpenAI の接続先（gpt-6-luna） */
const AZURE_MODEL = {
  name: 'gpt-6-luna',
  deployment: 'gpt-6-luna',
  endpoint: 'https://uhr65-mkgfgxtk-eastus2.openai.azure.com/',
  api_version: '2025-04-01-preview',
  secret: 'AZURE_API_KEY_LUNA'   // ← この名前のスクリプトプロパティに API キーを登録
};

function azureUrl_() {
  return AZURE_MODEL.endpoint.replace(/\/+$/, '') +
    '/openai/deployments/' + encodeURIComponent(AZURE_MODEL.deployment) +
    '/chat/completions?api-version=' + encodeURIComponent(AZURE_MODEL.api_version);
}

const DEFAULTS = {
  REASONING_EFFORT: 'none',
  MAX_OUTPUT_TOKENS: '1000',
  TOKEN_TTL_SEC: '21600',
  RESULT_CACHE_SEC: '21600',
  PROMPT_CACHE_SEC: '300',
  DAILY_LIMIT: '100',
  MAX_FAILS: '10',
  MAX_POSTS: '20',
  MAX_TEXT: '300'
};
const FAIL_WINDOW_SEC = 900; // パスワード失敗カウントの窓（15 分）

function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== undefined) return v;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? DEFAULTS[key] : null;
}
function numProp_(key) { return Number(prop_(key)); }

/* ============================ エントリ ============================ */

function doPost(e) {
  try {
    let req;
    try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
    catch (err) { return fail_('BAD_REQUEST', 'リクエストが JSON ではありません'); }

    switch (req.action) {
      case 'login':   return handleLogin_(req);
      case 'analyze': return handleAnalyze_(req);
      default:        return fail_('BAD_REQUEST', '不明な action です');
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return fail_('SERVER', 'サーバーエラー: ' + (err && err.message || err));
  }
}

/** 疎通確認用（ブラウザで /exec を開くと表示） */
function doGet() {
  return json_({ ok: true, service: 'drop-engagement-ai', time: new Date().toISOString() });
}

/* ============================ ログイン ============================ */

function handleLogin_(req) {
  const cache = CacheService.getScriptCache();
  const expected = prop_('APP_PASSWORD');
  if (!expected) return fail_('CONFIG', 'APP_PASSWORD が未設定です');

  const fails = Number(cache.get('auth_fail') || 0);
  if (fails >= numProp_('MAX_FAILS')) {
    return fail_('LOCKED', 'パスワードの失敗回数が上限に達しました。15 分ほど待ってから再試行してください');
  }

  const pw = String(req.password || '');
  if (!pw || !safeEqual_(sha256_(pw), sha256_(expected))) {
    cache.put('auth_fail', String(fails + 1), FAIL_WINDOW_SEC);
    Utilities.sleep(800); // 総当たり対策の遅延
    return fail_('AUTH', 'パスワードが違います');
  }

  const ttl = Math.min(numProp_('TOKEN_TTL_SEC'), 21600);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put('tok_' + sha256_(token), '1', ttl);
  return json_({ ok: true, token: token, expires_in: ttl });
}

function checkToken_(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get('tok_' + sha256_(String(token))) === '1';
}

/* ============================== 分析 ============================== */

function handleAnalyze_(req) {
  const t0 = Date.now();
  if (!checkToken_(req.token)) return fail_('AUTH', 'ログインの有効期限が切れました。パスワードを再入力してください');

  const apiKey = prop_(AZURE_MODEL.secret);
  if (!apiKey) return fail_('CONFIG', 'スクリプトプロパティ ' + AZURE_MODEL.secret + ' が未設定です');

  // ---- 入力の検証・整形（ホワイトリスト方式。想定外の項目は捨てる）----
  const posts = sanitizePosts_(req.posts);
  if (!posts.length) return fail_('BAD_REQUEST', '分析対象の投稿がありません');
  const context = sanitizeContext_(req.context);

  // ---- プロンプト（外部ファイル）----
  const prompt = loadPrompt_();
  const model = AZURE_MODEL.name;

  // ---- 結果キャッシュ（データ・プロンプト・モデルが同じなら再利用）----
  const cache = CacheService.getScriptCache();
  const cacheKey = 'res_' + sha256_(JSON.stringify([model, prompt.version, context, posts]));
  if (!req.force) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const saved = JSON.parse(hit);
      saved.cached = true;
      saved.elapsed_ms = Date.now() - t0;
      return json_(saved);
    }
  }

  // ---- 1 日あたりの呼び出し上限 ----
  if (!consumeDailyQuota_()) return fail_('LIMIT', '本日の AI 分析回数の上限に達しました');

  // ---- Azure OpenAI 呼び出し ----
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: fillTemplate_(prompt.user, {
        CONTEXT: JSON.stringify(context),
        POSTS: JSON.stringify(posts),
        POST_IDS: posts.map(p => p.id).join(', ')
      }) }
  ];
  const result = callAzureOpenAI_(apiKey, messages);
  if (result.error) return fail_('AI', result.error);

  // 存在しない ID を参照していたら落とす（ハルシネーション対策）
  const ids = new Set(posts.map(p => p.id));
  ['like_top', 'pv_top'].forEach(k => {
    if (result.data[k] && Array.isArray(result.data[k].evidence_ids)) {
      result.data[k].evidence_ids = result.data[k].evidence_ids.filter(id => ids.has(id));
    }
  });

  const payload = {
    ok: true,
    cached: false,
    model: model,
    prompt_version: prompt.version,
    generated_at: new Date().toISOString(),
    result: result.data
  };
  try { cache.put(cacheKey, JSON.stringify(payload), Math.min(numProp_('RESULT_CACHE_SEC'), 21600)); } catch (e) { /* 100KB 超などは無視 */ }
  payload.elapsed_ms = Date.now() - t0;
  return json_(payload);
}

function sanitizePosts_(raw) {
  if (!Array.isArray(raw)) return [];
  const maxPosts = numProp_('MAX_POSTS'), maxText = numProp_('MAX_TEXT');
  const num = v => (isFinite(Number(v)) ? Number(v) : 0);
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  return raw.slice(0, maxPosts).map((p, i) => {
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

/* ============================ プロンプト ============================ */

/**
 * プロンプトファイル書式（Markdown / テキスト）
 *   ## SYSTEM
 *   （システムプロンプト）
 *   ## USER
 *   （ユーザープロンプト。{{CONTEXT}} {{POSTS}} {{POST_IDS}} を置換）
 * 先頭の <!-- --> コメントは送信前に除去する。
 */
function loadPrompt_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('prompt_v1');
  if (hit) return JSON.parse(hit);

  let text = null;
  const fileId = prop_('PROMPT_FILE_ID');
  const url = prop_('PROMPT_URL');
  if (fileId) {
    text = DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8');
  } else if (url) {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) throw new Error('プロンプトファイルを取得できません (HTTP ' + res.getResponseCode() + ')');
    text = res.getContentText('UTF-8');
  } else {
    throw new Error('PROMPT_URL または PROMPT_FILE_ID を設定してください');
  }

  text = text.replace(/<!--[\s\S]*?-->/g, '');
  const m = text.match(/##\s*SYSTEM\s*\n([\s\S]*?)\n##\s*USER\s*\n([\s\S]*)$/i);
  if (!m) throw new Error('プロンプトファイルに「## SYSTEM」「## USER」の見出しがありません');

  const prompt = { system: m[1].trim(), user: m[2].trim(), version: sha256_(text).slice(0, 10) };
  cache.put('prompt_v1', JSON.stringify(prompt), numProp_('PROMPT_CACHE_SEC'));
  return prompt;
}

function fillTemplate_(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (all, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : all));
}

/** プロンプトを書き換えた直後にすぐ反映したいとき、エディタから実行 */
function clearPromptCache() {
  CacheService.getScriptCache().remove('prompt_v1');
  console.log('プロンプトのキャッシュを削除しました');
}

/* ============================== OpenAI ============================== */

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

/**
 * Azure OpenAI（Chat Completions）を呼ぶ。
 * gpt-6-luna は推論モデルのため temperature は送らず、reasoning_effort で推論量を抑えて高速化する。
 */
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
  // API バージョンやデプロイが reasoning_effort（の値）に未対応なら、外して 1 回だけ再送
  if (r.code === 400 && body.reasoning_effort && /reasoning_effort|reasoning/i.test(r.text)) {
    console.warn('reasoning_effort=' + body.reasoning_effort + ' が拒否されたため外して再送します: ' + r.text);
    delete body.reasoning_effort;
    r = postAzure_(apiKey, body);
  }

  let json;
  try { json = JSON.parse(r.text); } catch (e) { return { error: 'Azure OpenAI の応答を解釈できません (HTTP ' + r.code + ')' }; }
  if (r.code !== 200) {
    console.error('Azure OpenAI error', r.code, r.text);
    const m = (json.error && json.error.message) || '';
    if (r.code === 401) return { error: 'API キーが無効です（' + AZURE_MODEL.secret + ' を確認してください）' };
    if (r.code === 404) return { error: 'デプロイ「' + AZURE_MODEL.deployment + '」または api-version が見つかりません' };
    if (r.code === 429) return { error: 'Azure OpenAI の利用上限に達しました。少し待ってから再実行してください' };
    return { error: 'Azure OpenAI エラー (HTTP ' + r.code + '): ' + m };
  }

  const choice = json.choices && json.choices[0];
  const msg = choice && choice.message;
  if (!msg) return { error: 'AI の応答が空です' };
  if (msg.refusal) return { error: 'AI が回答を拒否しました: ' + msg.refusal };
  if (choice.finish_reason === 'content_filter') return { error: 'Azure のコンテンツフィルターにより応答が停止されました' };
  if (choice.finish_reason === 'length') return { error: '出力が上限で途切れました。MAX_OUTPUT_TOKENS を増やすか、プロンプトで出力量を減らしてください' };
  if (json.usage) console.log('usage', JSON.stringify(json.usage));
  try { return { data: JSON.parse(msg.content) }; }
  catch (e) { return { error: 'AI の出力が JSON ではありません' }; }
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

function consumeDailyQuota_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const key = 'count_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    const n = Number(props.getProperty(key) || 0);
    if (n >= numProp_('DAILY_LIMIT')) return false;
    props.setProperty(key, String(n + 1));
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
  ['APP_PASSWORD', AZURE_MODEL.secret].forEach(k => console.log(k + ': ' + (prop_(k) ? '設定済み' : '★未設定')));
  console.log('PROMPT: ' + (prop_('PROMPT_FILE_ID') ? 'Drive ' + prop_('PROMPT_FILE_ID') : (prop_('PROMPT_URL') || '★未設定')));
  console.log('MODEL: ' + AZURE_MODEL.name + ' / URL: ' + azureUrl_());
  console.log('REASONING_EFFORT: ' + (prop_('REASONING_EFFORT') || '(送らない)') + ' / MAX_OUTPUT_TOKENS: ' + prop_('MAX_OUTPUT_TOKENS'));
  clearPromptCache();
  const p = loadPrompt_();
  console.log('プロンプト version=' + p.version + ' system=' + p.system.length + '字 user=' + p.user.length + '字');
}

/** ダミーデータで OpenAI まで通しの確認と所要時間の計測（エディタから実行） */
function testAnalyze() {
  const pw = prop_('APP_PASSWORD');
  const login = JSON.parse(handleLogin_({ password: pw }).getContent());
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