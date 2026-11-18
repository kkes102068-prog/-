/**
 * 北護 iClass 通知小幫手（Google Apps Script）
 *
 *  A（主）：讀 Gmail 裡的 iClass 通知信 → LINE 推播 + 截止日寫入 Google 日曆
 *  B（輔）：用你瀏覽器的 iClass Cookie 定期看 iClass 頁面 → 抓到信件漏掉的新項目／截止日
 *  提醒：日曆跳出提醒 + 到期前 24 小時 LINE 提醒
 *
 * 需要的「指令碼屬性」（專案設定 → 指令碼屬性）：
 *  LINE_CHANNEL_ACCESS_TOKEN  必填
 *  LINE_USER_ID               選填（U 開頭；沒填就改用「廣播」，傳給所有加官方帳號好友的人＝只有你）
 *  ICLASS_COOKIE              選填（B 方案用；沒填 B 就不跑）
 *  其他可選設定見下方 CONFIG 的說明。
 *
 * 第一次使用：填好屬性後，在上方選單選 setup → 執行。
 */

// ======================== 設定 ========================
const CONFIG = {
  ICLASS_BASE_URL: 'https://iclass.ntunhs.edu.tw',
  // B 方案要監看的頁面（登入後才看得到），可用指令碼屬性 ICLASS_PAGES 覆寫，逗號分隔
  ICLASS_PAGES: ['/dashboard'],
  // 找 iClass 通知信的 Gmail 搜尋條件，可用指令碼屬性 GMAIL_QUERY 覆寫
  // in:anywhere 連垃圾郵件匣一起找（Gmail 常把 iClass 的信當垃圾信）
  GMAIL_QUERY: 'in:anywhere -in:trash {from:iclass subject:iclass "iClass"}',
  GMAIL_LOOKBACK: 'newer_than:3d',
  GMAIL_LABEL: 'iClass通知',
  CALENDAR_NAME: 'iClass 作業',
  EVENT_MINUTES: 30,                 // 日曆活動長度（截止前 30 分鐘 ~ 截止）
  CALENDAR_POPUP_MINUTES: [1440, 60], // 日曆跳出提醒：24 小時前、1 小時前
  LINE_REMIND_HOURS: 24,             // 到期前幾小時傳 LINE 提醒
  LINE_MONTHLY_LIMIT: 200,           // LINE 免費方案每月推播上限
  DEFAULT_DUE_TIME: [23, 59],        // 只有日期沒時間時，當作 23:59
};

const TAG = '#iclass-bot';
const TZ = 'Asia/Taipei';

// ======================== 安裝 / 測試 ========================

/** 第一次執行：建立日曆、標籤、排程，並傳一則測試訊息。之後改設定也可以重跑。 */
function setup() {
  const p = props_();
  if (!p.getProperty('LINE_CHANNEL_ACCESS_TOKEN')) {
    throw new Error('請先在「專案設定 → 指令碼屬性」填入 LINE_CHANNEL_ACCESS_TOKEN');
  }
  const cal = getCalendar_();
  getLabel_();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['processMail', 'checkWeb', 'checkUpcoming'].indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('processMail').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('checkWeb').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('checkUpcoming').timeBased().everyHours(1).create();

  const hasCookie = !!p.getProperty('ICLASS_COOKIE');
  pushTexts_(['✅ iClass 通知小幫手設定完成\n' +
    '・通知信檢查：每 5 分鐘\n' +
    '・iClass 網頁檢查（B）：每 15 分鐘' + (hasCookie ? '' : '（尚未填 Cookie，暫停中）') + '\n' +
    '・到期提醒：每小時檢查\n' +
    '・日曆：' + cal.getName()]);
  Logger.log('完成。日曆 ID：%s', cal.getId());
}

/** 只傳一則 LINE 測試訊息 */
function testLine() {
  pushTexts_(['🔔 測試訊息：LINE 連線正常！']);
}

/** 列出最近 30 天找到的 iClass 信件與解析結果（不會傳 LINE、不會寫日曆） */
function debugRecentMails() {
  const q = getQuery_() + ' newer_than:30d';
  Logger.log('搜尋條件：%s', q);
  const threads = GmailApp.search(q, 0, 10);
  if (!threads.length) Logger.log('找不到信。請確認學校 WebMail 有轉寄到這個 Gmail，或調整 GMAIL_QUERY。');
  threads.forEach(function (th) {
    th.getMessages().forEach(function (m) {
      const item = parseMail_(m.getSubject(), m.getPlainBody(), new Date());
      Logger.log('────────\n寄件者：%s\n主旨：%s\n判斷類型：%s\n課程：%s\n截止：%s\n內文前 300 字：%s',
        m.getFrom(), m.getSubject(), item.type, item.course || '(無)',
        item.due ? fmtDate_(item.due.date) + (item.due.guessed ? '（推測）' : '') : '(無)',
        oneLine_(m.getPlainBody()).slice(0, 300));
    });
  });
}

/** 測試 B：抓 iClass 頁面並列出解析到的項目（不會傳 LINE、不會寫日曆） */
function debugWebPage() {
  getPages_().forEach(function (path) {
    const r = fetchIclass_(path);
    Logger.log('==== %s → HTTP %s，%s', path, r.code, r.expired ? '❌ Cookie 無效／過期' : '✅ 已登入');
    if (r.expired) return;
    const items = extractWebItems_(r.html, CONFIG.ICLASS_BASE_URL, new Date());
    Logger.log('找到 %s 個項目', items.length);
    items.slice(0, 40).forEach(function (it) {
      Logger.log('[%s] %s ｜截止：%s｜%s', it.type, it.title,
        it.due ? fmtDate_(it.due.date) + (it.due.guessed ? '（推測）' : '') : '-', it.url);
    });
  });
}

// ======================== A：讀通知信 ========================

function processMail() {
  withLock_(function () {
    const p = props_();
    const processed = JSON.parse(p.getProperty('PROCESSED_IDS') || '[]');
    const seen = {};
    processed.forEach(function (id) { seen[id] = true; });

    const threads = GmailApp.search(getQuery_() + ' ' + CONFIG.GMAIL_LOOKBACK, 0, 50);
    const label = getLabel_();
    let msgs = [];
    threads.forEach(function (th) {
      th.getMessages().forEach(function (m) { if (!seen[m.getId()]) msgs.push(m); });
    });
    if (!msgs.length) return;
    msgs.sort(function (a, b) { return a.getDate() - b.getDate(); });

    const now = new Date();
    const texts = [];
    msgs.forEach(function (m) {
      try {
        const item = parseMail_(m.getSubject(), m.getPlainBody(), now);
        let calNote = '';
        if (item.due && item.due.date > now) {
          const r = upsertDeadline_({
            type: item.type, title: item.title, course: item.course, due: item.due.date,
            key: 'mail:' + m.getId(), url: item.url, source: 'mail', guessed: item.due.guessed,
          });
          calNote = r.status === 'created' ? '📅 已加入日曆' : '📅 日曆已有此項';
        }
        texts.push(formatItem_(item, calNote));
        rememberNotified_(item);
        m.getThread().addLabel(label);
      } catch (e) {
        Logger.log('處理信件失敗 %s：%s', m.getSubject(), e.stack || e);
      }
      processed.push(m.getId());
    });

    p.setProperty('PROCESSED_IDS', JSON.stringify(processed.slice(-300)));
    if (texts.length) pushTexts_(texts);
  });
}

function parseMail_(subject, body, now) {
  body = body || '';
  const type = classify_(subject, body);
  const title = cleanSubject_(subject) || '(無主旨)';
  const course = extractCourse_(subject, body);
  const urlMatch = body.match(/https?:\/\/iclass\.ntunhs\.edu\.tw[^\s"'<>）)\]]*/i);
  return {
    type: type,
    title: title,
    course: course,
    due: pickDeadline_(subject + '\n' + body, type, now),
    url: urlMatch ? urlMatch[0] : '',
    snippet: oneLine_(body).slice(0, 120),
  };
}

// ======================== B：用 Cookie 看 iClass 網頁 ========================

function checkWeb() {
  const p = props_();
  if (!p.getProperty('ICLASS_COOKIE')) return; // 沒填 Cookie 就不跑
  withLock_(function () {
    const cookieHash = hash_(p.getProperty('ICLASS_COOKIE'));
    const now = new Date();
    let items = [];
    for (const path of getPages_()) {
      const r = fetchIclass_(path);
      if (r.expired) {
        if (p.getProperty('COOKIE_ALERTED') !== cookieHash) {
          pushTexts_(['⚠️ iClass Cookie 已失效（HTTP ' + r.code + '）\n' +
            '網頁監看（B）暫停中，通知信（A）照常運作。\n' +
            '有空時請重新登入 iClass，複製新的 Cookie 貼到指令碼屬性 ICLASS_COOKIE。']);
          p.setProperty('COOKIE_ALERTED', cookieHash);
        }
        return;
      }
      items = items.concat(extractWebItems_(r.html, CONFIG.ICLASS_BASE_URL, now));
    }
    p.deleteProperty('COOKIE_ALERTED');

    const seenList = JSON.parse(p.getProperty('WEB_SEEN') || 'null');
    const firstRun = seenList === null;
    const seen = {};
    (seenList || []).forEach(function (h) { seen[h] = true; });

    const texts = [];
    const newHashes = [];
    items.forEach(function (it) {
      const h = hash_(it.url + '|' + it.title);
      const isNew = !seen[h];
      if (isNew) { newHashes.push(h); seen[h] = true; }

      let r = null;
      if (it.due && it.due.date > now) {
        r = upsertDeadline_({
          type: it.type, title: it.title, course: '', due: it.due.date,
          key: 'web:' + h, url: it.url, source: 'web', guessed: it.due.guessed,
        });
      }
      if (firstRun) return;
      if (r && r.status === 'updated') {
        texts.push('🔄 截止時間更新\n' + it.title + '\n⏰ ' + fmtDate_(it.due.date) + '\n🔗 ' + it.url);
      } else if (isNew && !wasRecentlyNotified_(it.title)) {
        const calNote = r ? (r.status === 'created' ? '📅 已加入日曆' : '📅 日曆已有此項') : '';
        texts.push(formatItem_({ type: it.type, title: it.title, course: '', due: it.due, url: it.url }, calNote, '（網頁）'));
        rememberNotified_(it);
      }
    });

    const all = (seenList || []).concat(newHashes).slice(-600);
    p.setProperty('WEB_SEEN', JSON.stringify(all));
    if (firstRun) {
      pushTexts_(['🌐 iClass 網頁監看（B）已連線，記下目前 ' + items.length + ' 個項目，之後有新的才通知。']);
    } else if (texts.length) {
      pushTexts_(texts);
    }
  });
}

function fetchIclass_(path) {
  let cookie = (props_().getProperty('ICLASS_COOKIE') || '').trim();
  if (cookie && cookie.indexOf('=') < 0) cookie = 'PHPSESSID=' + cookie;
  const url = /^https?:/.test(path) ? path : CONFIG.ICLASS_BASE_URL + path;
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    followRedirects: false,
    muteHttpExceptions: true,
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      'Accept-Language': 'zh-TW,zh;q=0.9',
    },
  });
  const code = res.getResponseCode();
  const html = code === 200 ? res.getContentText('UTF-8') : '';
  const expired = code !== 200 || isLoginPage_(html);
  return { code: code, html: html, expired: expired };
}

function isLoginPage_(html) {
  return /id=['"]login_form['"]/.test(html) && !/user\.logout/.test(html);
}

// ======================== 到期提醒 ========================

function checkUpcoming() {
  withLock_(function () {
    const p = props_();
    const now = new Date();
    const until = new Date(now.getTime() + CONFIG.LINE_REMIND_HOURS * 3600e3);
    const lines = [];
    ourEvents_(getCalendar_(), now, until).forEach(function (ev) {
      if (/^✅/.test(ev.getTitle())) return; // 標題前加 ✅ 代表已完成，不再提醒
      const k = 'REM_' + hash_(ev.getId());
      if (p.getProperty(k)) return;
      const due = ev.getEndTime();
      const hrs = Math.max(0, Math.round((due - now) / 3600e3));
      lines.push('・' + ev.getTitle() + '\n  ⏰ ' + fmtDate_(due) + '（剩約 ' + hrs + ' 小時）');
      p.setProperty(k, String(due.getTime()));
    });
    if (lines.length) {
      pushTexts_(['⏰ 以下項目 ' + CONFIG.LINE_REMIND_HOURS + ' 小時內到期：\n\n' + lines.join('\n\n') +
        '\n\n（完成後可在日曆把標題前加上 ✅，就不會再提醒）']);
    }
    // 清掉一週前的提醒紀錄
    const all = p.getProperties();
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('REM_') === 0 && +all[k] < now.getTime() - 7 * 86400e3) p.deleteProperty(k);
    });
  });
}

// ======================== Google 日曆 ========================

function getCalendar_() {
  const p = props_();
  const id = p.getProperty('CALENDAR_ID');
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    const found = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
    cal = found.length ? found[0] : CalendarApp.createCalendar(CONFIG.CALENDAR_NAME, { color: CalendarApp.Color.RED });
    p.setProperty('CALENDAR_ID', cal.getId());
  }
  return cal;
}

function ourEvents_(cal, from, to) {
  return cal.getEvents(from, to).filter(function (e) {
    return (e.getDescription() || '').indexOf(TAG) >= 0;
  });
}

/**
 * 新增或合併截止日活動。回傳 {status: 'created'|'exists'|'updated'}
 * 合併規則：同一個 key，或「核心標題」互相包含（且類型相同、截止日相差 14 天內）視為同一項。
 * web 來源的時間比較精確，會覆蓋 mail 推測的時間。
 */
function upsertDeadline_(o) {
  const cal = getCalendar_();
  const now = new Date();
  const core = coreTitle_(o.title);
  const events = ourEvents_(cal, new Date(now.getTime() - 2 * 86400e3), new Date(now.getTime() + 200 * 86400e3));

  let match = null;
  for (const ev of events) {
    const d = ev.getDescription() || '';
    if (d.indexOf('key:' + o.key + '\n') >= 0) { match = ev; break; }
  }
  if (!match && core.length >= 2) {
    for (const ev of events) {
      const d = ev.getDescription() || '';
      const evCore = (d.match(/^core:(.*)$/m) || [])[1] || '';
      const evType = (d.match(/^type:(.*)$/m) || [])[1] || '';
      const evCourse = (d.match(/^course:(.*)$/m) || [])[1] || '';
      if (evType !== o.type) continue;
      if (o.course && evCourse && normalize_(o.course) !== normalize_(evCourse)) continue;
      if (Math.abs(ev.getEndTime() - o.due) > 14 * 86400e3) continue;
      if (evCore.length >= 2 && (evCore.indexOf(core) >= 0 || core.indexOf(evCore) >= 0)) { match = ev; break; }
    }
  }

  const start = new Date(o.due.getTime() - CONFIG.EVENT_MINUTES * 60e3);
  if (match) {
    const d = match.getDescription() || '';
    if (d.indexOf('key:' + o.key + '\n') < 0) match.setDescription(d + 'key:' + o.key + '\n');
    const precise = o.source === 'web' && !o.guessed;
    const wasGuess = /^guessed:true$/m.test(d);
    if (Math.abs(match.getEndTime() - o.due) > 60e3 && (precise || wasGuess)) {
      match.setTime(start, o.due);
      match.setDescription(match.getDescription().replace(/^guessed:true$/m, 'guessed:false'));
      return { status: 'updated', event: match };
    }
    return { status: 'exists', event: match };
  }

  const title = typeEmoji_(o.type) + '[' + o.type + '] ' + (o.course ? o.course + '｜' : '') + o.title +
    (o.guessed ? '（截止日推測）' : '');
  const desc = [
    TAG,
    '來源：' + (o.source === 'web' ? 'iClass 網頁' : 'iClass 通知信'),
    o.url ? '連結：' + o.url : '',
    '完成後可在標題前加 ✅ 停止 LINE 提醒',
    '',
    'type:' + o.type,
    'core:' + core,
    'course:' + (o.course || ''),
    'guessed:' + (o.guessed ? 'true' : 'false'),
    'key:' + o.key,
    '',
  ].join('\n');
  const ev = cal.createEvent(title, start, o.due, { description: desc });
  ev.removeAllReminders();
  CONFIG.CALENDAR_POPUP_MINUTES.forEach(function (min) { ev.addPopupReminder(min); });
  return { status: 'created', event: ev };
}

// ======================== LINE ========================

/** 把多段文字合併成最少的推播次數（每次最多 5 個對話框，只算 1 則額度） */
function pushTexts_(texts) {
  const p = props_();
  const token = p.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  const to = p.getProperty('LINE_USER_ID');
  if (!token) throw new Error('缺少 LINE_CHANNEL_ACCESS_TOKEN');
  // 有 User ID 用 push；沒有就用 broadcast（官方帳號只有你一個好友時效果一樣）
  const endpoint = 'https://api.line.me/v2/bot/message/' + (to ? 'push' : 'broadcast');

  const bubbles = packTexts_(texts, 4800);
  for (let i = 0; i < bubbles.length; i += 5) {
    const monthKey = 'LINE_COUNT_' + Utilities.formatDate(new Date(), TZ, 'yyyyMM');
    const used = +(p.getProperty(monthKey) || 0);
    if (used >= CONFIG.LINE_MONTHLY_LIMIT) {
      Logger.log('本月 LINE 額度已用完（%s），略過：%s', used, bubbles.slice(i, i + 5).join(' / '));
      return;
    }
    const body = { messages: bubbles.slice(i, i + 5).map(function (t) { return { type: 'text', text: t }; }) };
    if (to) body.to = to;
    const res = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('LINE 推播失敗 HTTP ' + res.getResponseCode() + '：' + res.getContentText());
    }
    p.setProperty(monthKey, String(used + 1));
  }
}

// ======================== 小工具（GAS） ========================

function props_() { return PropertiesService.getScriptProperties(); }

function getQuery_() { return props_().getProperty('GMAIL_QUERY') || CONFIG.GMAIL_QUERY; }

function getPages_() {
  const s = props_().getProperty('ICLASS_PAGES');
  return s ? s.split(',').map(function (x) { return x.trim(); }).filter(String) : CONFIG.ICLASS_PAGES;
}

function getLabel_() {
  return GmailApp.getUserLabelByName(CONFIG.GMAIL_LABEL) || GmailApp.createLabel(CONFIG.GMAIL_LABEL);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) { Logger.log('另一個排程正在執行，略過這次'); return; }
  try { fn(); } finally { lock.releaseLock(); }
}

function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 12);
}

/** 記住最近 A 通知過的標題，避免 B 再通知一次同一件事 */
function rememberNotified_(item) {
  const p = props_();
  const list = JSON.parse(p.getProperty('RECENT_NOTIFIED') || '[]');
  list.push([coreTitle_(item.title), Date.now()]);
  const cutoff = Date.now() - 7 * 86400e3;
  p.setProperty('RECENT_NOTIFIED', JSON.stringify(list.filter(function (x) { return x[1] > cutoff; }).slice(-100)));
}

function wasRecentlyNotified_(title) {
  const core = coreTitle_(title);
  if (core.length < 2) return false;
  const list = JSON.parse(props_().getProperty('RECENT_NOTIFIED') || '[]');
  return list.some(function (x) { return x[0].length >= 2 && (x[0].indexOf(core) >= 0 || core.indexOf(x[0]) >= 0); });
}

// ======================== 純文字處理（不依賴 GAS，可在 Node 測試） ========================

const WEEK_ = ['日', '一', '二', '三', '四', '五', '六'];

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function fmtDate_(d) {
  return pad2_(d.getMonth() + 1) + '/' + pad2_(d.getDate()) + '(' + WEEK_[d.getDay()] + ') ' +
    pad2_(d.getHours()) + ':' + pad2_(d.getMinutes());
}

function oneLine_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function normalize_(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

const TYPE_RULES_ = [
  ['測驗', /測驗|考試|小考|期中考|期末考|quiz|exam/i],
  ['作業', /作業|報告繳交|homework|assignment/i],
  ['問卷', /問卷|questionnaire|survey/i],
  ['公告', /公告|bulletin|announcement/i],
  ['教材', /教材|講義|上傳|影片|檔案|課程內容|material|document|video/i],
  ['討論', /討論|回覆|留言|forum|discussion/i],
  ['成績', /成績|grade|score/i],
];

function classify_(subject, body) {
  const sources = [String(subject || ''), String(body || '').slice(0, 400)];
  for (const src of sources) {
    for (const rule of TYPE_RULES_) if (rule[1].test(src)) return rule[0];
  }
  return '通知';
}

function typeEmoji_(type) {
  return { 測驗: '🧪', 作業: '📝', 問卷: '📋', 公告: '📢', 教材: '📚', 討論: '💬', 成績: '💯' }[type] || '🔔';
}

function cleanSubject_(s) {
  return String(s || '')
    .replace(/^(\s*(re|fw|fwd|轉寄|回覆)\s*[:：])+/i, '')
    .replace(/[\[【〔(（][^\]】〕)）]*(iclass|tronclass|北護)[^\]】〕)）]*[\]】〕)）]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOISE_RE_ = /新的|新增|新作業|新測驗|新公告|新教材|新問卷|即將截止|即將到期|截止提醒|已發布|已發佈|已上傳|發布了|發佈了|通知|提醒|您有|有一|iclass|北護大|互動教學系統/gi;

function coreTitle_(s) {
  return normalize_(cleanSubject_(s).replace(NOISE_RE_, ''));
}

function extractCourse_(subject, body) {
  const m = String(body || '').match(/課程(?:名稱)?\s*[:：]\s*([^\n\r]{2,40})/);
  if (m) return m[1].trim();
  const b = String(subject || '').match(/[\[【]([^\]】]{2,30})[\]】]/g) || [];
  for (const x of b) {
    const inner = x.slice(1, -1);
    if (!/iclass|tronclass|北護|通知|公告|作業|測驗/i.test(inner)) return inner.trim();
  }
  return '';
}

const MONTHS_ = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const TIME_RE_ = /^[T\s]*(?:[（(]\s*(?:週|星期)?[一二三四五六日天]\s*[)）])?\s*(?:(上午|下午|中午|晚上|凌晨|AM|PM)\s*)?(\d{1,2})\s*(?:[:：]|時)\s*(\d{2})(?:\s*[:：]\s*\d{2})?(?:\s*分)?(?:\s*(AM|PM|a\.m\.|p\.m\.))?/i;

/** 找出文字中所有日期（可含時間）。支援 2026/11/20 23:59、115-11-20、2026年11月20日 下午11:59、Nov 20, 2026、11/20 23:59 */
function parseDates_(text, now) {
  text = String(text || '');
  now = now || new Date();
  const out = [];
  const spans = [];

  function add(y, mo, d, idx, end, needTime) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return;
    if (spans.some(function (s) { return idx < s[1] && end > s[0]; })) return;
    const tm = text.slice(end, end + 40).match(TIME_RE_);
    let h = CONFIG.DEFAULT_DUE_TIME[0], mi = CONFIG.DEFAULT_DUE_TIME[1], hasTime = false;
    if (tm) {
      h = +tm[2]; mi = +tm[3]; hasTime = true;
      const ap = (tm[1] || tm[4] || '').toLowerCase();
      if (/下午|晚上|pm|p\.m\./.test(ap) && h < 12) h += 12;
      if (/上午|凌晨|am|a\.m\./.test(ap) && h === 12) h = 0;
      if (h > 23 || mi > 59) return;
    } else if (needTime) {
      return;
    }
    if (y === null) {
      y = now.getFullYear();
      if (new Date(y, mo - 1, d) < new Date(now.getTime() - 180 * 86400e3)) y += 1;
    }
    const date = new Date(y, mo - 1, d, h, mi, 0);
    if (date.getMonth() !== mo - 1) return; // 2/30 之類
    spans.push([idx, end]);
    out.push({ date: date, index: idx, hasTime: hasTime });
  }

  for (const m of text.matchAll(/(\d{3,4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*日?/g)) {
    let y = +m[1];
    if (y < 1000) y += 1911; // 民國年
    if (y < 2000 || y > 2100) continue;
    add(y, +m[2], +m[3], m.index, m.index + m[0].length, false);
  }
  for (const m of text.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/gi)) {
    add(+m[3], MONTHS_[m[1].toLowerCase()], +m[2], m.index, m.index + m[0].length, false);
  }
  for (const m of text.matchAll(/(?<![\d\/.\-])(\d{1,2})\/(\d{1,2})(?![\d\/])/g)) {
    add(null, +m[1], +m[2], m.index, m.index + m[0].length, true); // 沒年份的一定要有時間才算
  }
  out.sort(function (a, b) { return a.index - b.index; });
  return out;
}

function lastPos_(s, re) {
  const g = new RegExp(re.source, 'gi');
  let p = -1, m;
  while ((m = g.exec(s))) p = m.index;
  return p;
}

const DEADLINE_KW_ = /截止|到期|結束|期限|繳交|關閉|due|deadline|close|end|until/;
const START_KW_ = /開始|開放|起始|發布|發佈|公告日期|建立|寄送|寄件|start|open|post|publish|sent/;
const RANGE_KW_ = /(~|～|至|－|—|–|\s-)\s*$/;

/** 從文字中挑出截止時間。回傳 {date, guessed} 或 null */
function pickDeadline_(text, type, now) {
  text = String(text || '');
  now = now || new Date();
  const ds = parseDates_(text, now);
  ds.forEach(function (d) {
    const before = text.slice(Math.max(0, d.index - 30), d.index);
    const dl = lastPos_(before, DEADLINE_KW_), st = lastPos_(before, START_KW_);
    const range = RANGE_KW_.test(before);
    d.isDeadline = range || (dl >= 0 && dl > st);
    d.isStart = !d.isDeadline && st >= 0;
  });
  const latest = function (arr) { return arr.reduce(function (a, b) { return b.date > a.date ? b : a; }); };
  const dl = ds.filter(function (d) { return d.isDeadline; });
  if (dl.length) return { date: latest(dl).date, guessed: false };
  if (['作業', '測驗', '問卷'].indexOf(type) >= 0) {
    const c = ds.filter(function (d) { return !d.isStart && d.date > now; });
    if (c.length) return { date: latest(c).date, guessed: true };
  }
  return null;
}

function htmlToText_(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|td|th|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
    .replace(/&amp;/g, '&')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const WEB_LINK_RE_ = /\/(course|homework|exam|quiz|bulletin|board|forum|material|doc|media|questionnaire|survey|announcement|activity)/i;
const WEB_SKIP_RE_ = /^(javascript:|mailto:|#)|logout|changeLocale|\/ajax\/|\/index\/login|\/sys\/|\/res\//i;

/** 從 iClass 頁面 HTML 找出課程相關連結（作業、公告、教材…）與其附近的截止日 */
function extractWebItems_(html, base, now) {
  html = String(html || '');
  const anchors = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].replace(/&amp;/g, '&').trim();
    if (WEB_SKIP_RE_.test(href) || !WEB_LINK_RE_.test(href)) continue;
    const title = oneLine_(htmlToText_(m[2]));
    if (title.length < 2) continue;
    anchors.push({ index: m.index, end: m.index + m[0].length, href: href, title: title });
  }
  const items = [];
  const seen = {};
  anchors.forEach(function (a, i) {
    const url = /^https?:/i.test(a.href) ? a.href : base.replace(/\/$/, '') + (a.href[0] === '/' ? '' : '/') + a.href;
    const key = url + '|' + a.title;
    if (seen[key]) return;
    seen[key] = true;
    const from = Math.max(i > 0 ? anchors[i - 1].end : 0, a.index - 300);
    const to = Math.min(i + 1 < anchors.length ? anchors[i + 1].index : html.length, a.end + 800);
    const ctx = htmlToText_(html.slice(from, to));
    const type = classify_(a.title, a.href + ' ' + ctx);
    items.push({ title: a.title, url: url, type: type, due: pickDeadline_(ctx, type, now) });
  });
  return items;
}

function formatItem_(item, calNote, sourceTag) {
  const lines = [typeEmoji_(item.type) + '【' + item.type + '】' + (item.course ? item.course : '') + (sourceTag || '')];
  lines.push(item.title);
  if (item.due) lines.push('⏰ 截止：' + fmtDate_(item.due.date) + (item.due.guessed ? '（推測，請確認）' : ''));
  if (calNote) lines.push(calNote);
  if (item.snippet && !item.due && ['公告', '通知', '討論'].indexOf(item.type) >= 0) lines.push('📄 ' + item.snippet);
  if (item.url) lines.push('🔗 ' + item.url);
  return lines.join('\n');
}

/** 把多段文字合併成盡量少的對話框，每個不超過 maxLen 字 */
function packTexts_(texts, maxLen) {
  const sep = '\n\n────────\n\n';
  const out = [];
  let cur = '';
  texts.forEach(function (t) {
    t = String(t).slice(0, maxLen);
    if (!cur) cur = t;
    else if ((cur + sep + t).length <= maxLen) cur += sep + t;
    else { out.push(cur); cur = t; }
  });
  if (cur) out.push(cur);
  return out;
}

// 讓 Node 測試可以載入（GAS 不會執行這段）
if (typeof module !== 'undefined') {
  module.exports = {
    parseDates_, pickDeadline_, classify_, cleanSubject_, coreTitle_, extractCourse_,
    extractWebItems_, htmlToText_, packTexts_, fmtDate_, formatItem_, parseMail_: (s, b, n) => parseMail_(s, b, n),
  };
}
