/**
 * 纯逻辑层：馆藏解析、馆名匹配、坐标换算、距离、开放时间。
 * 不碰 DOM、不发请求，浏览器挂 window.SHLIB，Node 可 require（方便跑测试）。
 *
 * 坐标口径：全站统一用 GCJ-02（高德/腾讯底图用的火星坐标）。
 *   - 高德/腾讯地理编码返回的就是 GCJ-02，直接存
 *   - 浏览器定位给的是 WGS-84，用 wgs84ToGcj02 转一下再存
 * 这样距离计算和「高德导航」链接用的是同一套坐标，不会差 500m。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SHLIB = api;
})(typeof window !== 'undefined' ? window : this, function () {
  // ---------------------------------------------------------------- 坐标换算

  var PI = 3.1415926535897932384626;
  var A = 6378245.0;
  var EE = 0.00669342162296594323;

  function outOfChina(lng, lat) {
    return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
  }

  function transformLat(x, y) {
    var r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return r;
  }

  function transformLng(x, y) {
    var r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return r;
  }

  function wgs84ToGcj02(lng, lat) {
    if (lng == null || lat == null || outOfChina(lng, lat)) return [lng, lat];
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqMagic) * PI);
    dLng = (dLng * 180.0) / (A / sqMagic * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }

  // ---------------------------------------------------------------- 网点表

  function normalizeName(s) {
    return String(s || '')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/\s+/g, '');
  }

  // 同一家馆在图上的系统名（如"闵行分馆"）和显示名（如"闵行区图书馆"）可能不一样，
  // 馆藏接口给的是显示名，两套都要能对上
  var POOL = [];

  function setVenues(list) {
    var venues = list || [];
    POOL = [];
    venues.forEach(function (x) {
      POOL.push({ key: normalizeName(x.n), lib: x });
      POOL.push({ key: normalizeName(x.d), lib: x });
    });
    POOL = POOL
      .filter(function (p) { return p.key; })
      .sort(function (a, b) { return b.key.length - a.key.length; });
    return venues.length;
  }

  // 馆名 -> 网点：精确 → 馆名被输入包含 → 输入被馆名包含
  function matchLocation(name) {
    var N = normalizeName(name);
    if (!N) return null;
    var i;
    for (i = 0; i < POOL.length; i++) if (POOL[i].key === N) return POOL[i].lib;
    for (i = 0; i < POOL.length; i++) {
      if (POOL[i].key.length >= 3 && N.indexOf(POOL[i].key) !== -1) return POOL[i].lib;
    }
    for (i = 0; i < POOL.length; i++) {
      if (POOL[i].key.length >= 4 && POOL[i].key.indexOf(N) !== -1) return POOL[i].lib;
    }
    return null;
  }

  // ---------------------------------------------------------------- 距离

  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    function toRad(d) { return (d * Math.PI) / 180; }
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  }

  function formatDistance(m) {
    if (m === null || m === undefined || isNaN(m)) return '';
    // 距离单位统一中文：不足 1 公里用「米」，其余用「公里」
    if (m < 1000) return m + ' 米';
    if (m < 10000) return (m / 1000).toFixed(1) + ' 公里';
    return Math.round(m / 1000) + ' 公里';
  }

  // ---------------------------------------------------------------- 馆藏解析

  // 这些库室不对外供应：保存本只能馆内阅览，基藏要参考外借证
  var NON_LENDING = ['保存本', '基藏', '书库', '样本'];

  function isNonLending(room) {
    if (!room) return false;
    return NON_LENDING.some(function (k) { return room.indexOf(k) !== -1; });
  }

  /**
   * 借阅类型分类。上图 AjaxTab 里实际出现的四种（2026-10 实测）：
   *   General loan materials            → general   普通外借，可借走
   *   Children's loan materials         → children  少儿外借，可借走
   *   Reference Circulation Collection  → reference 参考外借，限馆内
   *   Preserved Collection              → preserved 保存本，限馆内阅览
   * 没标类型的按普通外借算（老数据别全丢了），其余进 other。
   */
  function loanKind(loanType) {
    var s = String(loanType || '');
    if (/preserved/i.test(s)) return 'preserved';
    if (/reference/i.test(s)) return 'reference';
    if (/children/i.test(s)) return 'children';
    if (/loan/i.test(s)) return 'general';
    // 没标类型的按 other 算（不进可借数，但进库室和索书号），别当 general 误算成可外借
    return 'other';
  }

  var KIND_LABEL = {
    general: '普通外借',
    children: '少儿外借',
    reference: '参考外借',
    preserved: '保存本',
    other: '馆内阅览'
  };

  function textOf(html) {
    return String(html || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 解析 POST /Record/<id>/AjaxTab（tab=holdings&libraryId=allItem）的返回。
   * 每段 <div class="branch"> 是一家馆，h2 给馆名（带 "Branch:" 前缀），
   * 里面每个 <div class="location-item"> 是一个库室，h3 给库室名，
   * 再里面每行 <tr class="holding-available|holding-unavailable"> 是一个复本。
   */
  // 「在架」状态词白名单：英文 "Available"，中文界面是「在架/可借」
  var AVAIL_RE = /^(available|在架|可借)/i;
  // 名义上"没借出去"、但此刻也不在架上的状态，一律不算可借：
  // 已归还刚归还还在流转路上、待取书车、在途调拨、破损、遗失
  var NOT_ON_SHELF_RE = /(已归还|流转中|在途|调拨|待取|in transit|recently returned|awaiting pickup|in process|damaged|missing|lost)/i;

  /**
   * 带结构诊断。除了 items，还要回答一个问题：
   * 「零条馆藏」到底是这本书真的没有馆藏，还是上图改版把 HTML 结构换掉了？
   *
   * 判据（宁可少报，不能误报）：
   * - 空响应 / 很短的响应：接口没给东西，不是改版
   * - 有 branch 段但一条复本都解析不出：结构变了（branch 壳还在，行选择器失效）
   * - 响应很长（>3000）却连 branch 段都没有：整块结构换了
   * 命中后 layout 给出原因，上层据此提示「接口可能改版」，而不是显示「无馆藏」。
   */
  function parseAjaxTabDetailed(html) {
    var out = [];
    var raw = String(html || '');
    var branches = 0;      // 解析出的 branch 段数（有馆名）
    var items = 0;         // 解析出的复本行数
    var sawBranchMark = raw.indexOf('<div class="branch">') >= 0;
    if (!raw) return { items: out, layout: { ok: false, reason: 'empty', branches: 0, len: 0 } };

    var blocks = raw.split('<div class="branch">');
    branches = blocks.length - 1;
    for (var i = 1; i < blocks.length; i++) {
      var blk = blocks[i];
      var h2 = blk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      var branch = h2 ? textOf(h2[1]).replace(/^Branch:\s*/, '').trim() : '';
      if (!branch) continue;
      var roomBlocks = blk.split(/<div class="location-item/);
      for (var j = 1; j < roomBlocks.length; j++) {
        var rb = roomBlocks[j];
        var h3 = rb.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
        var room = h3 ? textOf(h3[1]) : '';
        var rows = rb.match(/<tr[^>]*class="holding-(available|unavailable)"[\s\S]*?<\/tr>/g) || [];
        for (var k = 0; k < rows.length; k++) {
          var row = rows[k];
          var rowClass = /class="holding-(available|unavailable)"/.exec(row);
          var rowSaysAvail = !!rowClass && rowClass[1] === 'available';
          var barcode = row.match(/holding-field barcode">\s*([^<]*)/);
          if (!barcode || !barcode[1].trim()) continue;
          var callno = row.match(/holding-field callnumber">\s*([^<]*)/);
          var loan = row.match(/holding-field loanType">\s*([^<]*)/);
          // 状态词在内层 span 里（text-success 等）。有些行的布局是 div 不是 td，
          // 捕获到 </td> 会吞进后面别行的状态造成误判，所以优先取内层 span，
          // 实在取不到再限制在 300 字符内找单元格结束。
          var inner = row.match(/holding-field availability">\s*<span[^>]*>([\s\S]*?)<\/span>/);
          var availCell = inner
            ? inner[1]
            : (row.match(/holding-field availability">([\s\S]{0,300}?<\/(?:td|div)>)/) || ['', ''])[1];
          var availText = textOf(availCell);
          // 双重把关：行 class 标 available 且状态词在白名单里，还不能命中「不在架上」的黑名单
          var isAvail = rowSaysAvail && AVAIL_RE.test(availText) && !NOT_ON_SHELF_RE.test(availText);
          var statusText;
          if (isAvail) statusText = '在架';
          else if (NOT_ON_SHELF_RE.test(availText)) statusText = '已归还·流转中';
          else if (/check/i.test(availText) || /借出/.test(availText)) statusText = '已借出';
          else statusText = availText || '未知';
          out.push({
            branch: branch,
            room: room,
            barcode: barcode[1].trim(),
            callno: callno ? callno[1].trim() : '',
            loanType: loan ? loan[1].trim() : '',
            available: isAvail,
            statusText: statusText
          });
          items++;
        }
      }
    }

    // ---- 结构诊断
    var reason = '';
    if (!items) {
      if (sawBranchMark && branches > 0) {
        // 馆的壳还在，但一条复本都取不出：行选择器（holding-available / holding-field barcode）失效
        reason = 'rows';
      } else if (raw.length > 3000) {
        // 响应不是空的，但整块 branch 结构都没有：版式整个换了
        reason = 'branches';
      } else {
        // 很短的空壳，通常是这条记录本来就没有馆藏
        reason = 'no-holdings';
      }
    }
    return {
      items: out,
      layout: {
        ok: reason === '',
        reason: reason,
        branches: branches,
        len: raw.length
      }
    };
  }

  /**
   * 多个版本记录的复本按条码去重后，聚合成「馆 → 各借阅类型统计」。
   * available/total 只算能借走的（普通+少儿外借）；保存本、参考外借等
   * 馆内资料单独记在 kinds 里，不混进可借数，但也不丢——用户可能想在馆内看。
   * rooms 也只收外借库室：不能外借的库室对「去哪里借」没有帮助，反而会把
   * 真正的外借室挤成省略号（2026-10-22 用户指出）。
   */
  function aggregateHoldings(items) {
    var seen = {};
    var byBranch = {};
    (items || []).forEach(function (it) {
      if (seen[it.barcode]) return;
      seen[it.barcode] = 1;
      var kind = loanKind(it.loanType);
      // 库室名指明不外借的（保存本库室、基藏书库等），即便类型标了外借也不算
      if ((kind === 'general' || kind === 'children') && isNonLending(it.room)) {
        kind = 'other';
      }
      if (!byBranch[it.branch]) {
        byBranch[it.branch] = {
          name: it.branch, available: 0, total: 0,
          kinds: {}, callnos: [], rooms: []
        };
      }
      var b = byBranch[it.branch];
      if (!b.kinds[kind]) b.kinds[kind] = { avail: 0, total: 0 };
      b.kinds[kind].total += 1;
      if (it.available) b.kinds[kind].avail += 1;

      // general/children/other 都进 total/rooms/callnos（让用户知道去哪个室找），但只有 general/children 进 available
      if (kind !== 'preserved' && kind !== 'reference') {
        b.total += 1;
        if (it.room && b.rooms.indexOf(it.room) === -1) b.rooms.push(it.room);
        if (it.available && (kind === 'general' || kind === 'children')) {
          b.available += 1;
          if (it.callno && b.callnos.indexOf(it.callno) === -1) b.callnos.push(it.callno);
        }
      }
    });
    return Object.keys(byBranch).map(function (k) { return byBranch[k]; });
  }

  /**
   * 馆藏聚合结果 + 出发位置 → 可渲染的卡片数据，按距离升序（没坐标的按可借数排在后面）。
   */
  function buildPlaces(branches, spot, now) {
    var places = (branches || []).map(function (b) {
      var v = matchLocation(b.name) || {};
      var dist = (spot && spot.lat != null && v.lat != null && v.lng != null)
        ? haversine(spot.lat, spot.lng, v.lat, v.lng) : null;
      var h = todayHours(v.h || '', now);
      // 假期/调休日里「星期表说闭馆」不能算确定闭馆：开馆安排可能临时改，
      // openToday 记 null，勾「营业中」时按不确定隐藏；卡片上单独说「待确认」。
      // 用 specialClosed 而不是 unknown：原文写法没解析出来也带 unknown，
      // 那种情况仍是「开馆时间未知」，不能冒充成假期待确认。
      var holidayUnknown = !!h.specialClosed;
      return {
        name: b.name,
        display: v.d || b.name,
        address: v.a || '',
        tel: v.t || '',
        zone: v.z || '',
        lat: v.lat == null ? null : v.lat,
        lng: v.lng == null ? null : v.lng,
        available: b.available,
        total: b.total,
        kinds: b.kinds || {},
        callnos: (b.callnos || []).slice(0, 4),
        rooms: b.rooms || [],
        distance: dist,
        distanceText: formatDistance(dist),
        today: h.label,
        openNow: h.open,
        // 营业时间原文：卡片上「已闭馆」要配一句「下次几点开」，没有原文就无从算起
        hours: v.h || '',
        // 今天是假期/调休日（普通日子为 null），卡片提示和结果区提示条共用
        holiday: h.special || null,
        // 今天本是星期表里的闭馆日，但因假期/调休不能断言——跟「没有时间数据」分开计数
        holidayUnknown: holidayUnknown,
        // null = 判不了（没数据、写法没认出来、假期待确认）；false = 今天不开门
        openToday: h.open ? true : (h.unknown || !h.label ? null : false)
      };
    });
    places.sort(function (a, b) {
      var an = a.distance == null, bn = b.distance == null;
      if (an !== bn) return an ? 1 : -1;
      if (!an) return a.distance - b.distance;
      return b.available - a.available;
    });
    return places;
  }

  // ---------------------------------------------------------------- 开放时间

  // 2026 年法定节假日与调休上班日（国务院办公厅 2026 年部分节假日安排，上海照此执行）。
  // 只收「假期」和「调休上班」两类特殊日：表外的日期一律按星期表判断。
  // 只写到 2026 年——新的一年安排公布前不能拿旧日期去猜，宁可回到常规时间表。
  var SPECIAL_DAYS = (function () {
    var rows = [
      // 月, 起, 止, 名称, kind
      [1, 1, 3, '元旦', 'holiday'],
      [1, 4, 4, '元旦', 'workday'],
      [2, 15, 23, '春节', 'holiday'],
      [2, 14, 14, '春节', 'workday'],
      [2, 28, 28, '春节', 'workday'],
      [4, 4, 6, '清明', 'holiday'],
      [5, 1, 5, '劳动节', 'holiday'],
      [5, 9, 9, '劳动节', 'workday'],
      [6, 19, 21, '端午', 'holiday'],
      [9, 20, 20, '国庆节', 'workday'],
      [9, 25, 27, '中秋', 'holiday'],
      [10, 1, 7, '国庆节', 'holiday'],
      [10, 10, 10, '国庆节', 'workday']
    ];
    var map = {};
    rows.forEach(function (r) {
      for (var d = r[1]; d <= r[2]; d++) {
        map[2026 + '-' + r[0] + '-' + d] = { kind: r[4], name: r[3] };
      }
    });
    return map;
  })();

  /** 今天是不是表里的假期/调休日；返回 { kind: 'holiday'|'workday', name }，普通日子 null。 */
  function holidayOf(now) {
    var d = new Date(now == null ? Date.now() : now);
    if (isNaN(d.getTime())) return null;
    return SPECIAL_DAYS[d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()] || null;
  }

  var DAY_CHARS = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };

  function toMinutes(hhmm) {
    var p = String(hhmm).split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  // 形如：周二-周四:9:00-20:30 / 周五:12:30-20:30 / 周一-周日:8:30-16:30,8:30-20:30
  function parseHours(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^周?([日天一二三四五六])(?:\s*-\s*周?([日天一二三四五六]))?\s*[:：]\s*(.+)$/);
      if (!m) return;
      var from = DAY_CHARS[m[1]];
      var to = m[2] ? DAY_CHARS[m[2]] : from;
      var ranges = [];
      m[3].split(/[,，]/).forEach(function (r) {
        var rr = r.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        if (rr) ranges.push([toMinutes(rr[1]), toMinutes(rr[2])]);
      });
      if (!ranges.length) return;
      var d = from;
      for (var guard = 0; guard < 7; guard++) {
        out.push({ day: d, ranges: ranges });
        if (d === to) break;
        d = (d + 1) % 7;
      }
    });
    return out;
  }

  function todayHours(text, now) {
    var d = new Date(now || Date.now());
    var day = d.getDay();
    var nowMin = d.getHours() * 60 + d.getMinutes();
    var all = parseHours(text);
    var special = holidayOf(d);
    var entries = all.filter(function (e) { return e.day === day; });
    function withSpecial(o) {
      if (special) o.special = special;
      return o;
    }
    if (!entries.length) {
      if (!String(text || '').trim()) return withSpecial({ label: '', open: false });
      // 有营业时间原文、但一条都没解析出来：那是**写法没认出来**（「周一至周五」「夏令时 8:30-17:00」
      // 都不在正则里），不是今天闭馆。返回空 label → 下游 buildPlaces 把 openToday 置 null，
      // 卡片标「开馆时间未知」，勾「营业中」时按「不确定」处理、不算在营业
      if (!all.length) return withSpecial({ label: '', open: false, unknown: true });
      // 今天有星期名但没解析出条目（写法没认出来，如「周一:8-17」缺分钟）→ unknown，不是闭馆
      var dayNames = ['日', '天', '一', '二', '三', '四', '五', '六'];
      var todayName = '周' + dayNames[day];
      if (text.indexOf(todayName) >= 0 || text.indexOf('星期' + dayNames[day]) >= 0) {
        return withSpecial({ label: '', open: false, unknown: true });
      }
      // 星期表说今天不开门，但今天是法定假期或调休上班日：临时调整恰恰发生在这种日子，
      // 不能拿常规表断言「今日闭馆」——只能说待确认，也不参与「营业中」筛选。
      // 标签只用一个词（「开馆安排待确认」）：假期还是调休交给卡片 tooltip 说，
      // 这里再分两种写法就会跟筛选条、空态标题各说各的
      if (special) {
        return withSpecial({
          label: '开馆安排待确认',
          open: false,
          unknown: true,
          specialClosed: true
        });
      }
      // 普通日子、解析出来了、今天不在开放日里 —— 这才是真的今天闭馆
      return { label: '今日闭馆', open: false };
    }
    function fmt(x) { return Math.floor(x / 60) + ':' + ('0' + (x % 60)).slice(-2); }
    var label = entries[0].ranges.map(function (r) { return fmt(r[0]) + '-' + fmt(r[1]); }).join('、');
    var open = entries.some(function (e) {
      return e.ranges.some(function (r) { return nowMin >= r[0] && nowMin <= r[1]; });
    });
    // 假期里星期表说开门：照常给时段，临时调整交给结果区那条假期提示说明
    return withSpecial({ label: label, open: open });
  }

  /**
   * 从一批馆里找出「最快会开门」的那一家，回答空态里那句「最早 X 点开门」。
   * 只看此刻之后的时间段：今天的时段已过（或今天闭馆）就往后翻，最多 7 天。
   * places 用 buildPlaces 的产物，但开放时间原文要从网点表重新取——places 上只留了
   * 今天的标签和 openNow 布尔，答不了「明天几点开」。
   *
   * 返回 {name, mins, at, when, label}：
   *   at    开门时刻 "9:00"
   *   when  哪天，当天就是 "今天"，否则 "明天"/"周三"
   *   label when + at 拼好的整句，给不拆开用的人（当前前端拆开用：当天不必重复说几点）
   *
   * 每家自己能查到的最早一档先落到 mine，再跟全局 best 比——不能在循环里直接跟 best 比，
   * 否则先出现的那家一旦落榜，break 就把它自己后面几天一起跳过了。
   * 推算途中碰到假期/调休日就停：那天的开馆安排可能临时改，宁可不说也不编时间。
   * 没有可用时间数据的一律跳过，返回 null。
   */
  function nextOpening(places, now) {
    var d0 = new Date(now || Date.now());
    var nowMin = d0.getHours() * 60 + d0.getMinutes();
    var best = null;
    (places || []).forEach(function (p) {
      var v = matchLocation(p.name);
      if (!v || !v.h) return;
      var entries = parseHours(v.h);
      if (!entries.length) return;
      var mine = null;
      for (var ahead = 0; ahead < 7 && !mine; ahead++) {
        if (holidayOf(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + ahead))) break;
        var day = (d0.getDay() + ahead) % 7;
        var hit = entries.filter(function (e) { return e.day === day; })[0];
        if (!hit) continue;
        // 今天只认此刻之后的时段；往后几天从 0 点起算
        var starts = hit.ranges
          .map(function (r) { return r[0]; })
          .filter(function (m) { return ahead > 0 || m > nowMin; })
          .sort(function (a, b) { return a - b; });
        if (!starts.length) continue;
        var hh = starts[0];
        var at = Math.floor(hh / 60) + ':' + ('0' + (hh % 60)).slice(-2);
        var when = ahead === 0 ? '今天'
          : ahead === 1 ? '明天'
            : '周' + '日一二三四五六'.charAt(day);
        mine = {
          // 用馆藏接口给的馆名，不用网点表里的名字：两者有时不同（「上海图书馆（东馆）」vs
          // 「上海图书馆东馆」），用户在列表里看到的是哪个，这里就该说哪个，否则对不上号。
          name: p.display || p.name,
          mins: ahead * 1440 + hh - nowMin,
          at: at,
          when: when,
          label: when + ' ' + at
        };
      }
      if (mine && (!best || mine.mins < best.mins)) best = mine;
    });
    return best;
  }

  /**
   * 单馆版「下次几点开」：给卡片上那句「已闭馆」配一个「明天 9:00 开」。
   * 逻辑跟 nextOpening 的循环体同源（只看此刻之后的时段，最多翻 7 天），
   * 输入营业时间原文（网点表里的 h），输出 {at, when, label} 或 null。
   * 一条都没解析出来（「周一至周五」这类写法没认出来）时返回 null——
   * 宁可不说，也不编时间。当天已过早时段、下午还有第二段时，when 是「今天」。
   * 推算途中碰到假期/调休日就停，同样返回 null。
   */
  function nextOpenAt(text, now) {
    var d0 = new Date(now || Date.now());
    var nowMin = d0.getHours() * 60 + d0.getMinutes();
    var entries = parseHours(text);
    if (!entries.length) return null;
    for (var ahead = 0; ahead < 7; ahead++) {
      if (holidayOf(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + ahead))) return null;
      var day = (d0.getDay() + ahead) % 7;
      var hit = entries.filter(function (e) { return e.day === day })[0];
      if (!hit) continue;
      // 今天只认此刻之后的时段；往后几天从 0 点起算
      var starts = hit.ranges
        .map(function (r) { return r[0]; })
        .filter(function (m) { return ahead > 0 || m > nowMin; })
        .sort(function (a, b) { return a - b; });
      if (!starts.length) continue;
      var hh = starts[0];
      var at = Math.floor(hh / 60) + ':' + ('0' + (hh % 60)).slice(-2);
      var when = ahead === 0 ? '今天' : ahead === 1 ? '明天' : '周' + '日一二三四五六'.charAt(day);
      return { at: at, when: when, label: when + ' ' + at };
    }
    return null;
  }

  return {
    setVenues: setVenues,
    matchLocation: matchLocation,
    haversine: haversine,
    formatDistance: formatDistance,
    wgs84ToGcj02: wgs84ToGcj02,
    isNonLending: isNonLending,
    loanKind: loanKind,
    KIND_LABEL: KIND_LABEL,
    holidayOf: holidayOf,
    parseHours: parseHours,
    todayHours: todayHours,
    nextOpening: nextOpening,
    nextOpenAt: nextOpenAt,
    parseAjaxTabDetailed: parseAjaxTabDetailed,
    aggregateHoldings: aggregateHoldings,
    buildPlaces: buildPlaces,
    normalizeName: normalizeName
  };
});
