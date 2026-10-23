/**
 * DROP Coach — 実行ログ記録用 Google Apps Script（改善案生成用とは別プロジェクト / Web アプリ）
 * ------------------------------------------------------------
 * drop_coach.html から直接呼ばれ、Google スプレッドシートに 1 行追記する。GAS_LOG をベースに列を変更。
 *
 * ■ アクション（POST / Content-Type: text/plain / body は JSON 文字列）
 *   { "action":"login", "name":"...", "password":"..." } → { ok:true, token, expires_in }
 *   { "action":"log", "token":"...", "goal":"...", "goal_note":"...", "target_id":"...",
 *     "ref_count":5, "instructions":"...", "fewshot_count":1 } → { ok:true }
 *
 * ■ 記録する列（シートが空なら見出し行を自動作成）
 *   タイムスタンプ / Name / 目的 / 目的（自由記述） / 対象投稿ID / 参考投稿数 / 追加指示 / Few-shot件数
 *
 * ■ スクリプトプロパティ
 *   必須  APP_PASSWORD（改善案生成用 GAS と同じ値）
 *   任意  LOG_SHEET_ID / LOG_SHEET_NAME (coach_log) / TOKEN_TTL_SEC (21600) / MAX_FAILS (30) / MAX_LOGS_PER_TOKEN (300)
 *
 * ■ デプロイ
 *   記録先スプレッドシートの「拡張機能 → Apps Script」で作成 → setupTest() を 1 回実行して権限承認
 *   → ウェブアプリとしてデプロイ（実行: 自分 / アクセス: 全員）→ /exec URL を HTML の CONFIG.LOG_URL に設定。
 */
const LOG_HEADER = ['タイムスタンプ', 'Name', '目的', '目的（自由記述）', '対象投稿ID', '参考投稿数', '追加指示', 'Few-shot件数'];
const DEFAULTS = { LOG_SHEET_NAME: 'coach_log', TOKEN_TTL_SEC: 21600, MAX_FAILS: 30, MAX_LOGS_PER_TOKEN: 300 };
const CACHE_MAX_SEC = 21600;
const FAIL_WINDOW_SEC = 900;
const MAX_LEN = { NAME: 40, GOAL: 20, NOTE: 200, ID: 64, TEXT: 400 };
const KEY = { FAIL: 'coachlog_auth_fail', TOKEN: 'coachlogtok_' };

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== undefined && v !== '') return v;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? String(DEFAULTS[key]) : null;
}
function numProp_(key) {
  const n = Number(prop_(key));
  return isFinite(n) && n > 0 ? n : Number(DEFAULTS[key]);
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
      case 'log':   return handleLog_(req);
      default:      throw new AppError('BAD_REQUEST', '不明な action です');
    }
  } catch (err) {
    if (err instanceof AppError) return json_({ ok: false, code: err.code, message: err.message });
    console.error((err && err.stack) || err);
    return json_({ ok: false, code: 'SERVER', message: 'ログ記録でサーバーエラーが発生しました' });
  }
}
function doGet() {
  return json_({ ok: true, service: 'drop-coach-log', time: new Date().toISOString() });
}

/* ============================ ログイン ============================ */
function handleLogin_(req) {
  const expected = prop_('APP_PASSWORD');
  if (!expected) throw new AppError('CONFIG', 'ログ記録用 GAS の APP_PASSWORD が未設定です');
  const name = clean_(req.name, MAX_LEN.NAME).replace(/\s+/g, ' ');
  if (!name) throw new AppError('BAD_REQUEST', 'Name を入力してください');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(KEY.FAIL) || 0);
  if (fails >= numProp_('MAX_FAILS')) {
    throw new AppError('LOCKED', 'パスワードの失敗回数が上限に達しました。15 分ほど待ってから再試行してください');
  }
  const pw = String(req.password || '');
  if (!pw || !safeEqual_(sha256_(pw), sha256_(expected))) {
    cache.put(KEY.FAIL, String(fails + 1), FAIL_WINDOW_SEC);
    Utilities.sleep(800);
    throw new AppError('AUTH', 'パスワードが違います');
  }
  cache.remove(KEY.FAIL);
  const ttl = Math.min(numProp_('TOKEN_TTL_SEC'), CACHE_MAX_SEC);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put(KEY.TOKEN + sha256_(token), JSON.stringify({ name: name, n: 0, exp: Date.now() + ttl * 1000 }), ttl);
  return json_({ ok: true, token: token, expires_in: ttl });
}

/* ============================== 記録 ============================== */
function handleLog_(req) {
  const cache = CacheService.getScriptCache();
  const key = KEY.TOKEN + sha256_(String(req.token || ''));
  let session = null;
  try { session = JSON.parse(cache.get(key) || 'null'); } catch (e) {}
  if (!req.token || !session || !session.name) {
    throw new AppError('AUTH', 'ログ記録の認証期限が切れました。再ログインしてください');
  }
  if (session.n >= numProp_('MAX_LOGS_PER_TOKEN')) {
    throw new AppError('BAD_REQUEST', 'このログインでの記録回数が上限に達しました。再ログインしてください');
  }
  const int = v => (isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  appendRow_([
    new Date(),
    session.name,
    clean_(req.goal, MAX_LEN.GOAL),
    clean_(req.goal_note, MAX_LEN.NOTE),
    clean_(req.target_id, MAX_LEN.ID),
    int(req.ref_count),
    clean_(req.instructions, MAX_LEN.TEXT),
    int(req.fewshot_count)
  ]);
  session.n = (session.n || 0) + 1;
  const rest = Math.floor((session.exp - Date.now()) / 1000);
  if (rest > 1) cache.put(key, JSON.stringify(session), Math.min(rest, CACHE_MAX_SEC));
  return json_({ ok: true });
}
function appendRow_(row) {
  // 先頭が = + - @ の文字列は数式として解釈されないよう ' を付ける
  const safe = v => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { throw new AppError('BUSY', 'ログ記録が混み合っています'); }
  try {
    const sh = getSheet_();
    if (sh.getLastRow() === 0) {
      sh.appendRow(LOG_HEADER);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, LOG_HEADER.length).setFontWeight('bold');
      sh.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
    }
    sh.appendRow(row.map(safe));
  } finally {
    lock.releaseLock();
  }
}
function getSheet_() {
  const id = prop_('LOG_SHEET_ID');
  let ss;
  try {
    ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    console.error('open spreadsheet failed', e);
    throw new AppError('CONFIG', 'スプレッドシートを開けません（LOG_SHEET_ID を確認してください）');
  }
  if (!ss) throw new AppError('CONFIG', 'LOG_SHEET_ID が未設定です（スプレッドシートに紐づかないプロジェクトでは必須）');
  const name = prop_('LOG_SHEET_NAME');
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/* ============================== 共通 ============================== */
function clean_(v, n) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, n);
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

/* ============================ 動作確認用 ============================ */
function setupTest() {
  console.log('APP_PASSWORD: ' + (prop_('APP_PASSWORD') ? '設定済み' : '★未設定'));
  const sh = getSheet_();
  console.log('記録先: ' + sh.getParent().getName() + ' / シート ' + sh.getName());
  const login = JSON.parse(handleLogin_({ name: 'setupTest', password: prop_('APP_PASSWORD') }).getContent());
  const out = JSON.parse(handleLog_({ token: login.token, goal: 'PVを上げる', target_id: '（書き込み確認）', ref_count: 0, instructions: '', fewshot_count: 0 }).getContent());
  console.log('結果: ' + JSON.stringify(out) + ' / 最終行 ' + sh.getLastRow());
}
