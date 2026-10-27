'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lib = require('../web/shlib.js');

// 固定一个周一，避免测试结果随运行日期变化
const MON_10AM = new Date(2026, 9, 19, 10, 0);
const MON_6PM = new Date(2026, 9, 19, 18, 0);

test('parseHours 展开跨天区间并保留多时段', () => {
  const entries = lib.parseHours('周二-周四:9:00-20:30\n周五:12:30-20:30,18:00-21:00');
  assert.deepStrictEqual(entries.filter(e => e.day >= 2 && e.day <= 4).map(e => e.day), [2, 3, 4]);
  const fri = entries.filter(e => e.day === 5);
  assert.strictEqual(fri.length, 1);
  assert.deepStrictEqual(fri[0].ranges, [[750, 1230], [1080, 1260]]);
  assert.deepStrictEqual(entries.filter(e => e.day === 6), []);
});

test('parseHours 忽略无法识别的写法与空行', () => {
  assert.deepStrictEqual(lib.parseHours(''), []);
  assert.deepStrictEqual(lib.parseHours('周一至周五 9:00-17:00'), []);
  assert.deepStrictEqual(lib.parseHours('周一:9:00-17:00\n营业时间另行通知'), [
    { day: 1, ranges: [[540, 1020]] }
  ]);
});

test('todayHours 区分在馆时段、已闭馆、今天不开与写法不识别', () => {
  const text = '周一-周日:9:00-17:00';
  assert.deepStrictEqual(lib.todayHours(text, MON_10AM), { label: '9:00-17:00', open: true });
  assert.deepStrictEqual(lib.todayHours(text, MON_6PM), { label: '9:00-17:00', open: false });
  assert.deepStrictEqual(lib.todayHours('周二:9:00-17:00', MON_10AM),
    { label: '今日闭馆', open: false });
  assert.deepStrictEqual(lib.todayHours('周一至周五 9:00-17:00', MON_10AM),
    { label: '', open: false, unknown: true });
  assert.deepStrictEqual(lib.todayHours('', MON_10AM), { label: '', open: false });
});

test('nextOpenAt 只报此刻之后的开门时间', () => {
  const text = '周一-周五:9:00-17:00';
  assert.deepStrictEqual(lib.nextOpenAt(text, new Date(2026, 9, 19, 8, 0)),
    { at: '9:00', when: '今天', label: '今天 9:00' });
  assert.deepStrictEqual(lib.nextOpenAt(text, MON_6PM),
    { at: '9:00', when: '明天', label: '明天 9:00' });
  assert.strictEqual(lib.nextOpenAt('周一至周五 9:00-17:00', MON_10AM), null);
});

test('nextOpening 在所有馆里挑最先开门的一家', () => {
  lib.setVenues([
    { n: '甲馆', lat: 31.2, lng: 121.4, h: '周一-周日:10:00-18:00' },
    { n: '乙馆', lat: 31.3, lng: 121.5, h: '周一-周日:8:30-17:00' },
    { n: '丙馆', lat: 31.4, lng: 121.6, h: '周一至周五 8:00-17:00' }
  ]);
  const places = [
    { name: '甲馆', display: '甲馆' },
    { name: '乙馆', display: '乙图书馆' },
    { name: '丙馆', display: '丙馆' },
    { name: '不存在的馆', display: '不存在的馆' }
  ];
  assert.deepStrictEqual(lib.nextOpening(places, MON_6PM), {
    name: '乙图书馆', mins: 870, at: '8:30', when: '明天', label: '明天 8:30'
  });
  assert.strictEqual(lib.nextOpening([], MON_6PM), null);
});

test('距离计算与展示', () => {
  assert.strictEqual(lib.haversine(31.23, 121.47, 31.23, 121.47), 0);
  const oneDeg = lib.haversine(0, 0, 1, 0);
  assert.ok(Math.abs(oneDeg - 111195) <= 2, String(oneDeg));
  assert.strictEqual(lib.formatDistance(null), '');
  assert.strictEqual(lib.formatDistance(undefined), '');
  assert.strictEqual(lib.formatDistance(NaN), '');
  assert.strictEqual(lib.formatDistance(0), '0 米');
  assert.strictEqual(lib.formatDistance(999), '999 米');
  assert.strictEqual(lib.formatDistance(1000), '1.0 公里');
  assert.strictEqual(lib.formatDistance(9999), '10.0 公里');
  assert.strictEqual(lib.formatDistance(10000), '10 公里');
});

test('wgs84ToGcj02 国内偏移、境外原样返回', () => {
  const [lng, lat] = lib.wgs84ToGcj02(121.47, 31.23);
  assert.ok(lng > 121.47 && lng < 121.49, String(lng));
  assert.ok(lat > 31.22 && lat < 31.24, String(lat));
  assert.deepStrictEqual(lib.wgs84ToGcj02(-0.12, 51.5), [-0.12, 51.5]);
  assert.deepStrictEqual(lib.wgs84ToGcj02(null, 31), [null, 31]);
});

test('normalizeName 统一括号、空白与零宽字符', () => {
  assert.strictEqual(lib.normalizeName(' 上海图书馆（东馆） '), '上海图书馆(东馆)');
  assert.strictEqual(lib.normalizeName('上海\u200b图书馆'), '上海图书馆');
  assert.strictEqual(lib.normalizeName(null), '');
});

test('loanKind 按借阅类型归类', () => {
  assert.strictEqual(lib.loanKind('General loan materials'), 'general');
  assert.strictEqual(lib.loanKind("Children's loan materials"), 'children');
  assert.strictEqual(lib.loanKind('Reference Circulation Collection'), 'reference');
  assert.strictEqual(lib.loanKind('Preserved Collection'), 'preserved');
  // 没标类型的按 other 算（不进可借数，但进库室和索书号），别当 general 误算成可外借
  assert.strictEqual(lib.loanKind(''), 'other');
  assert.strictEqual(lib.loanKind('Something Else'), 'other');
});

test('isNonLending 命中保存本/基藏/书库/样本', () => {
  assert.strictEqual(lib.isNonLending('保存本库室'), true);
  assert.strictEqual(lib.isNonLending('基藏书库'), true);
  assert.strictEqual(lib.isNonLending('普通外借室'), false);
  assert.strictEqual(lib.isNonLending(''), false);
});

const HTML_OK = `
<div class="branch">
  <h2>Branch: 上海图书馆东馆</h2>
  <div class="location-item">
    <h3>普通外借室</h3>
    <table><tbody>
      <tr class="holding-available">
        <td><span class="holding-field barcode">B001</span></td>
        <td><span class="holding-field callnumber">I247.5/1234</span></td>
        <td><span class="holding-field loanType">General loan materials</span></td>
        <td class="holding-field availability"><span>Available</span></td>
      </tr>
      <tr class="holding-unavailable">
        <td><span class="holding-field barcode">B002</span></td>
        <td><span class="holding-field callnumber">I247.5/1234</span></td>
        <td><span class="holding-field loanType">General loan materials</span></td>
        <td class="holding-field availability"><span>Checked Out</span></td>
      </tr>
    </tbody></table>
  </div>
  <div class="location-item">
    <h3>保存本库室</h3>
    <table><tbody>
      <tr class="holding-available">
        <td><span class="holding-field barcode">B003</span></td>
        <td><span class="holding-field callnumber">I247.5/9999</span></td>
        <td><span class="holding-field loanType">General loan materials</span></td>
        <td class="holding-field availability"><span>Available</span></td>
      </tr>
    </tbody></table>
  </div>
</div>
`;

test('parseAjaxTabDetailed 解析在架/借出并与行 class 双重把关', () => {
  const { items, layout } = lib.parseAjaxTabDetailed(HTML_OK);
  assert.strictEqual(layout.ok, true);
  assert.strictEqual(layout.branches, 1);
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual(items.map(i => i.barcode), ['B001', 'B002', 'B003']);
  assert.strictEqual(items[0].branch, '上海图书馆东馆');
  assert.strictEqual(items[0].room, '普通外借室');
  assert.strictEqual(items[0].available, true);
  assert.strictEqual(items[0].statusText, '在架');
  assert.strictEqual(items[1].available, false);
  assert.strictEqual(items[1].statusText, '已借出');

  const mismatch = lib.parseAjaxTabDetailed(HTML_OK.replace(
    '<td class="holding-field availability"><span>Available</span></td>',
    '<td class="holding-field availability"><span>Checked Out</span></td>'
  ));
  assert.strictEqual(mismatch.items[0].available, false);
});

test('parseAjaxTabDetailed 诊断空响应、改版与无馆藏', () => {
  assert.deepStrictEqual(lib.parseAjaxTabDetailed('').layout,
    { ok: false, reason: 'empty', branches: 0, len: 0 });
  const shell = lib.parseAjaxTabDetailed('<div class="branch"><h2>Branch: X</h2></div>');
  assert.strictEqual(shell.layout.reason, 'rows');
  const longText = '<div>' + 'x'.repeat(4000) + '</div>';
  assert.strictEqual(lib.parseAjaxTabDetailed(longText).layout.reason, 'branches');
  assert.strictEqual(lib.parseAjaxTabDetailed('<p>没有馆藏</p>').layout.reason, 'no-holdings');
});

test('aggregateHoldings 去重、排除非外借库室、只统计可外借复本', () => {
  const { items } = lib.parseAjaxTabDetailed(HTML_OK);
  items.push(Object.assign({}, items[0], { barcode: 'B001', available: false }));
  const branches = lib.aggregateHoldings(items);
  assert.strictEqual(branches.length, 1);
  const b = branches[0];
  assert.strictEqual(b.available, 1);
  // other 类型（保存本库室）也进 total/rooms/callnos，但只有 general/children 进 available
  assert.strictEqual(b.total, 3);
  assert.deepStrictEqual(b.callnos, ['I247.5/1234']);
  assert.deepStrictEqual(b.rooms, ['普通外借室', '保存本库室']);
  assert.deepStrictEqual(b.kinds.general, { avail: 1, total: 2 });
  assert.deepStrictEqual(b.kinds.other, { avail: 1, total: 1 });
});

test('holidayOf 只认 2026 年表内的假期与调休日', () => {
  assert.deepStrictEqual(lib.holidayOf(new Date(2026, 9, 5)),
    { kind: 'holiday', name: '国庆节' });
  assert.deepStrictEqual(lib.holidayOf(new Date(2026, 9, 10)),
    { kind: 'workday', name: '国庆节' });
  assert.deepStrictEqual(lib.holidayOf(new Date(2026, 8, 20)),
    { kind: 'workday', name: '国庆节' });
  assert.strictEqual(lib.holidayOf(new Date(2026, 9, 19)), null);
  // 2027 年的安排还没进表：不能拿旧日期猜，回到常规时间表
  assert.strictEqual(lib.holidayOf(new Date(2027, 0, 1)), null);
});

test('todayHours 在假期/调休日不把常规闭馆断言成闭馆', () => {
  const holidayMon = new Date(2026, 9, 5, 10, 0);
  const special = { kind: 'holiday', name: '国庆节' };
  assert.deepStrictEqual(lib.todayHours('周二-周日:9:00-17:00', holidayMon),
    { label: '开馆安排待确认', open: false, unknown: true, specialClosed: true, special });
  // 普通周一才说「今日闭馆」
  assert.deepStrictEqual(lib.todayHours('周二-周日:9:00-17:00', MON_10AM),
    { label: '今日闭馆', open: false });
  // 调休上班的周日：常规表里是休息日，也不能断言闭馆；假期和调休共用同一个标签，
  // 是哪种日子由 special 字段带上、卡片 tooltip 再说
  assert.deepStrictEqual(lib.todayHours('周一-周五:9:00-17:00', new Date(2026, 8, 20, 10, 0)),
    { label: '开馆安排待确认', open: false, unknown: true, specialClosed: true,
      special: { kind: 'workday', name: '国庆节' } });
  // 常规表说今天开，就照常给时段；临时调整交给结果区提示条
  assert.deepStrictEqual(lib.todayHours('周一-周日:9:00-17:00', holidayMon),
    { label: '9:00-17:00', open: true, special });
  // 原文写法没解析出来仍是「未知」，不能因为赶上假期就冒充「开馆安排待确认」
  const unparsed = lib.todayHours('周一至周五 9:00-17:00', holidayMon);
  assert.strictEqual(unparsed.label, '');
  assert.strictEqual(unparsed.unknown, true);
  assert.strictEqual(unparsed.specialClosed, undefined);
  assert.deepStrictEqual(unparsed.special, special);
});

test('nextOpenAt 推算跨进假期/调休日时不再编时间', () => {
  const daily = '周一-周日:9:00-17:00';
  // 10/4 周日 18:00：下一次开门是 10/5，但那是国庆假期
  assert.strictEqual(lib.nextOpenAt(daily, new Date(2026, 9, 4, 18, 0)), null);
  // 9/19 周六 18:00：下一次是 9/20 调休上班日
  assert.strictEqual(lib.nextOpenAt(daily, new Date(2026, 8, 19, 18, 0)), null);
  // 假期当天下午还有第二段，也不拿常规表去承诺「今天 13:00 开」
  assert.strictEqual(lib.nextOpenAt('周一:13:00-20:00', new Date(2026, 9, 5, 12, 0)), null);
  // 普通周末照常推算
  assert.deepStrictEqual(lib.nextOpenAt(daily, new Date(2026, 9, 18, 18, 0)),
    { at: '9:00', when: '明天', label: '明天 9:00' });
});

test('nextOpening 在假期不给出「最早几点开」', () => {
  lib.setVenues([
    { n: '甲馆', lat: 31.2, lng: 121.4, h: '周一-周日:9:00-17:00' }
  ]);
  const places = [{ name: '甲馆', display: '甲馆' }];
  assert.strictEqual(lib.nextOpening(places, new Date(2026, 9, 4, 18, 0)), null);
  assert.deepStrictEqual(lib.nextOpening(places, new Date(2026, 9, 18, 18, 0)),
    { name: '甲馆', mins: 900, at: '9:00', when: '明天', label: '明天 9:00' });
});

test('buildPlaces 把假期待确认与「没有时间数据」分开', () => {
  lib.setVenues([
    { n: '周一闭馆馆', d: '周一闭馆馆', lat: 31.2, lng: 121.4, h: '周二-周日:9:00-17:00' }
  ]);
  const branches = [{ name: '周一闭馆馆', available: 1, total: 1, callnos: [], rooms: [] }];
  const h = lib.buildPlaces(branches, null, new Date(2026, 9, 5, 10, 0))[0];
  assert.strictEqual(h.today, '开馆安排待确认');
  assert.strictEqual(h.openToday, null);
  assert.strictEqual(h.holidayUnknown, true);
  assert.deepStrictEqual(h.holiday, { kind: 'holiday', name: '国庆节' });
});

test('buildPlaces 按距离排序，没有坐标的按可借数排后面', () => {
  lib.setVenues([
    { n: '近馆', d: '近图书馆', a: '近路 1 号', lat: 31.231, lng: 121.471, h: '周一-周日:9:00-17:00' },
    { n: '远馆', d: '远图书馆', a: '远路 2 号', lat: 31.30, lng: 121.50, h: '周一-周日:9:00-17:00' },
    { n: '未知馆', d: '未知图书馆', h: '周一至周五 9:00-17:00' }
  ]);
  const branches = [
    { name: '远馆', available: 9, total: 9, callnos: [], rooms: [] },
    { name: '近馆', available: 1, total: 2, callnos: [], rooms: [] },
    { name: '未知馆', available: 5, total: 5, callnos: [], rooms: [] },
    { name: '不在网点表的馆', available: 8, total: 8, callnos: [], rooms: [] }
  ];
  const places = lib.buildPlaces(branches, { lat: 31.23, lng: 121.47 }, MON_10AM);
  assert.deepStrictEqual(places.map(p => p.display), ['近图书馆', '远图书馆', '不在网点表的馆', '未知图书馆']);
  assert.ok(places[0].distance < places[1].distance);
  assert.strictEqual(places[0].openNow, true);
  // 没坐标的按可借数降序排在后面；不在网点表里的同样没坐标、今天状态未知
  assert.deepStrictEqual(places.slice(2).map(p => p.display).sort(),
    ['不在网点表的馆', '未知图书馆'].sort());
  assert.strictEqual(places.filter(p => p.display === '未知图书馆')[0].openToday, null);
});
