/* =====================================================================
 *  config.js — TOP ダッシュボード設定ファイル
 *  ---------------------------------------------------------------------
 *  index.html の KPI 達成度ドーナツで使用する「目標値」と「カラー」を
 *  ここで一元管理します。数値を変更する場合は、このファイルのみを
 *  編集してください（index.html 本体の編集は不要です）。
 *
 *  カラー方針（全ダッシュボード共通）:
 *    流入系   … グレー  --gray  #64748b
 *    会員登録 … 青      --attr  #3f66b3
 *    スタンプ … 緑      --acq   #2f8f66
 *    投稿     … 紫      --rich  #7a58b0
 * ===================================================================== */
const DASHBOARD_CONFIG = {
  /* ---- KPI 目標値（達成度＝実数 ÷ 目標値 × 100）---- */
  targets: {
    access: 3400,   // 全アクセス数（ユニークユーザー数）
    signup: 500,    // アカウント登録数（データ未連携）
    stamp:  300,     // スタンプ獲得者数（ユニーク）
    poster: 100,     // 投稿者数
    survey: 100      // アンケート回答者数（データ未連携）
  },

  /* ---- カラースロット（dashboard-common.css のトークンと一致）----
   *   access / survey = 流入・中立 → gray（グレー）
   *   signup          = 会員登録   → attr（青）
   *   stamp           = スタンプ   → acq （緑）
   *   poster          = 投稿       → rich（紫）
   */
  colors: {
    access: "#64748b",   // グレー（流入系）
    signup: "#3f66b3",   // 青（会員登録）
    stamp:  "#2f8f66",   // 緑（スタンプ）
    poster: "#7a58b0",   // 紫（投稿）
    survey: "#64748b"    // グレー（中立・未連携）
  },

  /* ---- 地図（CARTO ベースマップ）設定 ----
   *   スタンプマップ / 投稿マップ（details_stamp.html・details_drop.html）で共通利用。
   *   API キーを差し替える場合は、この cartoApiKey のみを編集してください
   *   （各 HTML 本体の編集は不要です）。
   */
  map: {
    cartoApiKey: "cb1_3mnu_1_9357092faaed80e557d7e696",
    tile: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }
};
