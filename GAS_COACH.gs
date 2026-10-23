/**
 * DROP Coach（投稿改善アシスタント）— Google Apps Script（Web アプリ）
 * ------------------------------------------------------------
 * drop_coach.html から「改善したい投稿（T）」と「目的に応じた参考投稿（R1, R2 …）」を受け取り、
 * 外部ファイル（GitHub 上の Markdown）のプロンプトで Azure OpenAI に改善案を作らせ、JSON で返す。
 * GAS_GPT（エンゲージメント分析）をベースに、action を "coach" に置き換えた別プロジェクト。
 *
 * ■ アクション（POST / Content-Type: text/plain / body は JSON 文字列）
 *   { "action":"login", "password":"..." }
 *       → { ok:true, token:"...", expires_in:秒 }
 *   { "action":"coach", "token":"...",
 *     "goal":{ "type":"pv|like|other", "label":"...", "note":"自由記述（other のとき）" },
 *     "context":{...}, "target":{ id:"T", ... }, "references":[{ id:"R1", ... }],
 *     "instructions":"追加の指示（任意）", "fewshots":[{ "input":"...", "output":"..." }], "force":false }
 *       → { ok:true, cached:bool, elapsed_ms, model, prompt_version, generated_at, result:{...} }
 *   エラー時 → { ok:false, code:"AUTH|LOCKED|LIMIT|BUSY|BAD_REQUEST|CONFIG|AI|SERVER", message:"..." }
 *
 * ■ スクリプトプロパティ
 *   必須
 *     APP_PASSWORD        … 画面で入力させるパスワード
 *     AZURE_API_KEY_LUNA  … Azure OpenAI の API キー（※リポジトリには絶対に書かない）
 *     PROMPT_URL          … プロンプト（drop_coach_prompt.md）の raw URL
 *   任意（括弧内は既定値）
 *     REASONING_EFFORT (none) / MAX_OUTPUT_TOKENS (2500) / TOKEN_TTL_SEC (21600)
 *     RESULT_CACHE_SEC (21600) / PROMPT_CACHE_SEC (300) / DAILY_LIMIT (100) / MAX_FAILS (30)
 *     MAX_REFS (20) / MAX_TEXT (300) / MAX_INSTR (400) / MAX_GOAL (200)
 *     MAX_SHOTS (3) / MAX_SHOT_TEXT (400)
 *
 * ■ デプロイ
 *   デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *     次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *   発行された /exec URL を HTML の CONFIG.GAS_URL に設定する。
 *
 * ■ 貼り付け時の注意
 *   コピー時に URL が a タグに、記号 > < が HTML 実体参照に化けることがある。
 *   貼り付け後に「&g」+「t;」「&l」+「t;」「<a」+「 href」で検索し 0 件であることを確認すること。
 */

/* ============================== 設定 ============================== */
const AZURE_MODEL = {
  name: 'gpt-6-luna',
  deployment: 'gpt-6-luna',
  endpoint: 'https://uhr65-mkgfgxtk-eastus2.openai.azure.com',
  api_version: '2025-04-01-preview',
  secret: 'AZURE_API_KEY_LUNA'
};
const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com';
const DEFAULTS = {
  REASONING_EFFORT: 'none',
  MAX_OUTPUT_TOKENS: 2500,
  TOKEN_TTL_SEC: 21600,
  RESULT_CACHE_SEC: 21600,
  PROMPT_CACHE_SEC: 300,
  DAILY_LIMIT: 100,
  MAX_FAILS: 30,
  MAX_REFS: 20,
  MAX_TEXT: 300,
  MAX_INSTR: 400,
  MAX_GOAL: 200,
  MAX_SHOTS: 3,
  MAX_SHOT_TEXT: 400
};
const CACHE_MAX_SEC = 21600;
const FAIL_WINDOW_SEC = 900;
const KEY = { FAIL: 'coach_auth_fail', PROMPT: 'coach_prompt_v1', TOKEN: 'coach_tok_', RESULT: 'coach_res_', QUOTA: 'coach_count_' };
const LIMITS = { STRENGTHS: 3, WEAKNESSES: 3, TRAITS: 3, EVIDENCE: 3, IMPROVEMENTS: 4, POINTS: 3, CAVEATS: 2 };
const LEVELS = ['低', '中', '高'];
const GOAL_TYPES = { pv: 'PVを上げる', like: 'いいねを増やす', other: 'その他の目的' };

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== undefined) return v;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? String(DEFAULTS[key]) : null;
}
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
      case 'login': return handleLogin_(req);
      case 'coach': return handleCoach_(req);
      default:      throw new AppError('BAD_REQUEST', '不明な action です');
    }
  } catch (err) {
    if (err instanceof AppError) return fail_(err.code, err.message);
    console.error((err && err.stack) || err);
    return fail_('SERVER', 'サーバーエラーが発生しました。管理者は GAS の実行ログを確認してください');
  }
}
function doGet() {
  return json_({ ok: true, service: 'drop-coach-ai', time: new Date().toISOString() });
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
    Utilities.sleep(800);
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

/* ============================== 改善案生成 ============================== */
function handleCoach_(req) {
  const t0 = Date.now();
  if (!checkToken_(req.token)) {
    throw new AppError('AUTH', 'ログインの有効期限が切れました。パスワードを再入力してください');
  }
  const apiKey = prop_(AZURE_MODEL.secret);
  if (!apiKey) throw new AppError('CONFIG', 'スクリプトプロパティ ' + AZURE_MODEL.secret + ' が未設定です');

  // 入力の検証・整形（ホワイトリスト方式）
  const goal = sanitizeGoal_(req.goal);
  const target = sanitizePost_(req.target, 'T');
  if (!target) throw new AppError('BAD_REQUEST', '改善対象の投稿がありません');
  const references = sanitizeRefs_(req.references);
  if (!references.length) throw new AppError('BAD_REQUEST', '参考投稿がありません');
  const context = sanitizeContext_(req.context);
  const instructions = sanitizeText_(req.instructions, numProp_('MAX_INSTR'));
  const fewshots = sanitizeShots_(req.fewshots);

  const prompt = loadPrompt_();
  const model = AZURE_MODEL.name;

  const cache = CacheService.getScriptCache();
  const cacheKey = KEY.RESULT + sha256_(JSON.stringify([model, prompt.version, goal, context, target, references, instructions, fewshots]));
  if (!req.force) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const saved = JSON.parse(hit);
      saved.cached = true;
      saved.elapsed_ms = Date.now() - t0;
      return json_(saved);
    }
  }
  if (!adjustDailyQuota_(+1)) throw new AppError('LIMIT', '本日の AI 分析回数の上限に達しました');

  const refIds = references.map(r => r.id);
  const vars = {
    GOAL: goal.label + (goal.note ? '\n目的の詳細: ' + goal.note : ''),
    GOAL_METRIC: goal.type === 'pv' ? 'PV（閲覧数）' : goal.type === 'like' ? 'いいね数' : '自由記述の目的（PV・いいねは参考値）',
    CONTEXT: JSON.stringify(context),
    TARGET: JSON.stringify(target),
    REFERENCES: JSON.stringify(references),
    REF_IDS: refIds.join(', '),
    INSTRUCTIONS: instructions || '（なし）',
    FEW_SHOTS: formatShots_(fewshots) || '（なし）'
  };
  let userText = fillTemplate_(prompt.user, vars);
  // テンプレートに差し込み欄が無い場合も、指示・Few-shot が必ず届くよう末尾に補う
  const tplRaw = prompt.user.replace(/\\/g, '');
  if (instructions && !/\{\{\s*INSTRUCTIONS\s*\}\}/.test(tplRaw)) userText += '\n\n### 利用者からの追加の指示\n' + instructions;
  if (fewshots.length && !/\{\{\s*FEW_SHOTS\s*\}\}/.test(tplRaw)) userText += '\n\n### Few-shot 例\n' + formatShots_(fewshots);

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: userText }
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
    result: normalizeResult_(data, new Set(['T'].concat(refIds)))
  };
  try {
    cache.put(cacheKey, JSON.stringify(payload), Math.min(numProp_('RESULT_CACHE_SEC'), CACHE_MAX_SEC));
  } catch (e) { /* 100KB 超などは無視 */ }
  payload.elapsed_ms = Date.now() - t0;
  return json_(payload);
}

/* ---------- 入力整形 ---------- */
const num_ = v => (isFinite(Number(v)) ? Number(v) : 0);
const str_ = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function sanitizeGoal_(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const type = Object.prototype.hasOwnProperty.call(GOAL_TYPES, g.type) ? g.type : 'pv';
  const note = type === 'other' ? sanitizeText_(g.note, numProp_('MAX_GOAL')) : '';
  if (type === 'other' && !note) throw new AppError('BAD_REQUEST', '「その他の目的」の内容が空です');
  return { type: type, label: GOAL_TYPES[type], note: note };
}
function sanitizePost_(p, id) {
  if (!p || typeof p !== 'object') return null;
  const o = {
    id: id,
    like: num_(p.like), pv: num_(p.pv), like_rate: num_(p.like_rate),
    like_rank: num_(p.like_rank), pv_rank: num_(p.pv_rank),
    date: str_(p.date, 10), hour: str_(p.hour, 2),
    gender: str_(p.gender, 10), age: str_(p.age, 10),
    text_len: num_(p.text_len), text: str_(p.text, numProp_('MAX_TEXT'))
  };
  if (Array.isArray(p.groups)) o.groups = p.groups.filter(g => g === 'like_top' || g === 'pv_top');
  if (p.name) o.name = str_(p.name, 40);
  return o;
}
function sanitizeRefs_(raw) {
  if (!Array.isArray(raw)) return [];
  // ID はサーバー側で R1, R2 … に振り直す（フロントの ID と順序は一致させている）
  return raw.filter(p => p && typeof p === 'object')
    .slice(0, numProp_('MAX_REFS'))
    .map((p, i) => sanitizePost_(p, 'R' + (i + 1)));
}
function sanitizeContext_(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    event: str_(c.event, 60),
    total_posts: num_(c.total_posts),
    avg_like: num_(c.avg_like), avg_pv: num_(c.avg_pv), avg_like_rate: num_(c.avg_like_rate),
    ref_basis: str_(c.ref_basis, 20), ref_top_n: num_(c.ref_top_n),
    ref_pool_size: num_(c.ref_pool_size), ref_pool_filter: str_(c.ref_pool_filter, 120)
  };
}
/** 自由記述：制御文字除去・長さ制限。行頭の # は除去してプロンプトの見出し構造を崩させない */
function sanitizeText_(raw, max) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/^[ \t]*#+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}
function sanitizeShots_(raw) {
  if (!Array.isArray(raw)) return [];
  const max = numProp_('MAX_SHOT_TEXT');
  return raw.filter(s => s && typeof s === 'object')
    .map(s => ({ input: sanitizeText_(s.input, max), output: sanitizeText_(s.output, max) }))
    .filter(s => s.output)
    .slice(0, numProp_('MAX_SHOTS'));
}
function formatShots_(shots) {
  return shots.map((s, i) =>
    '例' + (i + 1) + '\n[入力]\n' + (s.input || '（指定なし）') + '\n[期待する出力]\n' + s.output
  ).join('\n\n');
}

/** AI 出力を画面が想定する形に整える（文字列のみ採用・件数上限・存在しない ID の除去） */
function normalizeResult_(data, validIds) {
  const d = data && typeof data === 'object' ? data : {};
  const text = v => (typeof v === 'string' ? v : '');
  const list = (v, max) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x).slice(0, max) : []);
  const ids = v => [...new Set(list(v, Infinity).filter(id => validIds.has(id)))].slice(0, LIMITS.EVIDENCE);
  const level = v => (LEVELS.indexOf(v) >= 0 ? v : '');
  const obj = v => (v && typeof v === 'object' ? v : {});
  const dg = obj(d.diagnosis), ri = obj(d.reference_insights), rw = obj(d.rewrite);
  return {
    headline: text(d.headline),
    diagnosis: {
      summary: text(dg.summary),
      strengths: list(dg.strengths, LIMITS.STRENGTHS),
      weaknesses: list(dg.weaknesses, LIMITS.WEAKNESSES)
    },
    reference_insights: {
      summary: text(ri.summary),
      traits: list(ri.traits, LIMITS.TRAITS),
      evidence_ids: ids(ri.evidence_ids)
    },
    improvements: (Array.isArray(d.improvements) ? d.improvements : [])
      .filter(a => a && typeof a === 'object' && typeof a.title === 'string' && a.title)
      .slice(0, LIMITS.IMPROVEMENTS)
      .map(a => ({
        title: a.title,
        detail: text(a.detail),
        example: text(a.example),
        impact: level(a.impact),
        effort: level(a.effort),
        evidence_ids: ids(a.evidence_ids)
      })),
    rewrite: { text: text(rw.text), points: list(rw.points, LIMITS.POINTS) },
    caveats: list(d.caveats, LIMITS.CAVEATS)
  };
}

/* ============================ プロンプト ============================ */
/**
 * プロンプトファイル書式：## SYSTEM / ## USER（### も可）
 * USER 内で置換: {{GOAL}} {{GOAL_METRIC}} {{CONTEXT}} {{TARGET}} {{REFERENCES}} {{REF_IDS}} {{INSTRUCTIONS}} {{FEW_SHOTS}}
 * <!-- --> コメントは送信前に除去する。
 */
function loadPrompt_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(KEY.PROMPT);
  if (hit) return JSON.parse(hit);
  const url = normalizePromptUrl_(prop_('PROMPT_URL'));
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    console.error('prompt fetch failed: ' + url, e);
    throw new AppError('CONFIG', 'プロンプトファイルに接続できません。管理者は PROMPT_URL を確認してください');
  }
  const code = res.getResponseCode();
  if (code !== 200) {
    console.error('prompt fetch HTTP ' + code + ': ' + url);
    throw new AppError('CONFIG', 'プロンプトファイルを取得できません（HTTP ' + code + '）。管理者は PROMPT_URL を確認してください');
  }
  const prompt = parsePrompt_(res.getContentText('UTF-8'));
  cache.put(KEY.PROMPT, JSON.stringify(prompt), Math.min(numProp_('PROMPT_CACHE_SEC'), CACHE_MAX_SEC));
  return prompt;
}
function normalizePromptUrl_(url) {
  const u = String(url || '').trim();
  if (!u) throw new AppError('CONFIG', 'スクリプトプロパティ PROMPT_URL が未設定です');
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  return m ? [RAW_GITHUB_BASE, m[1], m[2], m[3]].join('/') : u;
}
function parsePrompt_(rawText) {
  if (/^\s*<(!doctype|html)/i.test(rawText)) {
    throw new AppError('CONFIG', 'プロンプトが HTML で返りました。PROMPT_URL に raw URL を指定してください');
  }
  const text = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const m = text.match(/^#{2,3}[ \t]*SYSTEM[ \t]*\n([\s\S]*?)^#{2,3}[ \t]*USER[ \t]*\n([\s\S]*)$/im);
  if (!m) throw new AppError('CONFIG', 'プロンプトファイルに「## SYSTEM」「## USER」の見出しがありません');
  return { system: m[1].trim(), user: m[2].trim(), version: sha256_(text).slice(0, 10) };
}
function fillTemplate_(tpl, vars) {
  return tpl.replace(/\{\{\s*([\w\\]+?)\s*\}\}/g, (all, k) => {
    const name = k.replace(/\\/g, '');
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all;
  });
}
function clearPromptCache() {
  CacheService.getScriptCache().remove(KEY.PROMPT);
  console.log('プロンプトのキャッシュを削除しました');
}

/* ============================== Azure OpenAI ============================== */
/** 画面の描画と対応する出力スキーマ（HTML 側 renderResult と合わせて変更すること） */
const OUTPUT_SCHEMA = (() => {
  const strArr = { type: 'array', items: { type: 'string' } };
  const level = { type: 'string', enum: LEVELS };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'diagnosis', 'reference_insights', 'improvements', 'rewrite', 'caveats'],
    properties: {
      headline: { type: 'string' },
      diagnosis: {
        type: 'object', additionalProperties: false,
        required: ['summary', 'strengths', 'weaknesses'],
        properties: { summary: { type: 'string' }, strengths: strArr, weaknesses: strArr }
      },
      reference_insights: {
        type: 'object', additionalProperties: false,
        required: ['summary', 'traits', 'evidence_ids'],
        properties: { summary: { type: 'string' }, traits: strArr, evidence_ids: strArr }
      },
      improvements: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['title', 'detail', 'example', 'impact', 'effort', 'evidence_ids'],
          properties: {
            title: { type: 'string' }, detail: { type: 'string' }, example: { type: 'string' },
            impact: level, effort: level, evidence_ids: strArr
          }
        }
      },
      rewrite: {
        type: 'object', additionalProperties: false,
        required: ['text', 'points'],
        properties: { text: { type: 'string' }, points: strArr }
      },
      caveats: strArr
    }
  };
})();

function callAzureOpenAI_(apiKey, messages) {
  const body = {
    messages: messages,
    max_completion_tokens: numProp_('MAX_OUTPUT_TOKENS'),
    response_format: { type: 'json_schema', json_schema: { name: 'drop_coach', strict: true, schema: OUTPUT_SCHEMA } }
  };
  const effort = prop_('REASONING_EFFORT');
  if (effort) body.reasoning_effort = effort;
  let r = postAzure_(apiKey, body);
  if (r.code === 400 && body.reasoning_effort && /reasoning/i.test(r.text)) {
    console.warn('reasoning_effort=' + body.reasoning_effort + ' が拒否されたため外して再送します: ' + r.text);
    delete body.reasoning_effort;
    r = postAzure_(apiKey, body);
  }
  let json;
  try {
    json = JSON.parse(r.text);
  } catch (e) {
    console.error('Azure OpenAI non-JSON', r.code, String(r.text).slice(0, 500));
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
  if (choice.finish_reason === 'length') throw new AppError('AI', '出力が上限で途切れました。MAX_OUTPUT_TOKENS を増やしてください');
  if (json.usage) console.log('usage', JSON.stringify(json.usage));
  try {
    return JSON.parse(msg.content);
  } catch (e) {
    throw new AppError('AI', 'AI の出力が JSON ではありません');
  }
}
function postAzure_(apiKey, body) {
  let res;
  try {
    res = UrlFetchApp.fetch(azureUrl_(), {
      method: 'post', contentType: 'application/json',
      headers: { 'api-key': apiKey }, payload: JSON.stringify(body), muteHttpExceptions: true
    });
  } catch (e) {
    console.error('Azure OpenAI fetch failed', e);
    throw new AppError('AI', 'Azure OpenAI に接続できません。endpoint の設定を確認してください');
  }
  return { code: res.getResponseCode(), text: res.getContentText() };
}

/* ============================== 共通 ============================== */
function adjustDailyQuota_(delta) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) { throw new AppError('BUSY', 'アクセスが集中しています。少し待ってから再実行してください'); }
  try {
    const props = PropertiesService.getScriptProperties();
    const key = KEY.QUOTA + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    const n = Number(props.getProperty(key) || 0);
    if (delta > 0 && n >= numProp_('DAILY_LIMIT')) return false;
    props.setProperty(key, String(Math.max(0, n + delta)));
    if (delta > 0 && n === 0) {
      props.getKeys().filter(k => k.indexOf(KEY.QUOTA) === 0 && k !== key).forEach(k => props.deleteProperty(k));
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
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function fail_(code, message) { return json_({ ok: false, code: code, message: message }); }

/* ============================ 動作確認用 ============================ */
function checkSetup() {
  const url = azureUrl_();
  if (!/^https:\/\/[^\s<>"']+$/.test(url)) console.error('★ AZURE_MODEL.endpoint に HTML 等が混入しています: ' + AZURE_MODEL.endpoint);
  ['APP_PASSWORD', AZURE_MODEL.secret, 'PROMPT_URL'].forEach(k => console.log(k + ': ' + (prop_(k) ? '設定済み' : '★未設定')));
  console.log('MODEL: ' + AZURE_MODEL.name + ' / URL: ' + url);
  console.log('PROMPT 取得先: ' + normalizePromptUrl_(prop_('PROMPT_URL')));
  clearPromptCache();
  const p = loadPrompt_();
  console.log('プロンプト version=' + p.version + ' system=' + p.system.length + '字 user=' + p.user.length + '字');
}
function testCoach() {
  const login = JSON.parse(handleLogin_({ password: prop_('APP_PASSWORD') }).getContent());
  const t0 = Date.now();
  const out = JSON.parse(handleCoach_({
    token: login.token,
    force: true,
    goal: { type: 'pv' },
    context: { event: 'test', total_posts: 22, avg_like: 1.1, avg_pv: 6.8, avg_like_rate: 15.8, ref_basis: 'PV 上位', ref_top_n: 2, ref_pool_size: 21, ref_pool_filter: 'なし' },
    target: { id: 'T', like: 2, pv: 0, like_rate: 0, like_rank: 1, pv_rank: 15, date: '2026-10-21', hour: '18', gender: '無回答', age: '30代', text_len: 44, text: '大同生命大阪本社ビル 1993年竣工・高さ88メートル ひろがりとまっすぐのコラボレーション', name: '大同生命大阪本社ビル' },
    references: [
      { like: 1, pv: 27, like_rate: 3.7, like_rank: 3, pv_rank: 1, date: '2026-10-19', hour: '17', text_len: 110, text: '今では珍しい二重螺旋階段と噴水です！カラフルな照明に照らされる段裏を見て「昭和の歌番組が始まりそう」なんて声も。', name: 'OMM' },
      { like: 1, pv: 20, like_rate: 5, like_rank: 3, pv_rank: 2, date: '2026-10-20', hour: '10', text_len: 45, text: '隈研吾のデザイン ABC本社ビルの大階段の風景です 壁の市松模様は日本の障子がモチーフです', name: 'ABC本社ビル' }
    ],
    instructions: '改善後の本文例を必ず出す',
    fewshots: [{ input: 'ABC本社ビルの大階段です', output: '隈研吾デザインの大階段。壁の市松模様は障子がモチーフ。ツアーで実物をぜひ！' }]
  }).getContent());
  console.log('所要 ' + (Date.now() - t0) + 'ms');
  console.log(JSON.stringify(out, null, 2));
}
