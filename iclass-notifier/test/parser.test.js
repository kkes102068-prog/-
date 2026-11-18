// 執行：TZ=Asia/Taipei node iclass-notifier/test/parser.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const m = new Module('Code.gs');
m._compile(src, 'Code.gs');
const L = m.exports;

const now = new Date(2026, 10, 18, 12, 0); // 2026/11/18 12:00
const fmt = (d) => d && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
let n = 0;
function t(name, fn) { fn(); n++; console.log('✓', name); }

t('西元年 + 截止關鍵字', () => {
  const r = L.pickDeadline_('作業名稱：期中報告\n開始時間：2026/11/01 08:00\n截止時間：2026/11/20 23:59', '作業', now);
  assert.equal(fmt(r.date), '2026-11-20 23:59'); assert.equal(r.guessed, false);
});
t('民國年', () => {
  const r = L.pickDeadline_('繳交期限：115-11-25 17:00', '作業', now);
  assert.equal(fmt(r.date), '2026-11-25 17:00');
});
t('中文年月日 + 下午', () => {
  const r = L.pickDeadline_('請於 2026年11月21日（六）下午 5:30 前繳交，截止', '作業', now);
  assert.equal(fmt(r.date), '2026-11-21 17:30'); assert.equal(r.guessed, true);
});
t('區間 ~ 取結束', () => {
  const r = L.pickDeadline_('作答時間 2026-11-19 10:00 ~ 2026-11-19 12:00', '測驗', now);
  assert.equal(fmt(r.date), '2026-11-19 12:00'); assert.equal(r.guessed, false);
});
t('英文日期', () => {
  const r = L.pickDeadline_('Due: Nov 22, 2026 11:59 PM', '作業', now);
  assert.equal(fmt(r.date), '2026-11-22 23:59');
});
t('無年份需要時間，跨年推算', () => {
  const r = L.pickDeadline_('截止 1/5 23:00', '作業', now);
  assert.equal(fmt(r.date), '2027-1-5 23:00');
  assert.equal(L.parseDates_('比例 1/2 的同學', now).length, 0);
});
t('只有日期沒時間 → 23:59', () => {
  assert.equal(fmt(L.pickDeadline_('截止日期：2026/12/01', '作業', now).date), '2026-12-1 23:59');
});
t('公告只有發布日期 → 不當截止', () => {
  assert.equal(L.pickDeadline_('公告日期：2026/11/18 09:00 期末考範圍公布', '公告', now), null);
});
t('分類', () => {
  assert.equal(L.classify_('【北護大iClass】新作業：期中報告', ''), '作業');
  assert.equal(L.classify_('課程公告：停課通知', ''), '公告');
  assert.equal(L.classify_('線上測驗開放', ''), '測驗');
  assert.equal(L.classify_('老師上傳了新教材', ''), '教材');
  assert.equal(L.classify_('哈囉', '沒有關鍵字'), '通知');
});
t('主旨清理與核心標題', () => {
  assert.equal(L.cleanSubject_('Fwd: 【北護大iClass互動教學系統】新作業：期中報告'), '新作業：期中報告');
  assert.equal(L.coreTitle_('【iClass】新作業：期中報告'), L.coreTitle_('作業即將截止提醒：期中報告').replace('作業', ''));
});
t('課程名稱', () => {
  assert.equal(L.extractCourse_('x', '課程名稱：基礎護理學\n內容…'), '基礎護理學');
  assert.equal(L.extractCourse_('【iClass】【解剖學】新公告', ''), '解剖學');
});
t('網頁項目擷取', () => {
  const html = `<a href="/user/logout">登出</a>
  <table><tr><td><a href="/course/123">解剖學</a></td><td><a href="/course/homework/456">期中報告</a></td><td>截止 2026-11-30 23:59</td></tr>
  <tr><td><a href="/course/bulletin/789">停課公告</a></td><td>2026-11-17</td></tr></table>`;
  const items = L.extractWebItems_(html, 'https://iclass.ntunhs.edu.tw', now);
  const hw = items.find((i) => i.title === '期中報告');
  assert.equal(hw.type, '作業'); assert.equal(fmt(hw.due.date), '2026-11-30 23:59');
  assert.equal(hw.url, 'https://iclass.ntunhs.edu.tw/course/homework/456');
  assert.equal(items.find((i) => i.title === '停課公告').type, '公告');
  assert.ok(!items.some((i) => /logout/.test(i.url)));
});
t('LINE 訊息合併', () => {
  const out = L.packTexts_(['a'.repeat(3000), 'b'.repeat(3000), 'c'], 4800);
  assert.equal(out.length, 2);
});
t('格式化訊息', () => {
  const s = L.formatItem_({ type: '作業', title: '期中報告', course: '解剖學', due: { date: new Date(2026, 10, 20, 23, 59), guessed: false }, url: 'https://iclass.ntunhs.edu.tw/x' }, '📅 已加入日曆');
  assert.ok(s.includes('11/20(五) 23:59')); console.log(s.replace(/^/gm, '    '));
});
console.log(`\n全部 ${n} 項通過`);
