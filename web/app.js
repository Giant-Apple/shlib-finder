/**
 * 页面逻辑：书架（豆瓣书单 + 手动加书）→ 逐本查上图实时馆藏 → 按距离排。
 * 请求都走本地 server.py（/vufind 转发、/api/*），浏览器不直接跨域。
 */
(function () {
  'use strict';

  var API = '/vufind';
  var PAGE_LIMIT = 20;      // 检索接口单页上限
  var INSTANCES = 10;       // 取前 N 条版本记录，逐个拉完整馆藏（这些记录覆盖了全市分馆）
  var CONC = 5;             // 并发上限，别把人网站打崩
  var CACHE_TTL = 5 * 60 * 1000;
  var SHOW_LIMIT = 30;
  // 上图版本查询（/api/editions）在页面内的缓存时长。服务端还有 24 小时检索缓存、
  // 30 天书目缓存，这里只是别让切书/改输入时反复发请求
  var ED_TTL = 10 * 60 * 1000;
  // 书架后台逐本查版本时的并发：服务端一次检索内部已经开 4 个线程拉 RIS，
  // 页面上再压到 2 路，别让整架书同时涌向上图
  var ED_CONC = 2;

  /**
   * 图标：全部取 Lucide（lucide-static v1.59.0，ISC 许可）的官方 path，
   * 内联成 SVG 而不是引图标字体或 JS 包——项目零依赖、零构建，双击就能跑。
   *
   * 统一规格（改图标时务必守住，这是「风格统一」的全部来源）：
   *   viewBox 0 0 24 24 / fill none / stroke currentColor / stroke-width 2
   *   linecap + linejoin round
   * 尺寸不进这里，一律交给 CSS 的 .ic 控制（不同位置需要不同大小，写在属性上就没法覆盖了）。
   * 新增图标：从 https://unpkg.com/lucide-static@1.59.0/icons/<名字>.svg 取 <svg> 内部的内容，
   * 原样贴进这张表，别自己改路径。
   */
  var ICONS = {
    search: '<circle cx="11" cy="11" r="8" /> <path d="m21 21-4.34-4.34" />',
    locate: '<line x1="2" x2="5" y1="12" y2="12" /> <line x1="19" x2="22" y1="12" y2="12" /> ' +
      '<line x1="12" x2="12" y1="2" y2="5" /> <line x1="12" x2="12" y1="19" y2="22" /> ' +
      '<circle cx="12" cy="12" r="7" />',
    sliders: '<path d="M10 5H3" /> <path d="M12 19H3" /> <path d="M14 3v4" /> <path d="M16 17v4" /> ' +
      '<path d="M21 12h-9" /> <path d="M21 19h-5" /> <path d="M21 5h-7" /> <path d="M8 10v4" /> ' +
      '<path d="M8 12H3" />',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /> ' +
      '<path d="M21 3v5h-5" /> <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /> ' +
      '<path d="M8 16H3v5" />',
    map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 ' +
      '2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 ' +
      '.553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" /> <path d="M15 5.764v15" /> <path d="M9 3.236v15" />',
    phone: '<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 ' +
      '2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 ' +
      '0 0 6.392 6.384" />',
    navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11" />',
    'chevron-left': '<path d="m15 18-6-6 6-6" />',
    'chevron-right': '<path d="m9 18 6-6-6-6" />',
    'chevrons-left': '<path d="m11 17-5-5 5-5" /> <path d="m18 17-5-5 5-5" />',
    'chevrons-right': '<path d="m6 17 5-5-5-5" /> <path d="m13 17 5-5-5-5" />',
    bike: '<circle cx="18.5" cy="17.5" r="3.5" /> <circle cx="5.5" cy="17.5" r="3.5" /> ' +
      '<circle cx="15" cy="5" r="1" /> <path d="M12 17.5V14l-3-3 4-3 2 3h2" />',
    'book-x': '<path d="m14.5 7.5-5 5" /> <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 ' +
      '0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" /> <path d="m9.5 7.5 5 5" />',
    // 可借徽标用书本 + 勾，代替「可借」两个字
    'book-check': '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 ' +
      '0 0 1 0-5H20" /> <path d="m9 9.5 2 2 4-4" />',
    // 「手动添加」分组：书本 + 加号。不能用 library（和书架标题重合），也不能用 plus
    // （书架头部那颗「加书」按钮已经是它）——同一屏里两个「加」得长成两样
    'book-plus': '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 ' +
      '0 0 1 0-5H20" /> <path d="M12 6v6" /> <path d="M9 9h6" />',
    // 仅馆内：有复本、但不能外借。跟书本叉（都已借出）必须一眼分开
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 ' +
      '10.75 10.75 0 0 1-19.876 0" /> <circle cx="12" cy="12" r="3" />',
    'chevron-down': '<path d="m6 9 6 6 6-6" />',
    'chevron-up': '<path d="m18 15-6-6-6 6" />',
    // GitHub 官方标记（Simple Icons 的 24×24 路径，实心）：品牌标识用原样，
    // 不拿线性图标凑；fill/stroke 就地覆盖，icon() 的默认描边对它不生效
    github: '<path fill="currentColor" stroke="none" d="M12 .297c-6.63 0-12 5.373-12 12 ' +
      '0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04' +
      '-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 ' +
      '1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605' +
      '-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 ' +
      '0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 ' +
      '2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 ' +
      '0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 ' +
      '0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />',
    check: '<path d="M20 6 9 17l-5-5" />',
    'moon-star': '<path d="M18 5h4" /> <path d="M20 3v4" /> ' +
      '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />',
    clock: '<circle cx="12" cy="12" r="10" /> <path d="M12 6v6l4 2" />',
    calendar: '<path d="M8 2v4" /> <path d="M16 2v4" /> ' +
      '<rect width="18" height="18" x="3" y="4" rx="2" /> <path d="M3 10h18" />',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /> ' +
      '<path d="M12 9v4" /> <path d="M12 17h.01" />',
    // 头部外观开关的两个状态：亮色显示太阳、暗色显示月亮（跟着当前主题换，不是并列两段）
    sun: '<circle cx="12" cy="12" r="4" /> <path d="M12 2v2" /> <path d="M12 20v2" /> ' +
      '<path d="m4.93 4.93 1.41 1.41" /> <path d="m17.66 17.66 1.41 1.41" /> ' +
      '<path d="M2 12h2" /> <path d="M20 12h2" /> <path d="m6.34 17.66-1.41 1.41" /> ' +
      '<path d="m19.07 4.93-1.41 1.41" />',
    moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />',
    // 以下六个给搜索框和书单头部用（2026-10-20 加，路径同样取自 lucide-static@1.59.0）
    x: '<path d="M18 6 6 18" /> <path d="m6 6 12 12" />',
    plus: '<path d="M5 12h14" /> <path d="M12 5v14" />',
    minus: '<path d="M5 12h14" />',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /> ' +
      '<path d="M3 3v5h5" /> <path d="M12 7v5l4 2" />',
    'trash-2': '<path d="M10 11v6" /> <path d="M14 11v6" /> ' +
      '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /> <path d="M3 6h18" /> ' +
      '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />',
    // 药丸框右侧那颗「去查」圆钮，和设置里「打开配置文件」用
    'arrow-right': '<path d="M5 12h14" /> <path d="m12 5 7 7-7 7" />',
    'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 ' +
      '1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /> ' +
      '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
    'file-cog': '<path d="M15 8a1 1 0 0 1-1-1V2a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8z" /> ' +
      '<path d="M20 8v12a2 2 0 0 1-2 2h-4.182" /> <path d="m3.305 19.53.923-.382" /> ' +
      '<path d="M4 10.592V4a2 2 0 0 1 2-2h8" /> <path d="m4.228 16.852-.924-.383" /> ' +
      '<path d="m5.852 15.228-.383-.923" /> <path d="m5.852 20.772-.383.924" /> ' +
      '<path d="m8.148 15.228.383-.923" /> <path d="m8.53 21.696-.382-.924" /> ' +
      '<path d="m9.773 16.852.922-.383" /> <path d="m9.773 19.148.922.383" /> <circle cx="7" cy="18" r="3" />',
    // search-check 在 1.59.0 里是 m21 21-4.3-4.3（不是 4.34），照源抄
    'search-check': '<path d="m8 11 2 2 4-4" /> <circle cx="11" cy="11" r="8" /> <path d="m21 21-4.3-4.3" />',
    // 搜索下拉里的两个小标记：书在书架里 / 这一条是去上图现查
    library: '<path d="m16 6 4 14" /> <path d="M12 6v14" /> <path d="M8 8v12" /> ' +
      '<path d="M4 4v16" />',
    'corner-down-left': '<path d="M20 4v7a4 4 0 0 1-4 4H4" /> <path d="m9 10-5 5 5 5" />',
    // 外链：跳到上图原始页面用（结果页标题旁那枚 ↗）
    'external-link': '<path d="M15 3h6v6" /> <path d="M10 14 21 3" /> ' +
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />'
  };

  // 生成一个图标。<i> 是 Lucide 的线描风格：不填充、描边走 currentColor。
  // cls 用来加额外类（比如骑行用的 .ic），尺寸由 CSS 决定。
  function icon(name, cls) {
    var body = ICONS[name];
    if (!body) return '';
    return '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + body + '</svg>';
  }

  var ICON_REFRESH = icon('refresh');
  var ICON_PLUS = icon('plus');
  var ICON_MINUS = icon('minus');
  var ICON_MAP = icon('map');
  var ICON_LOCATE = icon('locate');
  var ICON_TEL = icon('phone');
  var ICON_NAV = icon('navigation');

  // index.html 里的图标位写成 <i data-icon="search"></i>，这里一次性填成 SVG。
  // 这么做的原因：图标定义只留 app.js 一处（ICONS 表），HTML 里不重复贴路径，
  // 换图标时只改一个地方，也不会出现两份不同的 viewBox 混用。
  function hydrateIcons(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('[data-icon]'), function (el) {
      if (el.firstChild) return;   // 已经填过，别重复插
      var svg = icon(el.getAttribute('data-icon'));
      if (svg) el.innerHTML = svg;
    });
  }

  // 并列字段之间用竖线分隔：不用 ·（译名里本来就有），也不用 ，（跟句子里的逗号分不开）
  var SEP = '<span class="sep">|</span>';
  function joinSep(arr) { return arr.filter(Boolean).join(SEP); }

  var S = {
    cfg: null,
    // 便携模式：打包产物里 localStorage 的 shlib.nostore 被置为 "1"，
    // 整站不往本机写任何东西（位置、主题、搜索记录、面板开合）。见 lsGet/lsSet
    nostore: false,
    cfgVersion: '',  // /api/config 带回的服务端版本，只在设置面板底部显示
    cfgBuild: '',    // 打包日期，同上
    // 两个豆瓣来源各一份状态：豆列和想读同时用、各自分批、各自报错。
    // 每个来源的 books 是已载入的书，其余字段供书架分组画状态
    lists: { doulist: newListState(), wish: newListState() },
    // 自己手动加的书：单独一组、和豆瓣书单并排放在书架上，不会写回豆瓣书单。
    // 存在本机（shlib.shelf），刷新还在；按 id 前缀 q: 区分
    manual: [],
    manualLoaded: false,
    // 三组书架的收起状态：只隐藏组内内容，组标题和数量还在（长列表时留出视野）
    folded: { manual: false, doulist: false, wish: false },
    update: null,     // 最近一次「检查更新」的结果：按钮文案按它画
    activeId: null,
    spot: null,
    filter: 'avail',
    results: {},     // id -> {places, meta}
    cache: {},       // id -> {at, payload}
    busy: {},        // id -> true
    ride: {},        // "from|to" -> {bike, bikeKm}
    showAll: false,
    onlyOpen: false,  // 「营业中」默认关：只看可借 = 有在架册，今日闭馆的也照样列出来（卡片上有标注）
    mapOn: true,      // 结果区是否显示地图（用户可折叠，记在 localStorage）
    mapView: null,    // 上次的 {center, zoom}：重绘时沿用视野，避免切筛选时视角乱跳
    mapShown: [],     // 当前列表里画在地图上的那批分馆（手机全屏地图用同一批）
    spotRecenter: false, // 用户刚点过定位：下一次画地图要以「我」为中心（见 drawMap）
    asideMin: false,  // 书架列是否收起（收起后留一条竖 rail 当入口，记在 localStorage）
    // 上图版本查询（/api/editions）的内存缓存：键是 't:<书名>' 或 'i:<isbn>'，
    // 值 { at, data, busy, err }。搜索联想、手动加书、书架的后台预热、结果页其他版本共用一份
    editions: {},
    verQueued: {},    // 已经排进后台版本检查的检索键，避免同一本书反复排队
    // 渐进披露的两处展开态（都不落盘，刷新即回收）：
    //   versOpen: 书 id -> 是否展开「本书其他版本」列表（默认收起，只留一行「N 个」）
    //   footOpen: 馆名 -> 是否展开卡片第三行（索书号 / 库室）
    versOpen: {},
    footOpen: {},
    lanInfo: null     // /api/lan-qr 的最近结果：设置面板的开关和二维码都按它画
  };

  // ---------------------------------------------------------------- 工具

  function $(id) { return document.getElementById(id); }

  // 模态里的可聚焦元素。offsetParent 为 null 的（hidden 的下拉菜单、被 CSS 藏起来的分支）
  // 不算，否则 Tab 会掉进看不见的节点里
  function focusables(root) {
    var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(root.querySelectorAll(sel), function (el) {
      return el.offsetParent !== null;
    });
  }

  // 把 Tab 圈在模态里：焦点在最后一个再按 Tab 回第一个，Shift+Tab 反之
  function trapTab(root, e) {
    if (e.key !== 'Tab') return;
    var list = focusables(root);
    if (!list.length) { e.preventDefault(); return; }
    var first = list[0], last = list[list.length - 1];
    var active = document.activeElement;
    if (!root.contains(active) || active === root) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // 关掉模态后把焦点还给打开它的那颗按钮（键盘用户不能每次都从文档开头找起）
  function restoreFocus(el) {
    if (el && document.contains(el) && el.focus) {
      try { el.focus(); } catch (e) {}
    }
  }

  // 一个豆瓣来源的空状态。豆列和想读各持一份，互不覆盖
  function newListState() {
    return {
      books: [], name: '',
      loading: false,
      more: false,      // 正在抓下一批（「继续加载」）
      empty: false,     // 还没配这个地址（不是「列表是空的」）
      err: '',
      warn: '',         // 非致命提示：豆瓣拦截但旧列表还在
      complete: true,   // 已经抓到自然结尾
      truncated: false, // 撞到安全上限，只载入了前 N 本
      blockedFor: 0     // 豆瓣反爬冷却剩余秒数
    };
  }

  // 书架 = 手动添加 + 豆瓣豆列 + 豆瓣想读。手动添加放前面：
  // 它是刚加进来、正在看的那本，往下滚一次才碰到豆瓣的两组
  function allBooks() {
    return S.manual.concat(S.lists.doulist.books, S.lists.wish.books);
  }

  function findBook(id) {
    var list = allBooks();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // 手动加的书存本机：只留书名/作者/ISBN/封面这些静态字段，不存查询结果
  // （结果里有网点、距离，下次打开位置可能已经变了，重新查更诚实）
  var SHELF_KEY = 'shlib.shelf';
  var SHELF_MAX = 50;

  function loadManual() {
    try {
      var a = JSON.parse(lsGet(SHELF_KEY) || '[]');
      if (!Array.isArray(a)) return [];
      return a.filter(function (b) {
        return b && typeof b.id === 'string' && typeof b.title === 'string';
      }).slice(0, SHELF_MAX).map(function (b) {
        b.adhoc = true;
        return b;
      });
    } catch (e) { return []; }
  }

  function saveManual() {
    lsSet(SHELF_KEY, JSON.stringify(S.manual.slice(0, SHELF_MAX)));
  }

  function compactIsbn(v) {
    return String(v || '').replace(/[\s-]/g, '').toUpperCase();
  }

  // 同一本书：ISBN 相同，或者标题一字不差。豆瓣条目和手动加的书用同一套判重，
  // 免得同一本书在书架上出现两次（一次来自豆列、一次来自手动检索）
  function sameBook(a, b) {
    var ai = compactIsbn(a && a.isbn);
    var bi = compactIsbn(b && b.isbn);
    if (ai && bi) return ai === bi;
    return String((a && a.title) || '').trim() === String((b && b.title) || '').trim();
  }

  function shelfHas(book) {
    var list = allBooks();
    for (var i = 0; i < list.length; i++) if (sameBook(list[i], book)) return list[i];
    return null;
  }

  // 书架里的每一本都要做「本书其他版本」检查：结果只进 editions 缓存，书架行不显示它。
  // 提前查是为了点开那一本时版本列表立刻出来，而不是先转一圈。两路并发，同一检索词只排一次。
  // 查不到就安静留着——结果页要么列出其他版本，要么整块不出现
  var verPaintTimer = null;
  function scheduleBooksPaint() {
    if (verPaintTimer) return;
    verPaintTimer = setTimeout(function () {
      verPaintTimer = null;
      renderBooks();
    }, 200);
  }

  function checkShelfVersions() {
    var todo = [];
    allBooks().forEach(function (b) {
      if (!b || !b.title) return;
      var key = editionKey(b.title, false);
      var st = S.editions[key];
      if (st && (st.busy || (st.data && Date.now() - st.at < ED_TTL))) return;
      if (S.verQueued[key]) return;
      S.verQueued[key] = true;
      todo.push(b);
    });
    if (!todo.length) return;
    var i = 0;
    function next() {
      if (i >= todo.length) return;
      var b = todo[i++];
      fetchEditions(b.title).then(function () {
        // 预热到版本数据就顺手补一次出版社/年份：这一趟本来就为每本书跑，
        // 缺什么在这补，不用等到点开这本书
        if (!b.publisher || !b.year) enrichFromEditions(b);
        scheduleBooksPaint();
      }).catch(function () {}).then(next);
    }
    for (var k = 0; k < ED_CONC; k++) next();
  }

  // 在「手动添加」里加一本并选中。已经有同一本就切过去，不重复添加。
  // 返回 { book, existed } 方便调用方决定要不要提示
  function addBookToShelf(book) {
    var exist = shelfHas(book);
    if (exist) { selectBook(exist.id); return { book: exist, existed: true }; }
    S.manual.unshift(book);
    saveManual();
    S.filter = 'avail';
    S.showAll = false;
    delete S.cache[book.id];
    delete S.results[book.id];
    selectBook(book.id);
    checkShelfVersions();
    return { book: book, existed: false };
  }

  function isIsbnTerm(v) {
    return /^(97[89])?\d{9}[\dXx]$/.test(compactIsbn(v));
  }

  // 版本查询统一走这里：先看内存缓存，没有（或过期）才回服务端。
  // 同名并发请求共用同一个 promise——搜索联想每敲一个字都可能触发一次，
  // 不合并的话同一个书名会同时飞出去好几趟。
  function editionKey(term, byIsbn) {
    var t = String(term || '').trim();
    return (byIsbn ? 'i:' : 't:') + (byIsbn ? compactIsbn(t) : t);
  }

  function fetchEditions(term, force) {
    var q = String(term || '').trim();
    if (!q) return Promise.reject(new Error('缺少检索词'));
    var byIsbn = isIsbnTerm(q);
    var key = editionKey(q, byIsbn);
    var cur = S.editions[key];
    if (!force && cur && cur.busy && cur.p) return cur.p;
    if (!force && cur && cur.data && Date.now() - cur.at < ED_TTL) return Promise.resolve(cur.data);
    // 旧服务端没有这个接口：说清楚要重启，别让搜索联想到处报服务端的 404
    if (S.cfg && S.cfg.features && !S.cfg.features.editions) {
      return Promise.reject(new Error('本地服务是旧进程，版本查询要重启服务'));
    }
    var st = {
      at: cur ? cur.at : 0,
      data: cur && cur.data,
      busy: true,
      err: '',
      p: null
    };
    st.p = apiGet('/api/editions?q=' + encodeURIComponent(byIsbn ? compactIsbn(q) : q), 30000)
      .then(function (d) {
        st.at = Date.now();
        st.data = d;
        st.busy = false;
        st.p = null;
        return d;
      }).catch(function (e) {
        st.busy = false;
        st.err = e.message || '查询失败';
        st.p = null;
        throw e;
      });
    S.editions[key] = st;
    return st.p;
  }

  // 同名版本：服务端按书名做前缀匹配，same=false 的是检索顺带命中的别的书
  function sameEditions(data) {
    return ((data && data.editions) || []).filter(function (e) {
      return e.isbn && e.same;
    });
  }

  function applyEdition(book, e) {
    if (!book || !e) return;
    // 上图记录的题名是「正题名 = 并列题名」，作者是编目格式（中英文名各一遍）。整段套上去
    // 会把豆瓣的短书名换成长题名——只补空缺：书名还只是 ISBN 或为空时才用上图正式题名
    var titleIsCode = !book.title || book.title === book.isbn ||
      /^(97[89])?\d{9}[\dXx]$/.test(compactIsbn(book.title));
    if (e.title && titleIsCode) book.title = e.title;
    if (e.author && !book.author) book.author = e.author;
    if (e.publisher && !book.publisher) book.publisher = e.publisher;
    if (e.year && !book.year) book.year = e.year;
    if (e.isbn) book.isbn = compactIsbn(e.isbn);
    if (book.adhoc) saveManual();
  }

  // 选定一个上图版本 → 按它的 ISBN 加进「手动添加」并查询。
  // 书的身份信息（作者/出版社/年份）一并有，书架两组才能用同一套行样式
  function addEditionBook(e) {
    var isbn = compactIsbn(e && e.isbn);
    if (!isbn) {
      toast('这个版本没有 ISBN，不能按版本查馆藏', 'err');
      return null;
    }
    var r = addBookToShelf({
      id: 'q:' + isbn,
      title: (e.title || '').trim() || ('ISBN ' + isbn),
      isbn: isbn,
      author: e.author || '',
      publisher: e.publisher || '',
      year: e.year || '',
      adhoc: true
    });
    if (r && r.existed) toast('书架里已经有这本，已切换过去');
    else if (r) toast('已加到书架，正在查这一版…', 'ok');
    return r;
  }

  // 缺出版社/年份、或者书名还是那串 ISBN 的书：从版本数据里补一次。
  // 老写法在请求在途时直接 return（if (st && st.busy) return;），跳过的那一次没人再补，
  // 于是《小团圆》那一行永远空着——虽然本地缓存里它的每个版本都带着出版社和年份。
  // 现在挂在同一个在途 promise 上（fetchEditions 会复用，不会多打一次），数据一到就补。
  // 手动加的书顺带落盘；豆瓣书单每次重抓，改内存里的对象就够渲染。
  function enrichFromEditions(book) {
    if (!book || !(book.isbn || book.title)) return;
    var titleIsCode = !book.title ||
      /^(97[89])?\d{9}[\dXx]$/.test(compactIsbn(book.title));
    if (!titleIsCode && book.publisher && book.year) return;
    var term = book.isbn || book.title;
    fetchEditions(term).catch(function () { return null; }).then(function () {
      applyEditionToBook(book, titleIsCode);
    });
  }

  // 从这一版的数据里把缺的字段补上：按 ISBN 认版本，没有 ISBN 只认同名版本
  // （same=false 的是检索顺带命中的别的书，拿它的出版社填过来是错上加错）
  function applyEditionToBook(book, titleIsCode) {
    var st = S.editions[editionKey(book.isbn || book.title, !!book.isbn)];
    var list = (st && st.data && st.data.editions) || [];
    var e = null, i;
    if (book.isbn) {
      for (i = 0; i < list.length; i++) {
        if (compactIsbn(list[i].isbn) === compactIsbn(book.isbn)) { e = list[i]; break; }
      }
    }
    if (!e) e = sameEditions(st.data)[0] || null;
    if (!e) return;
    var changed = false;
    // 只填「只 ISBN 那本」的书名：豆瓣书单的书名是书单页自己给的，不该被覆盖
    if (titleIsCode && book.adhoc && e.title && book.title !== e.title) {
      book.title = e.title; changed = true;
    }
    if (e.author && !book.author) { book.author = e.author; changed = true; }
    if (e.publisher && !book.publisher) { book.publisher = e.publisher; changed = true; }
    if (e.year && !book.year) { book.year = e.year; changed = true; }
    if (!changed) return;
    if (book.adhoc) saveManual();
    renderBooks();
  }

  // 出版社那一栏的文案：有就写「出版社 年份」，补不到才明说「出版信息不详」。
  // 后台那次版本查询还在路上时先留白——这会儿还不知道到底缺不缺，闪一句假的缺失更坑
  function imprintText(book) {
    if (book.publisher) return esc(book.publisher) + (book.year ? ' ' + esc(book.year) : '');
    if (book.year) return esc(book.year);
    var st = S.editions[editionKey(book.isbn || book.title, !!book.isbn)];
    if (!st || st.busy) return '';
    return '出版信息不详';
  }

  function removeManual(id) {
    var i = -1;
    for (var k = 0; k < S.manual.length; k++) if (S.manual[k].id === id) { i = k; break; }
    if (i < 0) return;
    var book = S.manual[i];
    S.manual.splice(i, 1);
    saveManual();
    delete S.cache[id];
    delete S.results[id];
    delete S.busy[id];
    if (S.activeId === id) {
      var next = allBooks()[0];
      S.activeId = null;
      if (next) selectBook(next.id);
      else { renderBooks(); renderResultShell(); }
    } else {
      renderBooks();
    }
    toast('已从书架移除《' + book.title + '》', 'ok');
  }

  // ---------------------------------------------------------------- 外观

  // 亮色/暗色只切 html[data-theme]，具体配色全在 style.css 的变量里
  function applyTheme(t, persist) {
    document.documentElement.setAttribute('data-theme', t);
    if (persist !== false) lsSet('shlib.theme', t);
    // 头部那颗开关：图标画的是「现在是什么」，tooltip 说的是「点了会变成什么」。
    var tb = $('themeBtn');
    if (tb) {
      var dark = t === 'dark';
      tb.innerHTML = icon(dark ? 'moon' : 'sun');
      tb.title = dark ? '切换亮色' : '切换暗色';
      tb.setAttribute('aria-label', tb.title);
      tb.setAttribute('aria-pressed', dark ? 'true' : 'false');
    }
    // 地图瓦片跟着换：高德自带暗色样式，比 CSS 反转干净
    if (MAP && MAP.setMapStyle) {
      try { MAP.setMapStyle(mapStyleNow()); } catch (e) {}
    }
  }

  // 头部那颗钮：亮↔暗来回翻。设置面板里的两段式开关仍然保留，两处都走 applyTheme
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // 选中项在 .seg 里的布局坐标（相对 padding box，和 .seg-thumb 的 left:0 同源）。
  // 用 offset* 而不是 getBoundingClientRect：设置面板淡入时 .box 还带着 scale(.97)，
  // 矩形会被缩放，布局值不会
  function segOnPos(seg) {
    var on = seg && seg.querySelector('button.on');
    return on ? { x: on.offsetLeft, w: on.offsetWidth } : null;
  }

  function placeSegThumb(seg) {
    var t = segOnPos(seg);
    if (!t) return;
    var thumb = seg.querySelector('.seg-thumb');
    thumb.style.transition = 'none';
    thumb.style.transform = 'translateX(' + t.x + 'px)';
    thumb.style.width = t.w + 'px';
    void thumb.offsetWidth;   // 把「无过渡」这一帧落下去，后面才有得动
    thumb.style.transition = '';
    seg.classList.add('thumb-ready');
  }

  // from 是切状态前量下的 {x, w}。整块重绘换了新节点也能直接复用：
  // 新旧 .seg 尺寸和位置一致，坐标同源
  function slideSegThumb(seg, from) {
    if (!seg) return;
    var t = segOnPos(seg);
    if (!t) return;
    if (!from || prefersReducedMotion()) { placeSegThumb(seg); return; }
    var thumb = seg.querySelector('.seg-thumb');
    seg.classList.add('thumb-ready');
    thumb.style.transition = 'none';
    thumb.style.transform = 'translateX(' + from.x + 'px)';
    thumb.style.width = from.w + 'px';
    void thumb.offsetWidth;
    thumb.style.transition = '';
    thumb.style.transform = 'translateX(' + t.x + 'px)';
    thumb.style.width = t.w + 'px';
  }

  // 设置面板里「默认展开地图」两段开关的高亮，跟主题开关一个套路。
  // 这开关和工具栏那颗地图钮、localStorage 的 shlib.map 是同一个值：
  // 面板里点是「改默认并立刻生效」，工具栏点是「临时折叠」（也会记住）
  function syncMapSeg(on, animate) {
    var seg = $('mapSeg');
    if (!seg) return;
    var from = animate !== false ? segOnPos(seg) : null;
    Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', (b.getAttribute('data-map-val') === '1') === !!on);
    });
    if (from) slideSegThumb(seg, from);
    else placeSegThumb(seg);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 电话号码 → tel: 链接用的纯数字。数据里存的是「021-62530932」也有光秃秃的 8 位
  // （上海固话去掉区号的那种），后者直接拨是拨不出去的——8 位一律补 021，
  // 这个工具只服务上海地区的馆（项目范围就是上海图书馆体系）
  function dialNo(tel) {
    var d = String(tel || '').replace(/[^0-9+]/g, '');
    if (/^\d{8}$/.test(d)) d = '021' + d;
    return d;
  }

  function nowTime() {
    var d = new Date();
    function p(n) { return ('0' + n).slice(-2); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // 馆藏页最多会被服务端缓存 12 小时：一进来就命中缓存时，页面以前写的是「刚刚抓取」，
  // 实际可能是昨天下午的数据。这里按服务端给的 X-Data-At 说真实时间。
  // 超过 30 分钟就算旧（快照可能已经不准），结果区会额外给一条带「重新查询」的提示。
  var STALE_MS = 30 * 60 * 1000;

  function dataStamp(meta) {
    var at = (meta && meta.dataAt) || 0;
    if (!at) {
      // 老服务端没有 X-Data-At：退回原来的完成时间，至少别把提交流程弄坏
      return { text: ((meta && meta.fetchedAt) || '') + ' 抓取', age: '', stale: false, known: false };
    }
    var d = new Date(at);
    var now = new Date();
    function p(n) { return ('0' + n).slice(-2); }
    var mins = Math.max(0, Math.floor((Date.now() - at) / 60000));
    var hm = p(d.getHours()) + ':' + p(d.getMinutes());
    var day = d.toDateString() === now.toDateString()
      ? '' : (d.getMonth() + 1) + '-' + d.getDate() + ' ';
    var age = mins < 1 ? '刚刚'
      : mins < 60 ? mins + ' 分钟前'
      : mins < 48 * 60 ? Math.floor(mins / 60) + ' 小时前'
      : Math.floor(mins / 1440) + ' 天前';
    return { text: '数据 ' + day + hm + ' · ' + age, age: age, stale: mins * 60000 >= STALE_MS, known: true };
  }

  // 封面：豆瓣的平面封面优先，上图 /Cover/Show 当兜底。
  // 上图那个接口给的是立体书模（同一个版本两张都有时，立体的显小、还带假透视），
  // 而书单抓下来时豆瓣的平面图地址已经攥在手里了，用它不用再多打一次上游。
  // 豆瓣有防盗链（无 Referer 返 418 占位图），所以只能由本地 /api/cover 代取：
  // 服务端内存留一份、响应带 Cache-Control 让浏览器留一天，同一张图一天最多打豆瓣一次。
  function coverURL(u) {
    if (!u) return '';
    return '/api/cover?u=' + encodeURIComponent(u.replace('/view/subject/l/', '/view/subject/m/'));
  }

  function shlCoverURL(instanceId) {
    return API + '/Cover/Show?instanceId=' + encodeURIComponent(instanceId);
  }

  // 取图失败先换回落地址（上图立体图），再不行换占位块，别留一个破图标
  function coverTag(u, cls, alt, shlId) {
    var src = u ? coverURL(u) : (shlId ? shlCoverURL(shlId) : '');
    if (!src) return '<div class="' + cls + ' ph">无封面</div>';
    var altSrc = (u && shlId) ? shlCoverURL(shlId) : '';
    return '<img class="' + cls + '" src="' + esc(src) + '" alt="' + esc(alt || '') +
      '" loading="lazy" data-fallback="' + cls + '"' +
      (altSrc ? ' data-alt="' + esc(altSrc) + '"' : '') + '>';
  }

  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.getAttribute('data-fallback')) return;
    var alt = img.getAttribute('data-alt');
    if (alt) {
      img.removeAttribute('data-alt');
      img.src = alt;
      return;
    }
    var d = document.createElement('div');
    d.className = img.getAttribute('data-fallback') + ' ph';
    d.textContent = '无封面';
    if (img.parentNode) img.parentNode.replaceChild(d, img);
  }, true);

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('toast');
    // 先摆好播报属性再写文字：部分读屏只在文本变化时读一次，
    // 顺序反了会按上一次的 role/live 播
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
    el.className = 'show' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, kind === 'err' ? 5200 : 3400);
  }

  // 所有请求统一带超时（默认 15 秒）。
  // 为什么必须有：本地服务被关掉、笔记本合盖唤醒、上图长连接挂住时，fetch 既不 resolve 也不 reject，
  // S.busy[id] 就永远清不掉——封面一直转圈、「重新查询」按钮一直禁用，只能刷新页面。
  // 超时靠 AbortController 触发，于是 promise 一定会 settle，catch 里的清理就一定会跑到。
  var REQ_TIMEOUT = 15000;

  function fetchT(url, opt, ms) {
    if (!window.AbortController) return fetch(url, opt);
    var ac = new window.AbortController();
    var o = {};
    if (opt) { for (var k in opt) { if (Object.prototype.hasOwnProperty.call(opt, k)) o[k] = opt[k]; } }
    o.signal = ac.signal;
    var t = setTimeout(function () { try { ac.abort(); } catch (e) {} }, ms || REQ_TIMEOUT);
    var p = fetch(url, o);
    var done = function () { clearTimeout(t); };
    p.then(done, done);
    return p;
  }

  function apiGet(path, ms) {
    return fetchT(path, null, ms).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          // code 是服务端给机读错误码（outOfShanghai / needKey），文案照旧走 message
          var e = new Error(j.error || ('HTTP ' + r.status));
          e.code = j.code || '';
          // 豆瓣反爬冷却：页面要按秒数决定是否还显示「重试 / 继续加载」
          e.blockedFor = j.blockedFor || 0;
          throw e;
        }
        return j;
      });
    });
  }

  function apiPost(path, body) {
    return fetchT(path, {
      method: 'POST',
      // X-Shlib-Write 是服务端的 CSRF 门槛：跨站表单带不上自定义头，
      // 跨站 fetch 带它要先过预检，而本地服务根本不回预检。
      headers: { 'Content-Type': 'application/json', 'X-Shlib-Write': '1' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var err = new Error(j.error || ('HTTP ' + r.status));
          // 服务端会把校验失败的字段名带回来（见 server.py 的 api_save_config），
          // 调用方据此把那一格标红
          if (j.field) err.field = j.field;
          throw err;
        }
        return j;
      });
    });
  }

  // ---------------------------------------------------------------- 本机存储
  //
  // 全站只有一个地方碰 localStorage，就是为了让「便携模式」能一句话关掉它。
  // 便携模式下所有读写都是空操作：不留位置、不留主题、不留面板开合。
  // 正常本机运行时行为完全不变。

  var LS_KEYS = ['shlib.spot', 'shlib.map', 'shlib.aside', 'shlib.theme', 'shlib.hist',
    'shlib.covtips', 'shlib.addrs', 'shlib.shelf', 'shlib.groups'];

  function lsGet(k) {
    if (S.nostore) return null;
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }

  function lsSet(k, v) {
    if (S.nostore) return;
    try { localStorage.setItem(k, v); } catch (e) {}
  }

  // 便携模式启动时把历史上可能留下的痕迹扫一遍（同一台机器以前跑过正常版就会有）
  function purgeLocal() {
    try {
      for (var i = 0; i < LS_KEYS.length; i++) localStorage.removeItem(LS_KEYS[i]);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- 位置

  // opts.recenter = true：这次是用户主动点的定位，地图要跟着人走（见 drawMap 的取景分支）
  function setSpot(spot, opts) {
    S.spot = spot;
    if (opts && opts.recenter) S.spotRecenter = true;
    lsSet('shlib.spot', JSON.stringify(spot));
    // 位置变了，旧视野（中心/缩放）就是上个位置的遗产：不清掉的话 drawMap 沿用
    // keep 的中心，地图看着「没刷新」——人已经挪走了，图还停在原地
    S.mapView = null;
    renderLoc();
    if (S.activeId) renderResult();
  }

  // 顶栏是图标按钮，说明文字放在 title / aria-label 里（别改 textContent，会把图标冲掉）
  function setBtnLabel(btn, text, brief) {
    btn.title = text;
    btn.setAttribute('aria-label', text);
    // 按钮里有可见文字时（设置面板里的「写入」）也一起换掉；详细的（带路径/报错）只放 title
    var lbl = btn.querySelector ? btn.querySelector('.lbl') : null;
    if (lbl) lbl.textContent = brief || text;
  }

  function renderLoc() {
    var box = $('loc');
    var txt = $('locTxt');
    if (S.spot) {
      box.classList.add('on');
      txt.textContent = S.spot.src === 'geo' ? '当前位置（已定位）' : S.spot.label;
      setBtnLabel($('geoBtn'), '重新定位');
      box.title = '点击更改位置';
    } else {
      box.classList.remove('on');
      txt.textContent = '尚未定位';
      setBtnLabel($('geoBtn'), '定位');
      box.title = '点击填写地址';
    }
  }

  // 浏览器只在「安全上下文」里给定位：https，或者 localhost / 127.0.0.1。
  // 手机通过局域网 IP（http://192.168.x.x:8765）打开时不算安全上下文，geolocation 直接被拒，
  // 不先判掉的话要白等 8 秒超时，手机上还什么提示都没有
  function canGeo() {
    if (!navigator.geolocation) return false;
    return !!window.isSecureContext;
  }

  function tryGeo() {
    if (!canGeo()) {
      var why = navigator.geolocation ? '这个地址是 http，浏览器不给定位（要 https）' : '这个浏览器不支持定位';
      toast(why + '，改填地址', 'err');
      openAddr();
      return;
    }
    $('geoBtn').disabled = true;
    $('geoBtn').classList.add('busy');
    setBtnLabel($('geoBtn'), '定位中…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      // 浏览器给 WGS-84，统一转成 GCJ-02 再和网点比
      var g = SHLIB.wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude);
      setSpot({ lat: g[1], lng: g[0], label: '当前位置', src: 'geo' }, { recenter: true });
      $('geoBtn').disabled = false;
      $('geoBtn').classList.remove('busy');
      renderLoc();
      toast('定位成功，结果已按距离排序', 'ok');
    }, function (err) {
      $('geoBtn').disabled = false;
      $('geoBtn').classList.remove('busy');
      renderLoc();
      var why = err.code === 1 ? '浏览器拒绝了定位权限' : (err.code === 3 ? '定位超时' : '定位失败');
      toast(why + '，请手动填地址', 'err');
      openAddr();
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  }

  // 地址对话框：跟设置面板共用一套模态语言。原生 prompt 在内嵌浏览器里会被拦掉，
  // 点了像没反应；这里自己画，输入、回车、Esc、点遮罩都有出口
  var addrSeq = 0;
  var addrReturnFocus = null;
  var ADDR_MAX = 3;
  // 地址框的原句只在这里写一份：index.html 的 #addrHint 留空，由 openAddr 填。
  // 之前 HTML 和 JS 各写一句，打开就被覆盖，「只认上海」那句实际永远看不到
  var ADDR_HINT = '只认上海境内的位置，输入后按回车设位置';

  // 手填过的地址：手机局域网下拿不到定位，每次都要重新敲一整条地址太麻烦。
  // 只存地名+坐标，最多 3 条；便携模式（nostore）下 lsGet/lsSet 自动变成空操作。
  function getAddrs() {
    try {
      var list = JSON.parse(lsGet('shlib.addrs') || '[]');
      return Array.isArray(list) ? list.filter(function (a) {
        return a && typeof a.label === 'string' && isFinite(a.lat) && isFinite(a.lng);
      }) : [];
    } catch (e) { return []; }
  }

  function rememberAddr(label, lat, lng) {
    var list = getAddrs().filter(function (a) { return a.label !== label; });
    list.unshift({ label: label, lat: lat, lng: lng });
    lsSet('shlib.addrs', JSON.stringify(list.slice(0, ADDR_MAX)));
  }

  function renderAddrRecent() {
    var box = $('addrRecent');
    if (!box) return;
    var list = getAddrs();
    box.hidden = !list.length;
    box.innerHTML = !list.length ? '' :
      '<span class="ar-lbl">最近</span>' + list.map(function (a, i) {
        return '<button type="button" class="chip" data-addr="' + i + '">' + esc(a.label) + '</button>';
      }).join('');
  }

  function openAddr() {
    var dlg = $('addrDlg');
    var inp = $('addrInput');
    if (!dlg || !inp) return;
    addrReturnFocus = document.activeElement;
    inp.value = S.spot ? S.spot.label : '';
    $('addrHint').textContent = ADDR_HINT;
    $('addrOk').disabled = false;
    renderAddrRecent();
    dlg.classList.add('show');
    dlg.setAttribute('aria-hidden', 'false');
    inp.focus();
    inp.select();
  }
  function closeAddr() {
    // 关掉就把在途请求作废：取消之后才飞回来的结果不该改位置
    addrSeq++;
    var dlg = $('addrDlg');
    if (dlg) {
      dlg.classList.remove('show');
      dlg.setAttribute('aria-hidden', 'true');
    }
    restoreFocus(addrReturnFocus);
    addrReturnFocus = null;
  }
  function submitAddr() {
    var inp = $('addrInput');
    var v = inp ? inp.value.trim() : '';
    if (!v) { if (inp) inp.focus(); return; }
    var seq = ++addrSeq;
    var ok = $('addrOk');
    var hint = $('addrHint');
    ok.disabled = true;
    hint.textContent = '正在换算位置…';
    apiGet('/api/geocode?q=' + encodeURIComponent(v)).then(function (j) {
      if (seq !== addrSeq) return;
      closeAddr();
      var label = j.label || v;
      rememberAddr(label, j.lat, j.lng);
      setSpot({ lat: j.lat, lng: j.lng, label: label, src: 'addr' }, { recenter: true });
      toast('位置已设为：' + label, 'ok');
    }).catch(function (e) {
      if (seq !== addrSeq) return;
      ok.disabled = false;
      // 位置在上海之外是「明确不给」，服务端已经把话说完了，别再拖一句「要 Key」
      var outOfSh = e.code === 'outOfShanghai';
      var needKey = e.code === 'needKey';
      hint.textContent = outOfSh ? '这个位置不在上海，换一个'
        : needKey ? '还没填 Web 服务 Key，换不成位置'
        : '没查到，换个说法再试';
      // 「没查到」跟 Key 无关，只有真缺 Key 才指出去哪儿填
      toast(e.message + (needKey ? '，在右上角设置里填' : ''), 'err');
    });
  }

  // 手动加书对话框：跟地址框共用 .dlg 那套模态语言（回车、Esc、点遮罩都有出口）。
  // 书名不直接拿去查馆藏：先在上图书目里匹配版本，只有唯一版本才自动继续，
  // 多个版本列出来让用户选，一个都没有就说清楚
  var addReturnFocus = null;
  var addSeq = 0;

  function openAdd() {
    var dlg = $('addDlg');
    var inp = $('addInput');
    if (!dlg || !inp) return;
    addReturnFocus = document.activeElement;
    inp.value = '';
    $('addHint').textContent = '可以输入书名或 ISBN。书名会先列出上图的版本';
    var cands = $('addCands');
    if (cands) { cands.innerHTML = ''; cands.hidden = true; }
    $('addOk').disabled = false;
    dlg.classList.add('show');
    dlg.setAttribute('aria-hidden', 'false');
    inp.focus();
  }

  function closeAdd() {
    // 关掉就把在途的版本匹配作废：取消之后才飞回来的结果不该再弹候选
    addSeq++;
    var dlg = $('addDlg');
    if (dlg) {
      dlg.classList.remove('show');
      dlg.setAttribute('aria-hidden', 'true');
    }
    restoreFocus(addReturnFocus);
    addReturnFocus = null;
  }

  function addCandRowHTML(e) {
    var isbn = compactIsbn(e.isbn);
    var sub = joinSep([e.author, [e.publisher, e.year].filter(Boolean).join(' ')].map(esc));
    return '<button type="button" class="pcand" data-add-isbn="' + esc(isbn) + '"' +
      ' data-add-title="' + esc(e.title || '') + '"' +
      ' data-add-author="' + esc(e.author || '') + '"' +
      ' data-add-pub="' + esc(e.publisher || '') + '"' +
      ' data-add-year="' + esc(e.year || '') + '">' +
      '<span class="pc-t">' + esc(e.title || '（无书名）') + '</span>' +
      '<span class="pc-s">' + (sub || '出版信息不详') +
      (isbn ? SEP + 'ISBN ' + esc(isbn) : '') + '</span>' +
      '<span class="pc-go">查这本' + icon('arrow-right') + '</span></button>';
  }

  function submitAdd() {
    var inp = $('addInput');
    var v = inp ? inp.value.trim() : '';
    if (!v) { if (inp) inp.focus(); return; }
    var hint = $('addHint');
    var cands = $('addCands');
    var ok = $('addOk');

    // ISBN 是唯一标识：不用匹配，直接按这一版查
    if (isIsbnTerm(v)) {
      var isbn = compactIsbn(v);
      closeAdd();
      pushHist(isbn);
      var r = addEditionBook({ isbn: isbn, title: 'ISBN ' + isbn });
      if (r && !r.existed) enrichFromEditions(r.book);
      return;
    }

    var seq = ++addSeq;
    ok.disabled = true;
    hint.textContent = '正在查询上图版本…';
    if (cands) { cands.innerHTML = ''; cands.hidden = true; }
    fetchEditions(v).then(function (d) {
      if (seq !== addSeq) return;
      var same = sameEditions(d);
      if (same.length === 1) {
        closeAdd();
        pushHist(v);
        addEditionBook(same[0]);
        return;
      }
      if (same.length > 1) {
        hint.textContent = '上图有 ' + same.length + ' 个版本，选一个再查';
        if (cands) {
          cands.innerHTML = same.map(addCandRowHTML).join('');
          cands.hidden = false;
        }
        ok.disabled = false;
        return;
      }
      hint.textContent = '上图书目里没有《' + v + '》的同名版本，换个书名或改用 ISBN';
      ok.disabled = false;
    }).catch(function (e) {
      if (seq !== addSeq) return;
      hint.textContent = '查询上图版本失败：' + (e.message || '请稍后重试');
      ok.disabled = false;
    });
  }

  // ---------------------------------------------------------------- 书单

  // 收起/展开书单列。收起时只剩 CSS 里的 .aside-rail 竖条，那上面有个展开箭头
  function setAside(min, persist) {
    S.asideMin = !!min;
    $('main').classList.toggle('aside-min', S.asideMin);
    var btn = $('asideToggle');
    if (btn) setBtnLabel(btn, S.asideMin ? '展开书架' : '收起书架', S.asideMin ? '展开' : '收起');
    if (persist !== false) lsSet('shlib.aside', S.asideMin ? '0' : '1');
    // 列表让出的宽度给了结果区：地图那列要重算高度、高德要重算瓦片，否则右边留一截空白
    sizeMap();
    if (MAP && MAP.resize) { try { MAP.resize(); } catch (e) {} }
  }

  // 一次只抓一个来源的一批。kind='doulist' | 'wish'，两边各记各的进度和错误，
  // 一个被拦截不会把另一个的状态也改掉
  function loadList(kind, refresh, more) {
    var st = S.lists[kind];
    if (!st) return Promise.resolve();
    var noun = kind === 'wish' ? '想读' : '豆列';
    if (more) {
      st.more = true;
    } else {
      st.loading = true;
      st.err = '';
      st.warn = '';
    }
    renderBooks();
    var qs = [];
    if (kind === 'wish') qs.push('source=wish');
    if (more) qs.push('more=1');
    else if (refresh) qs.push('refresh=1');
    // 一批只有一页，但豆瓣偶尔回得很慢：给足 60 秒，默认 15 秒会误杀
    return apiGet('/api/doulist' + (qs.length ? '?' + qs.join('&') : ''), 60000).then(function (j) {
      st.books = j.books || [];
      st.name = j.name || '';
      st.loading = false;
      st.more = false;
      st.err = '';
      // 「没配地址」和「列表是空的」不是一回事：只有后端说 empty 才算没配
      st.empty = j.empty === true;
      st.complete = j.complete !== false;
      st.truncated = !!j.truncated;
      st.blockedFor = j.blockedFor || 0;
      st.warn = st.blockedFor > 0
        ? '豆瓣暂时限制了访问，约 ' +
          Math.max(1, Math.ceil(st.blockedFor / 60)) +
          ' 分钟后可再试。下面是上次抓到的' + noun + '。'
        : '';
    }).catch(function (e) {
      st.loading = false;
      st.more = false;
      st.blockedFor = e.blockedFor || 0;
      if (more && st.books.length) {
        // 继续加载失败：已经载入的书不动，只说这一批没拿到
        st.err = '';
        st.warn = (e.message || '读取失败') +
          ' 已载入的 ' + st.books.length + ' 本不受影响。';
      } else {
        st.err = e.message || '读取失败';
        st.warn = '';
      }
      toast('豆瓣' + noun + '读取失败：' + e.message, 'err');
    }).then(function () {
      renderBooks();
      // 版本检查在书目稳定之后跑：刚打开页面、刚换完地址、刚加载下一批都算
      checkShelfVersions();
      // 当前选中的书还在架上（手动加的、或任一份列表里还有它）就留着；
      // 否则挑第一本。刷新列表不应该把正在看的那本冲掉
      if (!findBook(S.activeId)) {
        var first = allBooks()[0];
        S.activeId = null;
        if (first) selectBook(first.id);
        else renderResultShell();
      } else if (!S.results[S.activeId]) {
        // 列表换了之后旧结果可能对不上，当前这本重新走一遍查询
        selectBook(S.activeId);
      }
    });
  }

  // 豆列和想读同时抓：互不等待，各自先到先画。
  // 不传 refresh 时两边都会用缓存（后端按各自的地址判断），不会额外打豆瓣
  function loadLists(refresh) {
    return Promise.all([loadList('doulist', refresh), loadList('wish', refresh)]);
  }

  // 书架状态全部画在封面上，不落行内文字：allout=印章「都已借出」、inhouse=印章「仅馆内」、
  // norecord=印章「无此版本」。busy 例外（2026-10-26）：查询中不碰封面——查的一定是眼前这本，
  // 结果区那行「正在查上图…」已经把状态说完了，再蒙一层只是把封面挡住
  function bookState(b) {
    var r = S.results[b.id];
    // 查询中封面上不画任何东西（见 coverBox），但这个值还得留着——它负责压掉上一轮的旧印章：
    // 重查一本「都已借出」的书时，新结果还没到，先把上一次的戳挂着就是在报旧账
    if (S.busy[b.id]) return 'busy';
    if (!r) return '';
    if (r.meta.noRecord) return 'norecord';
    // 没有 ISBN 的书先在上图书目里找同名版本，这一步的结果不是馆藏状态：
    // 一个版本都没有 = 上图没有这一版，跟按 ISBN 查不到一样盖「无此版本」；
    // 多个版本等用户选 = 还没查馆藏，什么都不盖（盖「都已借出」是凭空报账）
    if (r.meta.noEdition) return 'norecord';
    if (r.meta.needVersion) return '';
    // 查询失败（接口没响应）不是「都已借出」：不挂灰罩，别把两种状态画成一个样
    if (r.meta.fetchErr) return '';
    // 有可借家数时什么都不显示（数字在结果区筛选条上）
    if (r.meta.availBranches > 0) return '';
    // 可外借册数为 0、但有馆内阅览本：只能进馆看，不是「都已借出」。
    // copyTotal 必须为 0——都已借出但有馆内本的，仍按「都已借出」算
    if (r.meta.copyTotal === 0 && r.meta.inHouseTotal > 0) return 'inhouse';
    return 'allout';
  }

  // 「上图无此 ISBN」文字 chip 已撤（2026-10-20）：无此书也改成封面印章「无此版本」，
  // 三种状态全部上封面、书架行里不再出现任何状态文字（印章见 style.css 的 .stamp）

  // 封面（原先左上角还压一枚「可借 N 家」的角标，2026-10-20 去掉了：
  // 书架是选书的入口，不需要在每本书上再挂一次数字）。
  // state 是查询状态，画成封面遮罩 + 印章：allout/inhouse/norecord = 灰罩 + 一枚戳
  // animate=true 时才给印章挂「盖下去」动画（stamp-anim）；其余书（已查过的、列表里别的书）
  // 静态显示，避免每次重绘所有印章都重播一遍——查询 A 书时 B 书的印章不该动
  function coverBox(u, cls, alt, shlId, state, animate) {
    // busy 在 2026-10-26 从封面上撤了：遮罩加转圈把封面本身盖住，而「正在查」这件事
    // 结果区那行字已经在说。传进来照旧，只是不再画——见 bookState 里那条注释
    if (state === 'busy') state = '';
    // 无可借的三种状态盖一枚印章（参考闲鱼「卖掉了」邮戳）：外借本全部借出 =「都已借出」，
    // 只有馆内阅览本 =「仅馆内」，上图没有这一版的记录 =「无此版本」
    var stamp = state === 'allout' ? '都已借出'
      : (state === 'inhouse' ? '仅馆内'
        : (state === 'norecord' ? '无此版本' : ''));
    // 印章是图形，title 里按状态给一句话（触屏看不到 title，
    // 首次进入那条 toast 是兜底，见 renderBooks 末尾）
    var tip = state === 'allout' ? '各处都已借出'
      : (state === 'inhouse' ? '只有馆内阅览本，不能外借'
        : (state === 'norecord' ? '上图没有这一版的馆藏记录' : ''));
    return '<span class="cov' + (state ? ' ' + state : '') + '"' +
      (tip ? ' title="' + tip + '"' : '') + '>' +
      coverTag(u, cls, alt, shlId) +
      (stamp ? '<i class="stamp' + (animate ? ' stamp-anim' : '') + '">' + stamp + '</i>' : '') + '</span>';
  }

  function shelfHeadHTML(ico, name, n, acts) {
    // 数量贴在最右边、带「本」：三组的标题长得一样，数字挨着组名时会被读成名字的一部分，
    // 靠右后组名是组名、数量是数量，三组扫下来起点和终点都在同两列上
    return '<div class="shelf-grp">' +
      '<span class="sgrp-ico">' + ico + '</span>' +
      '<span class="sgrp-name">' + esc(name) + '</span>' +
      '<span class="spacer"></span>' +
      (n ? '<span class="sgrp-n">' + n + ' 本</span>' : '') +
      (acts || '') + '</div>';
  }

  // 组标题行尾的箭头：收起只影响这一组，别组照常。
  // 用 Lucide 手风琴的语义（ChevronDown 的展开/收起态）：展开时朝上 = 把内容折上去，
  // 收起时朝下 = 内容往下展开；方向就是这一组真实的上下收放，不用横向箭头
  function foldBtn(kind, name) {
    var open = !S.folded[kind];
    var label = (open ? '收起' : '展开') + name;
    return '<button type="button" class="ghost icon-btn sgrp-fold" data-shelf-act="fold" ' +
      'data-field="' + kind + '" aria-expanded="' + (open ? 'true' : 'false') + '" ' +
      'title="' + label + '" aria-label="' + label + '">' +
      icon(open ? 'chevron-up' : 'chevron-down') + '</button>';
  }

  // 一组书的行：封面 + 书名 / 作者·出版社 年份 / ISBN。
  // 手动添加和豆瓣书单共用这一套——两组的书、能力、状态都该长得一样，
  // 只有「移除」是手动添加独有的行内动作。
  // 版本数量不上书架行：它是「这本书有几个版本」的元信息，跟选书无关，
  // 在意它的唯一时刻是点开这本书之后——那时候结果页书名下面就是版本列表。
  function bookRowHTML(b) {
    var sub = joinSep([b.author ? esc(b.author) : '', imprintText(b)].filter(Boolean));
    var isbn = b.isbn ? '<div class="isbn"><span>ISBN ' + esc(b.isbn) + '</span></div>' : '';
    var st = bookState(b);
    var x = b.adhoc
      ? '<button type="button" class="bk-x" data-shelf-remove="' + esc(b.id) + '" ' +
        'title="从书架移除" aria-label="从书架移除《' + esc(b.title) + '》">' + icon('x') + '</button>'
      : '';
    return '<div class="book' + (b.id === S.activeId ? ' active' : '') + (b.adhoc ? ' adhoc' : '') +
      '" data-id="' + esc(b.id) + '">' +
      coverBox(b.cover, 'cover', b.title, b.shlId, st, b.id === S.stampAnimId) +
      '<div class="bk-main"><div class="t">' + esc(b.title) + '</div>' +
      '<div class="s">' + (sub || '—') + '</div>' +
      isbn + '</div>' + x + '</div>';
  }

  function renderBooks() {
    var box = $('bookList');
    if (!box) return;
    var manual = S.manual;
    var dou = S.lists.doulist;
    var wish = S.lists.wish;

    // 同一本书两边都有时只归豆列：想读组不再画一遍，末尾说明还有几本是重复的。
    // 按条目 id 比，不看书名——想读和豆列里的同名书可能是不同版本
    var douIds = {};
    dou.books.forEach(function (b) { douIds[b.id] = 1; });
    var wishBooks = wish.books.filter(function (b) { return !douIds[b.id]; });
    var wishDup = wish.books.length - wishBooks.length;

    var anyLoading = dou.loading || wish.loading;
    var anyErr = dou.err || wish.err;
    // 两组都空、两个地址也都没配：给一块能直接动手的空态，而不是几排光秃秃的组标题
    if (!manual.length && !dou.books.length && !wish.books.length && !anyLoading &&
        !anyErr && dou.empty && wish.empty) {
      box.innerHTML = '<div class="shelf-empty">' +
        '<span class="se-ico">' + icon('library') + '</span>' +
        '<p>书架还是空的</p>' +
        '<div class="se-acts">' +
        '<button type="button" class="primary sm" data-shelf-act="add">手动加书</button>' +
        '<button type="button" class="sm" data-shelf-act="edit">设置豆瓣地址</button>' +
        '</div></div>';
      return;
    }

    var html = '';
    // 手动添加在上：刚加的书不用穿过整份豆瓣列表才找得到
    if (manual.length) {
      var manFold = S.folded.manual;
      html += '<section class="shelf-sec' + (manFold ? ' folded' : '') + '">';
      html += shelfHeadHTML(icon('book-plus'), '手动添加', manual.length, foldBtn('manual', '手动添加'));
      if (!manFold) html += manual.map(bookRowHTML).join('');
      html += '</section>';
    }

    // 豆瓣两组在下。地址没配也照画：组标题 + 一行「尚未设置…去设置」就是填写入口。
    // 以前这一组整个跳过，只在书架全空时露出「设置豆瓣地址」——手动加过一本书之后，
    // 那两个入口就都没了（2026-10-28 用户报）。整块空态在上面已经 return，不会画两排空标题
    function listGroup(kind, st, books, dupNote) {
      var noun = kind === 'wish' ? '想读' : '豆列';
      // 组标题只留收起箭头：地址填一次就不动，日常用不上「改地址」。
      // 填错的时候下面的「去设置」就在手边；平时改地址走设置面板的豆瓣地址一节
      var g = shelfHeadHTML(
        '<img class="dblogo" src="douban-favicon.png" alt="" width="16" height="16">',
        '豆瓣' + noun, books.length,
        foldBtn(kind, '豆瓣' + noun));

      // 收起后组内所有内容都不画：书、加载/错误提示、继续加载、重复说明
      if (S.folded[kind]) { html += '<section class="shelf-sec folded">' + g + '</section>'; return; }

      if (st.loading) {
        g += '<div class="shelf-note"><span class="spin"></span> 正在读豆瓣' + noun + '…</div>';
      } else if (st.err) {
        // 读取失败时旧列表还在：提示挂在上面，列表不撤，别让人以为书全丢了
        g += '<div class="shelf-note err">' + esc(st.err) +
          ' <button type="button" class="linkish" data-shelf-act="refresh" data-field="' + kind +
          '">重试</button></div>';
      } else if (st.warn) {
        // 豆瓣拦截但旧列表还在：书继续用，只把「为什么不是最新的」说清楚
        g += '<div class="shelf-note err">' + esc(st.warn) + '</div>';
      } else if (st.empty) {
        g += '<div class="shelf-note">尚未设置豆瓣' + noun + '。' +
          '<button type="button" class="linkish" data-shelf-act="edit" data-field="' + kind +
          '">去设置</button></div>';
      }
      if (books.length) {
        g += books.map(bookRowHTML).join('');
        // 长列表分批抓：抓完一批先显示，下一批由用户点「继续加载」触发；
        // 冷却中不给按钮，点下去也只会拿回同一句提示
        if (st.more) {
          g += '<div class="shelf-more"><span class="spin"></span> 正在加载更多…</div>';
        } else if (st.truncated) {
          g += '<div class="shelf-more">列表太长，只载入了前 ' + books.length + ' 本。</div>';
        } else if (!st.complete && !st.blockedFor) {
          g += '<div class="shelf-more">已载入 ' + books.length + ' 本。' +
            '<button type="button" class="linkish" data-shelf-act="more" data-field="' + kind +
            '">继续加载</button></div>';
        }
      }
      if (dupNote) g += '<div class="shelf-more">' + dupNote + '</div>';
      // 每组一层 section：组标题要吸顶（见 style.css 的 .shelf-grp），
      // 得有一个只包住本组的容器，标题才会在滚到组末尾时被下一组顶走
      html += '<section class="shelf-sec">' + g + '</section>';
    }

    listGroup('doulist', dou, dou.books, '');
    // 想读里跟豆列重复的那几本没有单独画出来，说一声它们去哪了，免得以为丢了
    listGroup('wish', wish, wishBooks,
      wishDup ? '另有 ' + wishDup + ' 本已在豆列里，不重复列出。' : '');
    // 插入这一帧先关掉 .book 的 background 过渡：这一块是整块重画的，指针底下那本书
    // 每重画一次都会从透明淡到 hover 色，一次进入页面会重画两三次，看着就是「一闪一闪」。
    // 两帧后放开，指针真正移到别的书上时照旧淡入
    box.classList.add('no-anim');
    box.innerHTML = html;
    // 吸顶标题的实底是算出来的（syncShelfPins），新画出来的节点身上还没有 .pin。
    // 等两帧再补的话，正钉在顶上那条会有一帧是透明的，底下的书名直接透上来——
    // 收起/展开恰恰就盯着这条标题看，看着就是它闪了一下。这里先立刻算一次，
    // rAF 里那次留给迟到的高度变化（封面图落地、字体换完）
    syncShelfPins();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { box.classList.remove('no-anim'); syncShelfPins(); });
    });

    // 封面印章第一次见的人看不懂，书架非空时提示一次、之后不再烦。
    // 逐态文案在 .cov 的 title 里，这条只负责告诉用户「有这么几种状态、悬停能看」
    if ((manual.length || dou.books.length || wish.books.length) && !lsGet('shlib.covtips')) {
      lsSet('shlib.covtips', '1');
      toast('封面印章：「都已借出」「仅馆内」「无此版本」是查询结果；查过而没有印章，表示有可借复本');
    }
  }

  // 组标题吸住没有：吸住才铺实底（见 style.css 的 .shelf-grp.pin）。
  // 静止时标题得跟面板连成一片，否则顶上两块实色跟玻璃底对不上；
  // 而 CSS 没有「已经吸住」这个信号，只能按位置自己算
  function syncShelfPins() {
    var box = $('bookList');
    if (!box || !box.clientHeight) return;   // 书单收起来时没有位置可比
    var top = box.getBoundingClientRect().top;
    var gs = box.querySelectorAll('.shelf-grp');
    for (var i = 0; i < gs.length; i++) {
      gs[i].classList.toggle('pin', gs[i].getBoundingClientRect().top <= top + 0.5);
    }
  }

  // 收起 / 展开一组：renderBooks 会换掉整块 bookList。键盘操作要把焦点还给同一组的箭头，
  // 否则焦点掉回页面开头；鼠标点的不还，否则刚点完就多一圈键盘焦点框
  function toggleFold(kind, restoreFocus) {
    if (!S.folded.hasOwnProperty(kind)) return;
    S.folded[kind] = !S.folded[kind];
    lsSet('shlib.groups', JSON.stringify(S.folded));
    renderBooks();
    keepFoldHead(kind);
    if (!restoreFocus) return;
    var btn = $('bookList').querySelector('[data-shelf-act="fold"][data-field="' + kind + '"]');
    if (btn) btn.focus({ preventScroll: true });
  }

  // 收起的这一组在上方、而人正滚在它中间时：整列矮了一大截，浏览器把滚动位置钳到新的
  // 底数，刚点的那条组名会被顶出上边界——收起一个书单，结果连它的标题都找不着了，
  // 想再展开得先往上滚。所以标题一旦落到上边界之外，就把它拉回贴着上边界
  function keepFoldHead(kind) {
    var box = $('bookList');
    var btn = box.querySelector('[data-shelf-act="fold"][data-field="' + kind + '"]');
    // 量 section 而不是标题行：标题是吸顶的，滚过头以后它的矩形永远停在上边界，
    // 看不出该补多少；section 不吸顶，位置就是它在整列里的真实去处
    var sec = btn && btn.closest('.shelf-sec');
    if (!sec) return;
    // section 自己的分隔线和第一组的 8px 上内边距都在标题之上，把它们算进去才是
    // 标题本该待的位置；不然拉回来的结果永远是差一条线的高度、贴不到上边界
    var cs = getComputedStyle(sec);
    var head = sec.getBoundingClientRect().top +
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
    var d = head - box.getBoundingClientRect().top;
    if (d >= 0) return;
    box.scrollTop += d;
    // 滚动位置是代码改的，不会等到下一帧的 scroll 回调才重算底色
    syncShelfPins();
  }

  // ---------------------------------------------------------------- 搜索（推荐 / 匹配 / 记录）

  // 搜索记录存本机：只留最近 8 条，同一条再来就提到最前。
  // 存的是用户敲的原串（不存规范化后的），下次点回来要跟当初看到的一样
  var HIST_KEY = 'shlib.hist';
  var HIST_MAX = 8;
  // 下拉里键盘/鼠标当前停在第几条，-1 表示没有。每次重画下拉都清掉
  var sugAuto = -1;

  function loadHist() {
    try {
      var a = JSON.parse(lsGet(HIST_KEY) || '[]');
      return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' && x; }) : [];
    } catch (e) { return []; }
  }

  function pushHist(term) {
    var t = String(term || '').trim();
    if (!t) return;
    var a = loadHist().filter(function (x) { return x !== t; });
    a.unshift(t);
    lsSet(HIST_KEY, JSON.stringify(a.slice(0, HIST_MAX)));
  }

  function dropHist(term) {
    lsSet(HIST_KEY, JSON.stringify(loadHist().filter(function (x) { return x !== term; })));
  }

  // 一级汉字（GB2312 区 16-55，共 3755 个）本来就是按拼音排的，所以不用查字典：
  // 把这 3755 个字按拼音首字母切成 23 段贴在这，汉字落到哪段就是哪个首字母。
  // 表是按下表的边界从 GB2312 码位直接解出来的（每段首字：啊 八 擦 搭 蛾 发 噶 哈 击 喀 垃
  // 妈 拿 哦 啪 期 然 撒 塌 挖 昔 压 匝），不是我凭记忆排的。
  // 二级汉字（生僻字）在 B 区、按部首排，这里不收：书单就几十本书名，生僻字打全名走子串一样能搜到
  var PY_RUNS = (
    'A:啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘鞍氨安俺按暗岸胺案肮昂盎凹敖熬翱袄傲奥懊澳芭捌扒叭吧笆'
    + 'B:八疤巴拔跋靶把耙坝霸罢爸白柏百摆佰败拜稗斑班搬扳般颁板版扮拌伴瓣半办绊邦帮梆榜膀绑棒磅蚌镑傍谤苞胞包褒剥薄雹保堡饱宝抱报暴豹鲍爆杯碑悲卑北辈背贝钡倍狈备惫焙被奔苯本笨崩绷甭泵蹦迸逼鼻比鄙笔彼碧蓖蔽毕毙毖币庇痹闭敝弊必辟壁臂避陛鞭边编贬扁便变卞辨辩辫遍标彪膘表鳖憋别瘪彬斌濒滨宾摈兵冰柄丙秉饼炳病并玻菠播拨钵波博勃搏铂箔伯帛舶脖膊渤泊驳捕卜哺补埠不布步簿部怖'
    + 'C:擦猜裁材才财睬踩采彩菜蔡餐参蚕残惭惨灿苍舱仓沧藏操糙槽曹草厕策侧册测层蹭插叉茬茶查碴搽察岔差诧拆柴豺搀掺蝉馋谗缠铲产阐颤昌猖场尝常长偿肠厂敞畅唱倡超抄钞朝嘲潮巢吵炒车扯撤掣彻澈郴臣辰尘晨忱沉陈趁衬撑称城橙成呈乘程惩澄诚承逞骋秤吃痴持匙池迟弛驰耻齿侈尺赤翅斥炽充冲虫崇宠抽酬畴踌稠愁筹仇绸瞅丑臭初出橱厨躇锄雏滁除楚础储矗搐触处揣川穿椽传船喘串疮窗幢床闯创吹炊捶锤垂春椿醇唇淳纯蠢戳绰疵茨磁雌辞慈瓷词此刺赐次聪葱囱匆从丛凑粗醋簇促蹿篡窜摧崔催脆瘁粹淬翠村存寸磋撮搓措挫错'
    + 'D:搭达答瘩打大呆歹傣戴带殆代贷袋待逮怠耽担丹单郸掸胆旦氮但惮淡诞弹蛋当挡党荡档刀捣蹈倒岛祷导到稻悼道盗德得的蹬灯登等瞪凳邓堤低滴迪敌笛狄涤翟嫡抵底地蒂第帝弟递缔颠掂滇碘点典靛垫电佃甸店惦奠淀殿碉叼雕凋刁掉吊钓调跌爹碟蝶迭谍叠丁盯叮钉顶鼎锭定订丢东冬董懂动栋侗恫冻洞兜抖斗陡豆逗痘都督毒犊独读堵睹赌杜镀肚度渡妒端短锻段断缎堆兑队对墩吨蹲敦顿囤钝盾遁掇哆多夺垛躲朵跺舵剁惰堕'
    + 'E:蛾峨鹅俄额讹娥恶厄扼遏鄂饿恩而儿耳尔饵洱二贰'
    + 'F:发罚筏伐乏阀法珐藩帆番翻樊矾钒繁凡烦反返范贩犯饭泛坊芳方肪房防妨仿访纺放菲非啡飞肥匪诽吠肺废沸费芬酚吩氛分纷坟焚汾粉奋份忿愤粪丰封枫蜂峰锋风疯烽逢冯缝讽奉凤佛否夫敷肤孵扶拂辐幅氟符伏俘服浮涪福袱弗甫抚辅俯釜斧脯腑府腐赴副覆赋复傅付阜父腹负富讣附妇缚咐'
    + 'G:噶嘎该改概钙盖溉干甘杆柑竿肝赶感秆敢赣冈刚钢缸肛纲岗港杠篙皋高膏羔糕搞镐稿告哥歌搁戈鸽胳疙割革葛格蛤阁隔铬个各给根跟耕更庚羹埂耿梗工攻功恭龚供躬公宫弓巩汞拱贡共钩勾沟苟狗垢构购够辜菇咕箍估沽孤姑鼓古蛊骨谷股故顾固雇刮瓜剐寡挂褂乖拐怪棺关官冠观管馆罐惯灌贯光广逛瑰规圭硅归龟闺轨鬼诡癸桂柜跪贵刽辊滚棍锅郭国果裹过'
    + 'H:哈骸孩海氦亥害骇酣憨邯韩含涵寒函喊罕翰撼捍旱憾悍焊汗汉夯杭航壕嚎豪毫郝好耗号浩呵喝荷菏核禾和何合盒貉阂河涸赫褐鹤贺嘿黑痕很狠恨哼亨横衡恒轰哄烘虹鸿洪宏弘红喉侯猴吼厚候后呼乎忽瑚壶葫胡蝴狐糊湖弧虎唬护互沪户花哗华猾滑画划化话槐徊怀淮坏欢环桓还缓换患唤痪豢焕涣宦幻荒慌黄磺蝗簧皇凰惶煌晃幌恍谎灰挥辉徽恢蛔回毁悔慧卉惠晦贿秽会烩汇讳诲绘荤昏婚魂浑混豁活伙火获或惑霍货祸'
    + 'J:击圾基机畸稽积箕肌饥迹激讥鸡姬绩缉吉极棘辑籍集及急疾汲即嫉级挤几脊己蓟技冀季伎祭剂悸济寄寂计记既忌际妓继纪嘉枷夹佳家加荚颊贾甲钾假稼价架驾嫁歼监坚尖笺间煎兼肩艰奸缄茧检柬碱硷拣捡简俭剪减荐槛鉴践贱见键箭件健舰剑饯渐溅涧建僵姜将浆江疆蒋桨奖讲匠酱降蕉椒礁焦胶交郊浇骄娇嚼搅铰矫侥脚狡角饺缴绞剿教酵轿较叫窖揭接皆秸街阶截劫节桔杰捷睫竭洁结解姐戒藉芥界借介疥诫届巾筋斤金今津襟紧锦仅谨进靳晋禁近烬浸尽劲荆兢茎睛晶鲸京惊精粳经井警景颈静境敬镜径痉靖竟竞净炯窘揪究纠玖韭久灸九酒厩救旧臼舅咎就疚鞠拘狙疽居驹菊局咀矩举沮聚拒据巨具距踞锯俱句惧炬剧捐鹃娟倦眷卷绢撅攫抉掘倔爵觉决诀绝均菌钧军君峻俊竣浚郡骏'
    + 'K:喀咖卡咯开揩楷凯慨刊堪勘坎砍看康慷糠扛抗亢炕考拷烤靠坷苛柯棵磕颗科壳咳可渴克刻客课肯啃垦恳坑吭空恐孔控抠口扣寇枯哭窟苦酷库裤夸垮挎跨胯块筷侩快宽款匡筐狂框矿眶旷况亏盔岿窥葵奎魁傀馈愧溃坤昆捆困括扩廓阔'
    + 'L:垃拉喇蜡腊辣啦莱来赖蓝婪栏拦篮阑兰澜谰揽览懒缆烂滥琅榔狼廊郎朗浪捞劳牢老佬姥酪烙涝勒乐雷镭蕾磊累儡垒擂肋类泪棱楞冷厘梨犁黎篱狸离漓理李里鲤礼莉荔吏栗丽厉励砾历利傈例俐痢立粒沥隶力璃哩俩联莲连镰廉怜涟帘敛脸链恋炼练粮凉梁粱良两辆量晾亮谅撩聊僚疗燎寥辽潦了撂镣廖料列裂烈劣猎琳林磷霖临邻鳞淋凛赁吝拎玲菱零龄铃伶羚凌灵陵岭领另令溜琉榴硫馏留刘瘤流柳六龙聋咙笼窿隆垄拢陇楼娄搂篓漏陋芦卢颅庐炉掳卤虏鲁麓碌露路赂鹿潞禄录陆戮驴吕铝侣旅履屡缕虑氯律率滤绿峦挛孪滦卵乱掠略抡轮伦仑沦纶论萝螺罗逻锣箩骡裸落洛骆络'
    + 'M:妈麻玛码蚂马骂嘛吗埋买麦卖迈脉瞒馒蛮满蔓曼慢漫谩芒茫盲氓忙莽猫茅锚毛矛铆卯茂冒帽貌贸么玫枚梅酶霉煤没眉媒镁每美昧寐妹媚门闷们萌蒙檬盟锰猛梦孟眯醚靡糜迷谜弥米秘觅泌蜜密幂棉眠绵冕免勉娩缅面苗描瞄藐秒渺庙妙蔑灭民抿皿敏悯闽明螟鸣铭名命谬摸摹蘑模膜磨摩魔抹末莫墨默沫漠寞陌谋牟某拇牡亩姆母墓暮幕募慕木目睦牧穆'
    + 'N:拿哪呐钠那娜纳氖乃奶耐奈南男难囊挠脑恼闹淖呢馁内嫩能妮霓倪泥尼拟你匿腻逆溺蔫拈年碾撵捻念娘酿鸟尿捏聂孽啮镊镍涅您柠狞凝宁拧泞牛扭钮纽脓浓农弄奴努怒女暖虐疟挪懦糯诺'
    + 'O:哦欧鸥殴藕呕偶沤'
    + 'P:啪趴爬帕怕琶拍排牌徘湃派攀潘盘磐盼畔判叛乓庞旁耪胖抛咆刨炮袍跑泡呸胚培裴赔陪配佩沛喷盆砰抨烹澎彭蓬棚硼篷膨朋鹏捧碰坯砒霹批披劈琵毗啤脾疲皮匹痞僻屁譬篇偏片骗飘漂瓢票撇瞥拼频贫品聘乒坪苹萍平凭瓶评屏坡泼颇婆破魄迫粕剖扑铺仆莆葡菩蒲埔朴圃普浦谱曝瀑'
    + 'Q:期欺栖戚妻七凄漆柒沏其棋奇歧畦崎脐齐旗祈祁骑起岂乞企启契砌器气迄弃汽泣讫掐恰洽牵扦钎铅千迁签仟谦乾黔钱钳前潜遣浅谴堑嵌欠歉枪呛腔羌墙蔷强抢橇锹敲悄桥瞧乔侨巧鞘撬翘峭俏窍切茄且怯窃钦侵亲秦琴勤芹擒禽寝沁青轻氢倾卿清擎晴氰情顷请庆琼穷秋丘邱球求囚酋泅趋区蛆曲躯屈驱渠取娶龋趣去圈颧权醛泉全痊拳犬券劝缺炔瘸却鹊榷确雀裙群'
    + 'R:然燃冉染瓤壤攘嚷让饶扰绕惹热壬仁人忍韧任认刃妊纫扔仍日戎茸蓉荣融熔溶容绒冗揉柔肉茹蠕儒孺如辱乳汝入褥软阮蕊瑞锐闰润若弱'
    + 'S:撒洒萨腮鳃塞赛三叁伞散桑嗓丧搔骚扫嫂瑟色涩森僧莎砂杀刹沙纱傻啥煞筛晒珊苫杉山删煽衫闪陕擅赡膳善汕扇缮墒伤商赏晌上尚裳梢捎稍烧芍勺韶少哨邵绍奢赊蛇舌舍赦摄射慑涉社设砷申呻伸身深娠绅神沈审婶甚肾慎渗声生甥牲升绳省盛剩胜圣师失狮施湿诗尸虱十石拾时什食蚀实识史矢使屎驶始式示士世柿事拭誓逝势是嗜噬适仕侍释饰氏市恃室视试收手首守寿授售受瘦兽蔬枢梳殊抒输叔舒淑疏书赎孰熟薯暑曙署蜀黍鼠属术述树束戍竖墅庶数漱恕刷耍摔衰甩帅栓拴霜双爽谁水睡税吮瞬顺舜说硕朔烁斯撕嘶思私司丝死肆寺嗣四伺似饲巳松耸怂颂送宋讼诵搜艘擞嗽苏酥俗素速粟僳塑溯宿诉肃酸蒜算虽隋随绥髓碎岁穗遂隧祟孙损笋蓑梭唆缩琐索锁所'
    + 'T:塌他它她塔獭挞蹋踏胎苔抬台泰酞太态汰坍摊贪瘫滩坛檀痰潭谭谈坦毯袒碳探叹炭汤塘搪堂棠膛唐糖倘躺淌趟烫掏涛滔绦萄桃逃淘陶讨套特藤腾疼誊梯剔踢锑提题蹄啼体替嚏惕涕剃屉天添填田甜恬舔腆挑条迢眺跳贴铁帖厅听烃汀廷停亭庭挺艇通桐酮瞳同铜彤童桶捅筒统痛偷投头透凸秃突图徒途涂屠土吐兔湍团推颓腿蜕褪退吞屯臀拖托脱鸵陀驮驼椭妥拓唾'
    + 'W:挖哇蛙洼娃瓦袜歪外豌弯湾玩顽丸烷完碗挽晚皖惋宛婉万腕汪王亡枉网往旺望忘妄威巍微危韦违桅围唯惟为潍维苇萎委伟伪尾纬未蔚味畏胃喂魏位渭谓尉慰卫瘟温蚊文闻纹吻稳紊问嗡翁瓮挝蜗涡窝我斡卧握沃巫呜钨乌污诬屋无芜梧吾吴毋武五捂午舞伍侮坞戊雾晤物勿务悟误'
    + 'X:昔熙析西硒矽晰嘻吸锡牺稀息希悉膝夕惜熄烯溪汐犀檄袭席习媳喜铣洗系隙戏细瞎虾匣霞辖暇峡侠狭下厦夏吓掀锨先仙鲜纤咸贤衔舷闲涎弦嫌显险现献县腺馅羡宪陷限线相厢镶香箱襄湘乡翔祥详想响享项巷橡像向象萧硝霄削哮嚣销消宵淆晓小孝校肖啸笑效楔些歇蝎鞋协挟携邪斜胁谐写械卸蟹懈泄泻谢屑薪芯锌欣辛新忻心信衅星腥猩惺兴刑型形邢行醒幸杏性姓兄凶胸匈汹雄熊休修羞朽嗅锈秀袖绣墟戌需虚嘘须徐许蓄酗叙旭序畜恤絮婿绪续轩喧宣悬旋玄选癣眩绚靴薛学穴雪血勋熏循旬询寻驯巡殉汛训讯逊迅'
    + 'Y:压押鸦鸭呀丫芽牙蚜崖衙涯雅哑亚讶焉咽阉烟淹盐严研蜒岩延言颜阎炎沿奄掩眼衍演艳堰燕厌砚雁唁彦焰宴谚验殃央鸯秧杨扬佯疡羊洋阳氧仰痒养样漾邀腰妖瑶摇尧遥窑谣姚咬舀药要耀椰噎耶爷野冶也页掖业叶曳腋夜液一壹医揖铱依伊衣颐夷遗移仪胰疑沂宜姨彝椅蚁倚已乙矣以艺抑易邑屹亿役臆逸肄疫亦裔意毅忆义益溢诣议谊译异翼翌绎茵荫因殷音阴姻吟银淫寅饮尹引隐印英樱婴鹰应缨莹萤营荧蝇迎赢盈影颖硬映哟拥佣臃痈庸雍踊蛹咏泳涌永恿勇用幽优悠忧尤由邮铀犹油游酉有友右佑釉诱又幼迂淤于盂榆虞愚舆余俞逾鱼愉渝渔隅予娱雨与屿禹宇语羽玉域芋郁吁遇喻峪御愈欲狱育誉浴寓裕预豫驭鸳渊冤元垣袁原援辕园员圆猿源缘远苑愿怨院曰约越跃钥岳粤月悦阅耘云郧匀陨允运蕴酝晕韵孕'
    + 'Z:匝砸杂栽哉灾宰载再在咱攒暂赞赃脏葬遭糟凿藻枣早澡蚤躁噪造皂灶燥责择则泽贼怎增憎曾赠扎喳渣札轧铡闸眨栅榨咋乍炸诈摘斋宅窄债寨瞻毡詹粘沾盏斩辗崭展蘸栈占战站湛绽樟章彰漳张掌涨杖丈帐账仗胀瘴障招昭找沼赵照罩兆肇召遮折哲蛰辙者锗蔗这浙珍斟真甄砧臻贞针侦枕疹诊震振镇阵蒸挣睁征狰争怔整拯正政帧症郑证芝枝支吱蜘知肢脂汁之织职直植殖执值侄址指止趾只旨纸志挚掷至致置帜峙制智秩稚质炙痔滞治窒中盅忠钟衷终种肿重仲众舟周州洲诌粥轴肘帚咒皱宙昼骤珠株蛛朱猪诸诛逐竹烛煮拄瞩嘱主著柱助蛀贮铸筑住注祝驻抓爪拽专砖转撰赚篆桩庄装妆撞壮状椎锥追赘坠缀谆准捉拙卓桌琢茁酌啄着灼浊兹咨资姿滋淄孜紫仔籽滓子自渍字鬃棕踪宗综总纵邹走奏揍租足卒族祖诅阻组钻纂嘴醉最罪尊遵昨左佐柞做作坐座'
  );
  // 汉字 → 拼音首字母。用 codePointAt 跟数组下标对齐（全是基本区字符，1 个 UTF-16 单元）
  var PY_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';   // 拼音里没有 I / U / V 开头的音节
  // 按「标签:字串」逐段读，标签自己带着字母——不靠数组下标去猜是哪一段，
  // 少一段、多一段都不会把后面的字母整体错位
  var PY_MAP = (function () {
    var m = {};
    var re = /([A-Z]):([^A-Z]*)/g;
    var one;
    while ((one = re.exec(PY_RUNS))) {
      var letter = one[1].toLowerCase();
      var chunk = one[2];
      for (var k = 0; k < chunk.length; k++) m[chunk.charAt(k)] = letter;
    }
    return m;
  })();

  // 书名 → 首字母串：汉字查表，英文/数字取首字母，其余当分隔。
  // 「社会心理学」→ SHXLX，敲 shxlx 就能搜到
  function initials(s) {
    var out = '';
    String(s || '').toLowerCase().replace(/[\s·・:：,，.。、()（）\[\]【】\-—_!！?？'"“”]+/g, ' ')
      .split(' ').forEach(function (w) {
        if (!w) return;
        if (/^[a-z0-9]/.test(w)) out += w.charAt(0);
        else {
          for (var i = 0; i < w.length; i++) {
            var c = PY_MAP[w.charAt(i)];
            if (c) out += c.toLowerCase();
          }
        }
      });
    return out;
  }

  // 打分：同一本书可能命中好几种（既是前缀、ISBN 又含子串），取最高那档
  function scoreBook(b, q) {
    var ql = q.toLowerCase();
    var qc = q.replace(/[\s-]/g, '');
    var title = String(b.title || '');
    var tl = title.toLowerCase();
    var isbn = String(b.isbn || '').replace(/[\s-]/g, '');
    var s = 0;
    if (isbn && isbn === qc) return 100;
    if (tl === ql) return 95;
    if (tl.indexOf(ql) === 0) s = 88;
    else if (tl.indexOf(ql) > 0) s = 78;
    if (isbn && qc && isbn.indexOf(qc) !== -1 && s < 70) s = 70;
    var author = String(b.author || '').toLowerCase();
    if (author && author.indexOf(ql) !== -1 && s < 62) s = 62;
    var ini = initials(title);
    if (ini && ini.indexOf(ql.replace(/[\s-]/g, '')) === 0 && s < 55) s = 55;
    var pub = String(b.publisher || '').toLowerCase();
    if (pub && pub.indexOf(ql) !== -1 && s < 40) s = 40;
    return s;
  }

  function searchMatches(q) {
    var ql = String(q || '').trim();
    if (!ql) return [];
    return allBooks()
      .map(function (b) { return { b: b, s: scoreBook(b, ql) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, 6)
      .map(function (x) { return x.b; });
  }

  // 搜索框下拉：书架里匹配到的书 + 上图书目里的版本。
  // 书名不再直接拿去查馆藏——要选定某一版的 ISBN 再查，所以这里必须列出可选的版本
  var sugSeq = 0;

  function editionSugHTML(list) {
    return list.map(function (e) {
      var isbn = compactIsbn(e.isbn);
      var sub = joinSep([e.author, [e.publisher, e.year].filter(Boolean).join(' '),
        isbn ? 'ISBN ' + isbn : ''].map(esc));
      return '<button type="button" class="sg ed" role="option"' +
        ' data-isbn="' + esc(isbn) + '"' +
        ' data-title="' + esc(e.title || '') + '"' +
        ' data-author="' + esc(e.author || '') + '"' +
        ' data-pub="' + esc(e.publisher || '') + '"' +
        ' data-year="' + esc(e.year || '') + '">' +
        icon('library') +
        '<span class="sg-t">' + esc(e.title || '（无书名）') + '</span>' +
        (sub ? '<span class="sg-s">' + sub + '</span>' : '') + '</button>';
    }).join('');
  }

  // 下拉的内容按「节」给：书架匹配一节、上图版本一节（空输入时是最近搜索一节）。
  // 分节是为了重画时能只动变了的那节——整块 innerHTML 会在每次按键时把转圈节点重建，
  // 载入动画于是每敲一个字就从头放一遍
  function sugSections(q) {
    var term = String(q || '').trim();
    if (!term) {
      var hist = loadHist();
      if (!hist.length) return [];
      var rows = ['<div class="sug-head">最近搜索</div>'];
      rows = rows.concat(hist.map(function (t) {
        return '<div class="sg-row">' +
          '<button type="button" class="sg" data-go="' + esc(t) + '" role="option">' + icon('history') +
          '<span class="sg-t">' + esc(t) + '</span></button>' +
          '<button type="button" class="sg-x" data-forget="' + esc(t) + '" title="从记录里删掉" aria-label="删除这条记录">' +
          icon('x') + '</button></div>';
      }));
      rows.push('<button type="button" class="sg clr" data-clear="1">' + icon('trash-2') +
        '<span class="sg-t">清空搜索记录</span></button>');
      return [{ k: 'hist', html: rows.join('') }];
    }

    var hit = searchMatches(term);
    var shelf = ['<div class="sug-head">' +
      (hit.length ? '书架里匹配到 ' + hit.length + ' 本' : '书架里没有匹配的书') + '</div>'];
    shelf = shelf.concat(hit.map(function (b) {
      var s = joinSep([b.author, b.isbn ? 'ISBN ' + b.isbn : ''].map(esc));
      return '<button type="button" class="sg" data-pick="' + esc(b.id) + '" role="option">' +
        icon('library') +
        '<span class="sg-t">' + esc(b.title) + '</span>' +
        (s ? '<span class="sg-s">' + s + '</span>' : '') + '</button>';
    }));

    var byIsbn = isIsbnTerm(term);
    var st = S.editions[editionKey(term, byIsbn)];
    var head = '上图版本';
    if (st && st.data && !byIsbn) head += '（' + sameEditions(st.data).length + ' 个同名版本）';
    var ed = ['<div class="sug-head">' + head + '</div>'];
    if (st && st.busy) {
      ed.push('<div class="sg-note"><span class="spin"></span> 正在查询上图版本…</div>');
    } else if (st && st.err) {
      ed.push('<div class="sg-note err">' + esc(st.err) +
        ' <button type="button" class="linkish" data-sug-retry="1">重试</button></div>');
    } else if (st && st.data) {
      var list = (st.data.editions || []).slice(0, 8);
      if (!list.length) {
        ed.push('<div class="sg-note">上图书目里没有《' + esc(term) + '》的同名版本</div>');
      } else {
        ed.push(editionSugHTML(list));
      }
    } else {
      ed.push('<div class="sg-note"><span class="spin"></span> 正在查询上图版本…</div>');
    }
    return [{ k: 'shelf', html: shelf.join('') }, { k: 'ed', html: ed.join('') }];
  }

  // 只换掉内容真的变了的那节；没变的节留在原地（节点不动，动画就不会重头放）。
  // 返回需要重新绑定事件的节——没绑过的才绑，不然点一下会触发两遍
  function syncSug(el, secs) {
    var cur = Array.prototype.slice.call(el.children);
    var aligned = cur.length === secs.length && secs.every(function (s, i) {
      return cur[i].getAttribute('data-sec') === s.k;
    });
    if (!aligned) {
      el.innerHTML = secs.map(function (s) {
        return '<div class="sg-sec" data-sec="' + s.k + '">' + s.html + '</div>';
      }).join('');
      return Array.prototype.slice.call(el.children);
    }
    var touched = [];
    secs.forEach(function (s, i) {
      if (cur[i].innerHTML === s.html) return;
      cur[i].innerHTML = s.html;
      touched.push(cur[i]);
    });
    return touched;
  }

  // 下拉项每次换过 DOM 都要重绑；数量很小，不必上事件委托。
  // 只绑「刚换过的那几节」——留在原地的节已经绑过了，再绑一次点一下就触发两遍
  function bindSug(nodes, term) {
    nodes.forEach(function (root) {
      Array.prototype.forEach.call(root.querySelectorAll(
        '[data-pick],[data-go],[data-forget],[data-clear],[data-isbn],[data-sug-retry]'), function (b) {
        // 鼠标划过 = 键盘选中：两种操作共用一套高亮，视觉上只有「当前这一条」
        b.addEventListener('mouseenter', function () {
          if (b.classList.contains('sg-x')) return;
          var i = sugOptions().indexOf(b);
          if (i >= 0) sugHi(i);
        });
        b.addEventListener('click', function () {
          if (b.hasAttribute('data-sug-retry')) {
            var key = editionKey(term, isIsbnTerm(term));
            delete S.editions[key];
            openSug();
            return;
          }
          if (b.hasAttribute('data-pick')) {
            var id = b.getAttribute('data-pick');
            var bk = findBook(id);
            closeSug();
            $('q').value = '';
            setClearBtn();
            if (bk) { pushHist(bk.title); selectBook(id); }
            return;
          }
          if (b.hasAttribute('data-isbn')) {
            var e = {
              isbn: b.getAttribute('data-isbn'),
              title: b.getAttribute('data-title'),
              author: b.getAttribute('data-author'),
              publisher: b.getAttribute('data-pub'),
              year: b.getAttribute('data-year')
            };
            closeSug();
            $('q').value = '';
            setClearBtn();
            pushHist(e.title || e.isbn);
            addEditionBook(e);
            if (window.innerWidth > NARROW_W) $('q').blur();
            return;
          }
          if (b.hasAttribute('data-forget')) {
            dropHist(b.getAttribute('data-forget'));
            openSug();
            return;
          }
          if (b.hasAttribute('data-clear')) {
            lsSet(HIST_KEY, '[]');
            closeSug();
            return;
          }
          var term2 = b.getAttribute('data-go');
          $('q').value = term2;
          setClearBtn();
          doSearch(term2);
        });
      });
    });
  }

  // 下拉里能被键盘选中的行（记录条右侧的 × 不算：它是删除动作，不是「查这个」）
  function sugOptions() {
    return Array.prototype.slice.call(
      $('sug').querySelectorAll('[data-pick],[data-go],[data-clear],[data-isbn]'));
  }

  // 高亮：鼠标划过和键盘上下都走这一个函数，两种操作不会各亮各的
  function sugHi(idx) {
    var opts = sugOptions();
    opts.forEach(function (b, i) { b.classList.toggle('hi', i === idx); });
    sugAuto = idx;
    return opts[idx];
  }

  function openSug() {
    var el = $('sug');
    var term = $('q').value.trim();
    var secs = sugSections(term);
    if (!secs.length) { closeSug(); return; }
    var touched = syncSug(el, secs);
    el.classList.remove('hidden');
    $('q').setAttribute('aria-expanded', 'true');
    sugAuto = -1;
    bindSug(touched, term);

    // 远端版本：没缓存过就发一次，回来按「当前输入仍是同一个词」再重画
    if (term) {
      var byIsbn = isIsbnTerm(term);
      var key = editionKey(term, byIsbn);
      var st = S.editions[key];
      var fresh = st && st.data && Date.now() - st.at < ED_TTL;
      if (!st || (!st.busy && !st.err && !fresh)) {
        var seq = ++sugSeq;
        fetchEditions(term).then(function () {
          if (seq !== sugSeq || $('sug').classList.contains('hidden')) return;
          if ($('q').value.trim() !== term) return;
          openSug();
        }).catch(function () {
          if (seq !== sugSeq || $('sug').classList.contains('hidden')) return;
          if ($('q').value.trim() !== term) return;
          openSug();
        });
      }
    }
  }

  function closeSug() {
    var el = $('sug');
    if (!el) return;
    el.classList.add('hidden');
    el.innerHTML = '';
    $('q').setAttribute('aria-expanded', 'false');
    sugAuto = -1;
  }

  // 输入框右侧那个清除叉：有字才出现
  function setClearBtn() {
    var b = $('qClear');
    if (b) b.classList.toggle('hidden', !$('q').value);
  }

  // 顶栏检索：先在上图书目里按书名找到版本，选定 ISBN 之后才查馆藏。
  // 唯一版本自动继续；多个版本把下拉叫回来让用户选；一个都没有就明说没有
  function resolveTerm(term, data) {
    var same = sameEditions(data);
    if (same.length === 1) {
      pushHist(term);
      addEditionBook(same[0]);
      if (window.innerWidth > NARROW_W) $('q').blur();
      return;
    }
    if (same.length > 1) {
      // 输入框里的词留着，重开下拉让用户点一个版本
      openSug();
      toast('上图有 ' + same.length + ' 个版本，在下方列表里选一个');
      return;
    }
    toast('上图书目里没有《' + term + '》的同名版本', 'err');
  }

  function doSearch(raw) {
    var term = String(raw || '').trim();
    if (!term) { toast('输入书名或 ISBN', 'err'); return; }
    closeSug();

    if (isIsbnTerm(term)) {
      var isbn = compactIsbn(term);
      pushHist(isbn);
      var r = addEditionBook({ isbn: isbn, title: 'ISBN ' + isbn });
      if (r && !r.existed) enrichFromEditions(r.book);
      if (window.innerWidth > NARROW_W) $('q').blur();
      return;
    }

    var st = S.editions[editionKey(term, false)];
    if (st && st.data) { resolveTerm(term, st.data); return; }

    var seq = ++sugSeq;
    toast('正在查询上图版本…');
    fetchEditions(term).then(function (d) {
      if (seq !== sugSeq) return;
      resolveTerm(term, d);
    }).catch(function (e) {
      if (seq !== sugSeq) return;
      toast('查询上图版本失败：' + (e.message || '请稍后重试'), 'err');
    });
  }

  function selectBook(id) {
    S.activeId = id;
    S.showAll = false;
    // 视野不跨书沿用：S.mapView 本来是给「切筛选别乱跳」用的，但切书也命中 keep 的话，
    // 上一本拖到浦东、下一本馆藏全在松江，地图停在原地一个标记都看不见，也不会自动框回来
    S.mapView = null;
    renderBooks();
    if (S.results[id]) renderResult();
    else { renderResultShell(); queryBook(id); }
    // 手机上书单在上、结果在下，点了书得让人看见结果；桌面两栏并排，不用滚
    if (window.innerWidth <= NARROW_W) {
      var r = $('result');
      if (r && r.scrollIntoView) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ---------------------------------------------------------------- 查询馆藏

  function fetchTab(recId, refresh) {
    // refresh=true 时带上 refresh=1，让 server.py 绕过馆藏页的 12 小时磁盘缓存
    return fetchT(API + '/Record/' + encodeURIComponent(recId) + '/AjaxTab' + (refresh ? '?refresh=1' : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'tab=holdings&folioLocations=%5B%5D&libraryId=allItem'
    }).then(function (r) {
      // 出错要往外抛，不能吞成空串：以前 HTTP 500 / 超时一律变 ''，
      // 结果「上图挂了」和「这家没馆藏」在界面上长得一模一样（都落到「各处都已借出」）
      if (!r.ok) throw new Error('馆藏页 HTTP ' + r.status);
      // 服务端把这份 HTML 的抓取时间放在 X-Data-At（Unix 秒）。
      // 老服务端没有这个头：返回 0，界面退回本次完成时间，行为跟以前一致。
      var at = parseInt(r.headers.get('X-Data-At'), 10);
      return r.text().then(function (html) {
        return { html: html, at: isFinite(at) && at > 0 ? at * 1000 : 0 };
      });
    });
  }

  function mapLimit(arr, limit, fn) {
    var out = new Array(arr.length), i = 0;
    function worker() {
      if (i >= arr.length) return Promise.resolve();
      var idx = i++;
      return Promise.resolve(fn(arr[idx])).then(function (v) { out[idx] = v; return worker(); });
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, arr.length); k++) runners.push(worker());
    return Promise.all(runners).then(function () { return out; });
  }

  function searchPage(lookfor, type) {
    return apiGet(API + '/api/v1/search?lookfor=' + encodeURIComponent(lookfor) +
      '&type=' + type + '&limit=' + PAGE_LIMIT + '&page=1');
  }

  /**
   * 把各实例的结构诊断汇成一句提示。只有全部实例都「拿到了 HTML 却解析不出复本」才算改版，
   * 部分失败一律当正常（有的记录就是没有馆藏，或者某次请求超时返回空）。
   */
  function layoutWarning(layouts) {
    var total = layouts.length;
    if (!total) return null;
    var rows = layouts.filter(function (l) { return l.reason === 'rows'; }).length;
    var branchGone = layouts.filter(function (l) { return l.reason === 'branches'; }).length;
    if (rows === total || branchGone === total) {
      return branchGone === total ? 'branches' : 'rows';
    }
    return null;
  }

  // 手动加的书如果只填了 ISBN，查上图顺带把正式书名/作者补上：
  // 输入框里那串数字不是书名，查到了就该换成书上印的名字
  function enrichManual(book, rec) {
    if (!book || !book.adhoc || !rec) return;
    var official = String(rec.title || '').trim();
    var titleIsCode = !book.title || book.title === book.isbn ||
      /^(97[89])?\d{9}[\dXx]$/.test(compactIsbn(book.title));
    if (official && titleIsCode) book.title = official;
    var prim = rec.authors && rec.authors.primary;
    if (!book.author && prim && typeof prim === 'object') {
      var names = Object.keys(prim);
      if (names.length) book.author = names.join(' / ');
    }
    saveManual();
  }

  /**
   * 豆瓣书单条目没带 ISBN 时，让服务端现抓一次详情页补上。
   * 后台补 ISBN 是 1 秒一本的慢通道，点开的那本常常还没轮到；
   * 每本只问一次（「重新查询」时再问），补不到就退回按书名找同名版本。
   * 记住的是 promise 而不是结果：同一本同时被问两次时共用一次请求。
   */
  var isbnTried = {};

  function fetchIsbnFor(book, retry) {
    if (!book || !book.url || book.isbn) return Promise.resolve('');
    var prev = isbnTried[book.url];
    if (prev && !retry) return prev;
    if (S.cfg && S.cfg.features && !S.cfg.features.isbn) return Promise.resolve('');
    var p = apiGet('/api/isbn?url=' + encodeURIComponent(book.url), 30000)
      .then(function (j) {
        var v = compactIsbn(j && j.isbn);
        if (v) book.isbn = v;
        return v;
      })
      .catch(function () { return ''; });
    isbnTried[book.url] = p;
    return p;
  }

  /**
   * 没有 ISBN 的书再按书名找同名版本：只有一个版本就补上 ISBN 接着查；
   * 多个把选择器交给结果区；一个都没有就明说。
   * 返回 true 表示可以继续查馆藏，false 表示结果区已经画好空态或版本选择器。
   */
  function resolveByTitle(book, id, t0, fail, refresh) {
    if (!book.title) {
      fail(new Error('这本书没有 ISBN，也没有书名'));
      return Promise.resolve(false);
    }
    // 选择器/空态已经画过就别再打一次上图：每次重绘都重查会一直闪转圈
    var shown = S.results[id] && S.results[id].meta;
    if (shown && (shown.needVersion || shown.noEdition) && shown.title === book.title) {
      return Promise.resolve(false);
    }
    return fetchEditions(book.title, refresh).then(function (d) {
      var same = sameEditions(d);
      if (same.length === 1) {
        applyEdition(book, same[0]);
        return true;
      }
      S.busy[id] = false;
      S.results[id] = {
        branches: [], places: [],
        meta: {
          total: 0, instances: 0, title: book.title,
          elapsed: ((Date.now() - t0) / 1000).toFixed(1),
          fetchedAt: nowTime(),
          needVersion: same.length > 1,
          noEdition: same.length === 0,
          candidates: same
        }
      };
      renderBooks();
      if (S.activeId === id) renderResult();
      return false;
    }, function (e) {
      fail(new Error('没查到版本信息：' + (e.message || '上图没响应')));
      return false;
    });
  }

  /**
   * 没有 ISBN 的书（豆瓣书单条目、旧的手动书目）：先向服务端要豆瓣详情页的 ISBN。
   * 有 ISBN 就直接按 ISBN 查，精确且快；拿不到才走按书名找同名版本那条老路
   * （也是它的兜底：豆瓣详情页也读不到时，用户仍能按书名查到书）。
   */
  function resolveBookVersion(book, id, t0, fail, refresh) {
    if (book.isbn) return Promise.resolve(true);
    return fetchIsbnFor(book, refresh).then(function (isbn) {
      return isbn ? true : resolveByTitle(book, id, t0, fail, refresh);
    });
  }

  /**
   * refresh=true：跳过内存缓存和磁盘缓存，真的回上图重抓（「重新查询」按钮用）。
   * 平时走内存 5 分钟缓存；冷启动时内存是空的，但服务端还有 12 小时的馆藏页缓存兜底，
   * 所以刷新页面不用为每本书重新等 1~3 秒。
   */
  function queryBook(id, refresh) {
    var book = findBook(id);
    if (!book || S.busy[id]) return Promise.resolve();

    var cached = S.cache[id];
    if (!refresh && cached && Date.now() - cached.at < CACHE_TTL) {
      S.results[id] = cached.payload;
      renderBooks();
      if (S.activeId === id) renderResult();
      return Promise.resolve();
    }

    S.busy[id] = true;
    renderBooks();
    // 只在查的就是当前这本时才动结果区：后台补查书架里的书时，
    // 无条件重绘会把「你正在看的那本」的结果（含地图）冲成转圈
    if (S.activeId === id) renderResultShell();

    var t0 = Date.now();

    function fail(e) {
      delete S.busy[id];
      // 失败也要留一份结果：否则 renderResult 拿到空数据，说出的还是「各处都已借出」——
      // 那是「书都已借出」的话术，用在「接口挂了」上等于骗人。记下原因，界面单独给一张空态
      S.results[id] = {
        branches: [], places: [],
        meta: {
          total: 0, instances: 0, availBranches: 0, copyTotal: 0, inHouseTotal: 0,
          elapsed: ((Date.now() - t0) / 1000).toFixed(1),
          fetchedAt: nowTime(),
          fetchErr: e.message || '查询失败'
        }
      };
      renderBooks();
      if (S.activeId === id) renderResult();
      toast('查询出错：' + (e.message || ''), 'err');
    }

    function finish(payload) {
      S.results[id] = payload;
      S.busy[id] = false;
      // 单独检索的书原本没有封面 id，查到之后把上图封面补到左侧小图上
      if (book.adhoc && payload.meta && payload.meta.coverId) {
        book.shlId = payload.meta.coverId;
        saveManual();
      }
      // 只让这本刚查完的书播印章动画；渲染结束立即收回，过滤/切书不再重播
      S.stampAnimId = id;
      renderBooks();
      if (S.activeId === id) renderResult();
      S.stampAnimId = null;
      return payload;
    }

    function searchIsbn() {
      // ISBN 是唯一标识：书名不再直接拿去查馆藏——同名不同版的索书号和馆藏对不上
      return searchPage(book.isbn, 'ISBN').then(function (res) {
        var records = res.records || [];
        if (!records.length) {
          return { meta: { total: 0, noRecord: true, instances: 0 }, branches: [], places: [] };
        }
        // 手动加的书：用上图记录里的正式书名/作者替换「ISBN 当书名」的临时样子
        enrichManual(book, records[0]);
        var ids = records.slice(0, INSTANCES).map(function (r) { return r.id; });
        // 单个版本取失败先记着、不整本推翻：10 个版本里挂了 1 个，剩下 9 个照样能出结果。
        // 全部都挂了才往上抛——那时候「没有馆藏」是假象，得让用户知道是接口没响应
        var failed = 0;
        return mapLimit(ids, CONC, function (rid) {
          return fetchTab(rid, refresh).catch(function () { failed++; return { html: '', at: 0 }; });
        }).then(function (tabs) {
          if (failed && failed === ids.length) {
            throw new Error('上图没响应（' + ids.length + ' 个版本都取不到）');
          }
          var items = [];
          var layouts = [];
          // 各版本可能有的命中 12 小时缓存、有的是刚抓的：取最老的一份作为整本的数据时间，
          // 宁可说旧一点，也不要把缓存冒充成刚抓的
          var dataAt = 0;
          tabs.forEach(function (t) {
            if (!t || !t.html) return;
            var d = SHLIB.parseAjaxTabDetailed(t.html);
            layouts.push(d.layout);
            d.items.forEach(function (it) { items.push(it); });
            if (t.at && (!dataAt || t.at < dataAt)) dataAt = t.at;
          });
          // 接口改版探测：拿到 HTML 却解析不出复本时，「真的没有馆藏」和「解析失效」看起来一样。
          // 由 shlib.js 的 parseAjaxTabDetailed 结构诊断给出原因，这里汇总成一句提示
          var layoutWarn = layoutWarning(layouts);
          var branches = SHLIB.aggregateHoldings(items);
          var places = SHLIB.buildPlaces(branches, S.spot);
          var availBranches = places.filter(function (p) { return p.available > 0; }).length;
          var payload = {
            branches: branches,
            places: places,
            meta: {
              total: res.resultCount || records.length,
              instances: ids.length,
              coverId: ids[0],
              availBranches: availBranches,
              copyAvail: places.reduce(function (s, p) { return s + p.available; }, 0),
              copyTotal: places.reduce(function (s, p) { return s + p.total; }, 0),
              inHouseTotal: places.reduce(function (s, p) { return s + inHouseTotal(p); }, 0),
              elapsed: ((Date.now() - t0) / 1000).toFixed(1),
              fetchedAt: nowTime(),
              dataAt: dataAt,   // 馆藏 HTML 的真实抓取时间（毫秒）；0 = 老服务端没给
              layoutWarn: layoutWarn
            }
          };
          S.cache[id] = { at: Date.now(), payload: payload };
          return payload;
        });
      }).then(finish, fail);
    }

    return resolveBookVersion(book, id, t0, fail, refresh).then(function (go) {
      if (go) return searchIsbn();
    });
  }

  // ---------------------------------------------------------------- 渲染结果

  function renderResultShell() {
    var book = findBook(S.activeId);
    if (!book) {
      $('result').innerHTML = '<div class="empty"><h2>先选一本书</h2><p>在书架里点一本，查看上图实时馆藏。</p></div>';
      return;
    }
    $('result').innerHTML = '<div class="result-inner">' + headHTML(book) +
      '<div class="loading-row"><span class="spin"></span> 正在查上图（逐册核对，约 2-6 秒）…</div></div>';
    ensureEditions(book);
  }

  // ---------------------------------------------------------------- 其他版本（上图书目）
  //
  // 「本书其他版本」的数据来自上图书目 RIS（/api/editions），不是豆瓣：
  // 每条都带 ISBN，点一下就能按 ISBN 查馆藏。版本放在书名下面；
  // 搜索联想、手动加书、书架行内的版本数共用同一份缓存。

  // 豆瓣图标：有条目 id 就跳条目页；手动加的书没有 subjectId，用 ISBN 走
  // https://book.douban.com/isbn/<isbn>/（实测 301 到条目页）
  function doubanUrlOf(book) {
    var id = String((book && (book.subjectId || book.id)) || '');
    if (/^\d{1,12}$/.test(id)) return 'https://book.douban.com/subject/' + id + '/';
    var isbn = compactIsbn(book && book.isbn);
    return isbn ? 'https://book.douban.com/isbn/' + isbn + '/' : '';
  }

  function versionsHTML(book, data) {
    var cur = compactIsbn(book.isbn);
    var list = ((data && data.editions) || []).filter(function (e) {
      return e.same && e.isbn && compactIsbn(e.isbn) !== cur;
    });
    // 没有其他版本就整块不出现：一行「没有查到其他版本」不回答问题，只是占位
    if (!list.length) return '';
    // 折叠是默认态：九行版本把真正的答案（哪家馆能借）推出首屏，而绝大多数查询
    // 只要当前这一版。收起时只留一行「本书其他版本 N 个」，点了才列
    var open = !!S.versOpen[book.id];
    var head = '<button type="button" class="db-vers-head' + (open ? ' open' : '') + '"' +
      ' data-db-act="ver-toggle" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="db-vers-lbl">本书其他版本</span>' +
      '<span class="db-vers-n">' + list.length + ' 个</span>' +
      icon('chevron-down') + '</button>';
    if (!open) return head;
    var rows = list.map(function (e) {
      var isbn = compactIsbn(e.isbn);
      var pub = [e.publisher, e.year].filter(Boolean).join(' ');
      return '<button type="button" class="db-ver" data-db-act="isbn"' +
        ' data-isbn="' + esc(isbn) + '"' +
        ' data-title="' + esc(e.title || book.title) + '"' +
        ' data-author="' + esc(e.author || '') + '"' +
        ' data-pub="' + esc(e.publisher || '') + '"' +
        ' data-year="' + esc(e.year || '') + '"' +
        ' title="按 ISBN ' + esc(isbn) + ' 查上图馆藏">' +
        '<span class="dbv-main">' +
        '<span class="dbv-pub">' + esc(pub || '出版信息不详') + '</span>' +
        '<span class="dbv-isbn">ISBN ' + esc(isbn) + '</span></span>' +
        '<span class="dbv-go">查馆藏</span></button>';
    }).join('');
    return head + '<div class="db-vers-rows">' + rows + '</div>';
  }

  function paintVersions(book) {
    if (!book || book.id !== S.activeId) return;
    var slot = $('dbVersSlot');
    if (!slot) return;
    var st = S.editions[editionKey(book.title, false)];
    if (st && st.data) {
      slot.innerHTML = versionsHTML(book, st.data);
      return;
    }
    if (st && st.err) {
      slot.innerHTML = '<div class="db-vers-note">其他版本查询失败：' + esc(st.err) +
        ' <button type="button" class="linkish" data-db-act="ver-retry">重试</button></div>';
      return;
    }
    // 还没查出来：先什么都不画。多数书架条目启动时已经查过，这里留空只是几十毫秒；
    // 画一枚转圈反而会给「其实没有版本」的书闪出一条无关信息
    slot.innerHTML = '';
  }

  function ensureEditions(book) {
    if (!book || !book.title) return;
    paintVersions(book);
    var key = editionKey(book.title, false);
    var st = S.editions[key];
    // 失败过就不再自动重试：结果页会留一条「重试」，别让每次重绘都去打上图
    if (st && (st.busy || st.err || (st.data && Date.now() - st.at < ED_TTL))) return;
    fetchEditions(book.title).then(function () {
      paintVersions(findBook(book.id) || book);
    }).catch(function () {
      paintVersions(findBook(book.id) || book);
    });
  }

  // 点「本书其他版本」→ 按那一版的 ISBN 加进「手动添加」并查询
  function openEdition(el) {
    var isbn = compactIsbn(el.getAttribute('data-isbn'));
    if (!isbn) return;
    var cur = findBook(S.activeId);
    if (cur && compactIsbn(cur.isbn) === isbn) {
      toast('当前就是这一版，无需切换');
      return;
    }
    addEditionBook({
      isbn: isbn,
      title: el.getAttribute('data-title') || '',
      author: el.getAttribute('data-author') || '',
      publisher: el.getAttribute('data-pub') || '',
      year: el.getAttribute('data-year') || ''
    });
  }

  // 结果区的版本选择器：选定后把这一版的 ISBN 写回当前这本书，再按 ISBN 查馆藏
  function pickVersion(el) {
    var book = findBook(S.activeId);
    var isbn = compactIsbn(el.getAttribute('data-isbn'));
    if (!book || !isbn) return;
    applyEdition(book, {
      isbn: isbn,
      title: el.getAttribute('data-title') || book.title,
      author: el.getAttribute('data-author') || '',
      publisher: el.getAttribute('data-pub') || '',
      year: el.getAttribute('data-year') || ''
    });
    delete S.cache[book.id];
    delete S.results[book.id];
    S.showAll = false;
    toast('已选定这一版，正在查馆藏…', 'ok');
    queryBook(book.id, true);
  }

  // 书名缺失或多个版本时，结果页里的版本选择列表（手动加书从书名进来的兜底）
  function chooseVersionHTML(book, meta) {
    var list = (meta.candidates || []).map(function (e) {
      var isbn = compactIsbn(e.isbn);
      var pub = [e.publisher, e.year].filter(Boolean).join(' ');
      return '<button type="button" class="db-ver" data-act="pick-ver"' +
        ' data-isbn="' + esc(isbn) + '"' +
        ' data-title="' + esc(e.title || book.title) + '"' +
        ' data-author="' + esc(e.author || '') + '"' +
        ' data-pub="' + esc(e.publisher || '') + '"' +
        ' data-year="' + esc(e.year || '') + '">' +
        '<span class="dbv-main"><span class="dbv-pub">' + esc(pub || '出版信息不详') + '</span>' +
        '<span class="dbv-isbn">ISBN ' + esc(isbn) + '</span></span>' +
        '<span class="dbv-go">查这一版</span></button>';
    }).join('');
    return '<div class="empty-state">' +
      '<span class="es-ico">' + icon('library') + '</span>' +
      '<h2>选一个上图版本</h2>' +
      // 正文不复述标题（「选定一个版本」）、不提 ISBN（那是内部依赖），
      // 只补标题没说的因果：馆藏是按版本记的，所以必须先选一本
      '<p>《' + esc(book.title || '') + '》在上图有 ' + (meta.candidates || []).length +
      ' 个版本。馆藏是按版本记的，先选一本。</p>' +
      '<div class="db-vers-rows pick">' + list + '</div></div>';
  }

  function headHTML(book, meta) {
    // 书的身份信息分两行：第二排作者 | 出版社 年份，第三排单独放 ISBN。
    // 册数、馆数不再往这儿写——筛选条上已经有「册/馆」计数、封面角标上是可借家数，
    // 同一批数字第三次出现只会把「这本书是什么」挤到后面去
    var sub = [];
    if (book.author) sub.push(esc(book.author));
    var imp = imprintText(book);
    if (imp) sub.push(imp);
    // ISBN 是抄下来跟人核对用的号码，挤在作者后面容易被当成一句话读过去

    // 外链：跳到上图这一本书的原始页面。
    // 卡片上的馆藏是「我们查过的那几本版本」，上图 Record 页是全馆总表（含各版本、
    // 预约、展开的详细字段），两者不是一回事——想要权威口径就点这枚馆徽。
    // shlId 就是上图记录 id（封面代理也用它），实测 /Record/<id> 直接 200
    var rid = (meta && meta.coverId) || book.shlId;
    var extlink = rid
      ? '<a class="extlink" href="https://vufind.library.sh.cn/Record/' + encodeURIComponent(rid) +
        '" target="_blank" rel="noopener noreferrer" title="在上海图书馆打开这本书的原始页面" ' +
        'aria-label="在上海图书馆打开这本书的原始页面">' +
        '<img src="shl-logo.png" alt="上海图书馆" width="15" height="15"></a>'
      : '';

    // 豆瓣条目：跟馆徽排成右侧同一簇（同样 15×15 的落款），同一本书在豆瓣上的简介/评论就在那里。
    // 有条目 id 走条目页；手动加的书只有 ISBN，走 /isbn/<isbn>/（实测 301 到条目页）
    var douban = doubanUrlOf(book);
    var dblink = douban
      ? '<a class="extlink db-link" href="' + esc(douban) +
        '" target="_blank" rel="noopener noreferrer" title="在豆瓣打开这本书" ' +
        'aria-label="在豆瓣打开这本书">' +
        '<img src="douban-favicon.png" alt="豆瓣" width="15" height="15"></a>'
      : '';

    // 结果页封面不挂任何状态：都已借出 / 仅馆内 / 无此版本由下面的空态和筛选条说清楚，
    // 查询中也不转圈（同一句话不用讲两遍）——见 coverBox
    return '<div class="res-head">' +
      coverBox(book.cover, 'cover', book.title, rid, '', false) +
      '<div class="h-main"><h1><span class="ht">' + esc(book.title) + '</span>' + extlink + dblink + '</h1>' +
      (sub.length ? '<div class="sub">' + joinSep(sub) + '</div>' : '') +
      '<div class="db-vers" id="dbVersSlot"></div>' +
      '</div></div>';
  }

  // 「最早几点开门」是纯逻辑（要按星期翻表），实现在 shlib.js 里，这里只是短名字
  var nextOpening = SHLIB.nextOpening;

  /**
   * 空态：结果区一张卡都出不来时占位。
   * 结构 = 大图标 + 标题 + 一句解释 + 可选的操作按钮，靠 max-width 收窄成一段可读的正文。
   * actions 传 [{act:'set-filter', v:'all', label:'看全部馆藏'} | {act:'toggle-open'} |
   * {act:'requery'}]，事件在 bindEmptyEvents() 里统一绑——这里只出 data-act 属性，
   * 不写 onclick（项目里没有内联事件，CSP 友好、也好测）。
   */
  function emptyState(o) {
    var acts = (o.actions || []).map(function (a) {
      return '<button class="' + (a.primary ? 'primary' : '') + '" data-act="' + a.act + '"' +
        (a.v ? ' data-v="' + esc(a.v) + '"' : '') + '>' + esc(a.label) + '</button>';
    }).join('');
    return '<div class="empty-state' + (o.tone ? ' ' + o.tone : '') + '">' +
      '<span class="es-ico">' + icon(o.icon) + '</span>' +
      '<h2>' + esc(o.title) + '</h2>' +
      '<p>' + o.desc + '</p>' +
      (acts ? '<div class="es-acts">' + acts + '</div>' : '') +
      '</div>';
  }

  function bindEmptyEvents() {
    Array.prototype.forEach.call(document.querySelectorAll('.empty-state [data-act]'), function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        if (act === 'set-filter') {
          S.filter = b.getAttribute('data-v') || 'avail';
          S.showAll = false;
          renderResult();
        } else if (act === 'toggle-open') {
          // 关掉「营业中」：此刻全城关门时，这是回到有结果最快的一步
          S.onlyOpen = false;
          S.showAll = false;
          renderResult();
        } else if (act === 'requery') {
          requeryActive();
        } else if (act === 'call') {
          // tel: 直拨（借空态上的「打给 XX 馆」）：手机直接拉起拨号，桌面点了没反应也无害
          window.location.href = 'tel:' + dialNo(b.getAttribute('data-v'));
        }
      });
    });
  }

  // 「重新查询」只有一个动作，三个入口（工具栏、空态、旧数据提示条）都走这里
  function requeryActive() {
    var id = S.activeId;
    if (!id) return;
    delete S.cache[id];
    delete S.results[id];
    S.showAll = false;
    var res = $('result');
    if (res) res.classList.add('refreshing');
    toast('正在重新查询…');
    queryBook(id, true);
  }

  function renderResult() {
    // 无论走哪个分支，重绘一开始就撤掉「正在刷新」的置灰态：
    // 类加在 #result 上而不是会被 innerHTML 换掉的 .res-list 上，所以这里手动清
    $('result').classList.remove('refreshing');
    var book = findBook(S.activeId);
    if (!book) return renderResultShell();
    var r = S.results[S.activeId];
    if (!r) return renderResultShell();

    var meta = r.meta;

    // 没有 ISBN 的书先选版本：唯一版本在 queryBook 里已经自动选定，到这里的只有
    // 「多个版本待选」和「一个版本都没有」两种。它们不是「没馆藏」，要单独说
    if (meta.needVersion || meta.noEdition) {
      $('result').innerHTML = '<div class="result-inner">' + headHTML(book) +
        (meta.needVersion
          ? chooseVersionHTML(book, meta)
          : emptyState({
            icon: 'book-x',
            title: '上图没有同名版本',
            // 不写「因此没有可查馆藏的 ISBN」：那是把程序内部的推理链摊给用户看，
            // 用户要的只有「换一个书名」或「直接填 ISBN」这两条出路
            desc: '上图没有书名叫《' + esc(book.title) + '》的版本。换个书名试试，或直接填 ISBN。'
          })) +
        '</div>';
      bindEmptyEvents();
      return;
    }

    if (meta.noRecord) {
      $('result').innerHTML = '<div class="result-inner">' + headHTML(book) +
        emptyState({
          icon: 'book-x',
          title: '上图没有这一版',
          desc: '按 ISBN <b>' + esc(book.isbn || '—') + '</b> 在上图没有查到馆藏记录。' +
            '可能尚未入藏，或者这个 ISBN 和上图记的对不上。'
        }) +
        '</div>';
      bindEmptyEvents();
      ensureEditions(book);
      return;
    }

    // 位置变了要重算距离
    var places = SHLIB.buildPlaces(r.branches, S.spot);

    // 可借 = 有在架册。今日闭馆的馆也算可借（书就在架上，只是今天去不了），
    // 卡片上会标「今日闭馆」；是否只要此刻营业的，交给「营业中」勾选框。
    // 没有开放时间数据的（openToday === null）不再算营业中——「此刻开着」是这档的承诺，
    // 不知道就等于没承诺。这类馆卡片上标「开馆时间未知」，勾上「营业中」时被隐藏。
    var availAll = places.filter(function (p) { return p.available > 0; });
    var anyAvail = availAll.length > 0;
    var availNow = availAll.filter(function (p) { return p.openNow === true; });
    // 「假期/调休日按常规时间闭馆」跟「根本没有开放时间」都会让 openToday 为 null，
    // 但原因和该说的话完全不同：前者是上图可能临时调时间，后者是上图没给数据。
    // 分开计数，卡片和筛选说明才不会把假期待确认说成「开馆时间未知」。
    var holidayUnknown = availAll.filter(function (p) { return p.holidayUnknown; }).length;
    var unknownHours = availAll.filter(function (p) {
      return p.openToday === null && !p.holidayUnknown;
    }).length;
    var todaySpecial = SHLIB.holidayOf();
    var specialName = todaySpecial
      ? todaySpecial.name + (todaySpecial.kind === 'holiday' ? '假期' : '调休工作日')
      : '';

    // 三档视图：只看可借 / 只看可借且此刻营业 / 全部馆藏。
    // 「营业中」勾着而此刻全城关门时，不退回「全部可借」——那样列表和勾选框自相矛盾，
    // 用户以为自己在看「现在能去的」，实际看到的包含关门的馆。给空态，让他自己决定要不要放开。
    // 只有勾着「营业中」时才真的按 availNow 裁；没勾时 availNow 可能为空（全城关门），
    // 那时候不能顺手退回 availAll，否则勾选框就等于没生效。
    // 另外判断条件用 S.filter 本身，不能写成「且 anyAvail」：一册都没在架时那样会让
    // filterOn 变 false，于是「只看可借」档直接列出全部借出的馆，和按钮的说法相反。
    var filterOn = S.filter === 'avail';
    var shown = places;
    if (filterOn) {
      shown = S.onlyOpen ? availNow : availAll;
    }
    var visible = S.showAll ? shown : shown.slice(0, SHOW_LIMIT);
    // 手机全屏地图跟列表用同一批点：地图上多出来的馆点了对不上卡片
    S.mapShown = visible;

    var hasResults = visible.length > 0;
    var hasMapPts = visible.some(function (p) { return p.lat != null && p.lng != null; });

    var toolbar = '<div class="toolbar">' +
      '<div class="seg">' +
      '<span class="seg-thumb" aria-hidden="true"></span>' +
      '<button data-filter="avail" class="' + (S.filter === 'avail' ? 'on' : '') + '">可借</button>' +
      '<button data-filter="all" class="' + (S.filter === 'all' ? 'on' : '') + '">全部</button>' +
      '</div>' +
      '<button type="button" class="tgl" id="onlyOpen"' +
      ' aria-pressed="' + (S.onlyOpen ? 'true' : 'false') + '"' +
      (S.filter === 'all' ? ' disabled' : '') +
      ' title="只列此刻开门营业的馆（仅在「可借」下生效；开馆时间未知、开馆安排待确认的会被隐藏）">' +
      '<span>营业中</span>' +
      '<span class="tgl-track"><span class="tgl-knob"></span></span>' +
      '</button>' +
      '<span class="spacer"></span>' +
      '<button class="sm icon-btn" id="requery" title="重新查询：跳过缓存，重新从上图获取实时馆藏" ' +
      'aria-label="重新查询">' + ICON_REFRESH + '</button>' +
      (canMap() && window.innerWidth >= MAP_BG_MIN
        ? '<button class="sm icon-btn' + (S.mapOn ? ' on' : '') + '"' +
          (hasResults ? '' : ' disabled') +
          ' id="mapToggle" ' +
          'title="' + (S.mapOn ? '收起地图' : '展开地图') + '" aria-label="显示或隐藏地图" ' +
          'aria-pressed="' + (S.mapOn ? 'true' : 'false') + '">' + ICON_MAP + '</button>'
        : canMap() && hasMapPts
          ? '<button class="sm icon-btn" id="mapSheetBtn" title="在全屏地图上看馆藏分布" ' +
            'aria-label="在全屏地图上看馆藏分布">' + ICON_MAP + '</button>'
          : '') +
      '</div>';

    var cards = visible.map(function (p, i) { return cardHTML(p, i); }).join('');

    // ---- 空态：三种「没有一张卡」的原因，各给各的话术和出路。
    // 优先级：结构异常 > 没有在架册 > 此刻无营业中
    // 「没有在架册」必须排在「营业中」前面：一本全城借空的书，如果上本书勾过「营业中」，
    // 就会落进营业中分支，说出「0 家馆有在架册，但都不在营业时间」和「看这 0 家」这种自相矛盾的话
    // （结构异常时后两种判断本身就不可信，不能拿它当结论说给用户听）
    // 「没有在架册」只在「只看可借」档下算是空态；「全部馆藏」档把全部借出的馆照常列出来，
    // 那是有用的信息（能看到哪家有、几册），不该被一张空态盖掉——真的一家馆都没有时，
    // 「营业中」也不会勾着（勾选框在全部馆藏档下是 disabled），落到最后一个分支。
    var emptyHTML = '';
    // 假期空态是否已经把「今天是某假期、建议先打电话」说过了；说过就不再挂 holidayBar
    var holidaySaid = false;
    if (!cards) {
      if (meta.fetchErr) {
        // 接口没响应：跟「结构解析不出来」分开说。这里书是有记录的，只是没拿到馆藏页，
        // 不能落到「各处都已借出」那张卡上——那会让用户以为书都已借出
        emptyHTML = emptyState({
          icon: 'triangle-alert', tone: 'warn',
          title: '这次没取到馆藏',
          desc: '请求上图时出错了（' + esc(meta.fetchErr) + '）。不是这本书都已借出，' +
            '是没拿到数据：可能是网络断了或上图慢。点下面重查一次。',
          actions: [{ act: 'requery', label: '重新查询', primary: true }]
        });
      } else if (meta.layoutWarn) {
        emptyHTML = emptyState({
          icon: 'triangle-alert', tone: 'warn',
          title: '这次没取到馆藏',
          // 「解析规则」是工程词：说成「上图改版了，要更新程序」用户才知道该找谁
          desc: '上图馆藏页的样子跟程序认的不一样，一家分馆都没读出来。' +
            '点下面的按钮重试一次；一直这样说明上图改版了，要更新程序。',
          actions: [{ act: 'requery', label: '重新查询', primary: true }]
        });
      } else if (S.onlyOpen && anyAvail) {
        // 有在架册，但此刻没有一家能确定在营业
        var closedCnt = availAll.length - unknownHours - holidayUnknown;
        if (!closedCnt) {
          // 一家都判不了：说「都不在营业时间」是假话。假期/调休和「没给时间」分开说
          var noTimeDesc;
          if (holidayUnknown && !unknownHours) {
            noTimeDesc = '这 ' + availAll.length + ' 家有在架册，但按常规时间今天都闭馆——今天是' +
              specialName + '，开馆安排可能调整，所以「营业中」筛不出结果。去之前建议先打电话确认。';
            // 空态自己说了假期 + 打电话，下面那条假期提示条就别再重复一遍（同一屏两遍）
            holidaySaid = true;
          } else if (!holidayUnknown && unknownHours) {
            noTimeDesc = '这 ' + availAll.length + ' 家有在架册，但上图没有它们的开馆时间，' +
              '所以「营业中」筛不出结果。去之前建议先打电话确认。';
          } else {
            noTimeDesc = '这 ' + availAll.length + ' 家有在架册：' + holidayUnknown +
              ' 家按常规时间今天闭馆（今天是' + specialName + '，安排可能调整）、' +
              unknownHours + ' 家没有开馆时间，所以「营业中」筛不出结果。去之前建议先打电话确认。';
            holidaySaid = holidayUnknown > 0;
          }
          emptyHTML = emptyState({
            icon: holidayUnknown ? 'calendar' : 'clock',
            title: holidayUnknown && !unknownHours ? '开馆安排待确认' : '无法判断是否营业',
            desc: noTimeDesc,
            actions: [
              { act: 'toggle-open', label: '看这 ' + availAll.length + ' 家（不筛营业状态）', primary: true },
              { act: 'set-filter', v: 'all', label: '看全部' }
            ]
          });
        } else {
        var nextOpen = nextOpening(availAll);
        // 假期里 nextOpening 会主动返回 null（常规时间表不能用来推假期开馆），
        // 这时只说「按常规时间不在营业时段」，不编具体开门时间
        var also = [];
        if (holidayUnknown) {
          also.push(holidayUnknown + ' 家因' + (todaySpecial.kind === 'holiday' ? '假期' : '调休') +
            '安排待确认');
        }
        if (unknownHours) also.push(unknownHours + ' 家开馆时间未知');
        // when === '今天' 时不写时刻：前一句刚说「都不在营业时间」，再写「今天 13:30」会打架
        emptyHTML = emptyState({
          icon: 'moon-star',
          title: '此刻没有营业中的馆',
          desc: closedCnt + ' 家馆有在架册，' +
            (todaySpecial ? '按常规时间此刻不在营业时段' : '但都不在营业时间') +
            (nextOpen ? '。最早一家是 <b>' + esc(nextOpen.name) + '</b>，' +
              (nextOpen.when === '今天' ? '' : esc(nextOpen.when) + ' ') + nextOpen.at + ' 开门' : '') +
            (also.length ? '。另有 ' + also.join('、') + '，同样没列出来' : '') +
            '。',
          actions: [
            { act: 'toggle-open', label: '看这 ' + availAll.length + ' 家（含已闭馆）', primary: true },
            { act: 'set-filter', v: 'all', label: '看全部' }
          ]
        });
        }
      } else if (!anyAvail) {
        // 文案按复本数分三路：外借本全借出 / 只有馆内阅览本 / 连复本记录都没有。
        // inHouseTotal 只数参考外借、保存本、馆内阅览——它们的 total 不进 copyTotal，
        // 所以不能靠 copyTotal === 0 就断定「没有在架复本」。
        var inHouse = meta.inHouseTotal || 0;
        var borrowTitle = '各处都已借出';
        var borrowIcon = 'book-x';
        var borrowDesc;
        if (meta.copyTotal > 0) {
          // 正文只留事实。「打电话问归还时间」不必写——下面就有「打给 X 馆」这个按钮，
          // 空态替按钮复述动作等于同一件事说两遍
          borrowDesc = '这本书在 ' + places.length + ' 家馆共 ' + meta.copyTotal + ' 册，此刻全部借出。' +
            (inHouse > 0 ? '另有 ' + inHouse + ' 册只能馆内阅览。' : '');
        } else if (inHouse > 0) {
          borrowTitle = '只有馆内阅览本';
          borrowIcon = 'eye';
          // 「可以查看馆藏类型和索书号」是教人看眼前已经摆着的东西，删掉
          borrowDesc = '这本书的 ' + inHouse + ' 册都在 ' + places.length + ' 家馆名下，' +
            '只能馆内阅览，不能外借。去之前建议先打电话确认。';
        } else {
          borrowDesc = '上图有这本书的记录，但 ' + places.length + ' 家馆名下都没有在架复本。' +
            '可能在编目，或都在借出中，过几天再来看看。';
        }
        // 出口说清「是哪几家」：按钮上带馆数，点进去就是那几家的卡片
        var borrowActs = [
          { act: 'set-filter', v: 'all', label: '看全部馆藏（' + places.length + ' 家）' }
        ];
        // 有电话就给一个直拨出口：站在空态页面上，最能帮上忙的下一步就是打一个电话
        // （桌面点 tel: 没反应，手机上直接拉起拨号——这个页面多数时候是在手机上看的）
        var telLib = places.filter(function (p) { return p.tel; })[0];
        if (telLib) borrowActs.push({ act: 'call', v: telLib.tel, label: '打给 ' + (telLib.display || telLib.name) });
        emptyHTML = emptyState({
          icon: borrowIcon,
          title: borrowTitle,
          desc: borrowDesc,
          actions: borrowActs
        });
      } else {
        // 兜底：有在架册、「营业中」也没勾，却一张卡都没有（馆藏数据是空的/只读不借一类）
        emptyHTML = emptyState({
          icon: 'book-x',
          title: '没有查到馆藏记录',
          desc: '上图有这本书的记录，但没挂出任何可借的分馆复本。可能是编目中，或只有保存本。',
          actions: [{ act: 'requery', label: '重新查询' }]
        });
      }
    }

    var more = '';
    if (shown.length > visible.length) {
      more = '<button class="ghost wide" id="more">显示其余 ' + (shown.length - visible.length) + ' 家</button>';
    } else if (S.showAll && shown.length > SHOW_LIMIT) {
      more = '<button class="ghost wide" id="more">收起</button>';
    }

    var notes = [];
    // 空态已经把事情说全了（标题 + 解释 + 按钮），提示条只在「有卡片但需要补充说明」时出现，
    // 否则会出现「一条提示 + 一个空态」两层说法，互相抢注意力
    if (!emptyHTML) {
      if (filterOn && S.onlyOpen) {
        var hiddenNow = availAll.length - shown.length;
        // 时间未知和假期待确认的馆必然在 hiddenNow 里（openNow 不会是 true），
        // 剩下的才是「按常规时间确定没在营业」
        var hiddenClosed = hiddenNow - unknownHours - holidayUnknown;
        if (hiddenNow > 0) {
          var why = [];
          if (hiddenClosed > 0) {
            why.push((todaySpecial ? '按常规时间未营业 ' : '未营业 ') + hiddenClosed + ' 家');
          }
          if (holidayUnknown > 0) why.push('开馆安排待确认 ' + holidayUnknown + ' 家');
          if (unknownHours > 0) why.push('开馆时间未知 ' + unknownHours + ' 家');
          // 多种原因才拆成「N 家：A x 家、B y 家」；只剩一种时别写成
          // 「已隐藏 1 家：开馆时间未知 1 家」，同一个数说两遍
          notes.push(why.length > 1
            ? '已隐藏 ' + hiddenNow + ' 家：' + why.join('、') + '。'
            : '已隐藏 ' + hiddenNow + ' 家' + (hiddenClosed
              ? (todaySpecial ? '按常规时间未营业（含今日闭馆）' : '未营业（含今日闭馆）')
              : holidayUnknown ? '开馆安排待确认' : '开馆时间未知') + '。');
        }
      }
    }
    // 结构异常用暖色警告样式：它意味着「下面的结果可能不完整」，得跟普通筛选提示区分开
    var noteCls = meta.layoutWarn ? 'note bar warn' : 'note bar';
    var note = notes.length
      ? '<div class="' + noteCls + '">' + notes.join(' ') + '</div>' : '';

    // 没定位时这个应用的主能力是废的：无法计算距离、排序退回可借册数、骑行用时也没有。
    // 这种状态得给一条能点的引导条（定位 / 手填地址），不能只靠灰字说明——
    // 灰字里那句「点右上角定位」要用户自己去找右上角的点，等于没有引导
    var geoBar = S.spot ? '' :
      '<div class="geobar">' + icon('locate') +
      '<span class="txt">尚未定位：无法计算距离，列表暂按可借册数排序</span>' +
      '<button type="button" class="sm" id="geoGo">定位</button>' +
      '<button type="button" class="sm" id="addrGo">手填地址</button>' +
      '</div>';

    // 数据超过 30 分钟：说清这是旧快照，并给一个一键重查。
    // 空态（比如「全城借空」或筛选后没有可借）同样要提示——那正是旧数据最容易误导人的场景；
    // 只有请求失败/结构异常两种空态已经各自说明数据不可信，不再叠加一条。
    var ds = dataStamp(meta);
    var staleBar = ds.stale && !meta.fetchErr && !meta.layoutWarn
      ? '<div class="note bar stale" role="status">' + icon('clock') +
        '<span class="txt">这份馆藏是<b>' + esc(ds.age) + '</b>的快照，在架状态可能已经变了。</span>' +
        '<button type="button" class="sm" id="staleRequery">重新查询</button>' +
        '</div>'
      : '';

    // 假期/调休日：各馆常会临时改开馆时间，而上图没有单独公布分馆假日时刻表。
    // 这里只做提醒，不把任何馆直接判成「今天不开门」——那比不确定更误导人。
    // 但「营业中」筛到一张卡都不剩时，空态本身已经把假期 + 打电话讲完了，
    // 再挂一条同样的提示条就是同一屏说两遍（跟上面「空态说话时不叠 note」同一条规矩）
    var holidayBar = (todaySpecial && !holidaySaid)
      ? '<div class="note bar holiday">' + icon('calendar') +
        '<span class="txt">今天是' + esc(specialName) + '，各馆开馆' +
        (todaySpecial.kind === 'holiday' ? '时间' : '安排') +
        '可能调整，去之前建议先打电话确认。</span>' +
        '</div>'
      : '';

    // 地图是**背景层**（section.result 的第一个子元素，fixed 铺满结果面板），
    // 卡片列盖在它上面。hasMap 只用来给卡片加不透明度（玻璃透出地图会压花正文）
    var hasMap = !!(canMap() && S.mapOn && window.innerWidth >= MAP_BG_MIN);
    // 重绘会把 #mapBox 整块换掉：先销毁旧实例，否则 resize 回调会去 resize 一个
    // 已经脱离文档的地图，高德内部随即抛错。hasMap 为真时由 drawMap 重新建。
    if (!hasMap) dropMap();
    // 地图做背景；有地图时结果列常驻在左侧、盖在地图上面（.has-map 一组样式管这件事）
    $('result').innerHTML = (hasMap ? mapHTML() : '') +
      '<div class="result-inner' + (hasMap ? ' has-map' : '') + '">' +
      '<div class="res-cols">' +
      '<div class="res-list">' +
      headHTML(book, meta) + geoBar + staleBar + holidayBar + toolbar + note + (emptyHTML || cards) + more +
      // 底部只留「数据是什么时候的」这一件必须知道的事。「耗时 X 秒」是工程指标，删了；
      // 「查了几个版本」挪进 title：想知道的人悬停就有，不需要的人少看一行灰字
      '<div class="note res-meta' + (ds.stale ? ' stale' : '') + '"' +
      ' title="' + esc(meta.total > meta.instances
        ? '查了前 ' + meta.instances + ' 个版本（共 ' + meta.total + ' 个）'
        : '查了 ' + meta.instances + ' 个版本') + '">' +
      '<span class="stale-time">' + ds.text + '</span>' +
      '</div>' +
      '</div>' +
      '</div></div>';

    bindResultEvents(book, shown, filterOn);
    ensureEditions(book);
    // 工具栏是整块重绘的，滑块没有可复用的 DOM：先按当前选中项直接摆好，
    // 切筛选时由 bindResultEvents 里那次点击再补一段从旧位置滑过来的动画
    var segEl = document.querySelector('.toolbar .seg');
    if (segEl) placeSegThumb(segEl);
    bindEmptyEvents();
    fillRides();
    sizeMap();
    // 地图画「列表里有的」：以前画的是全部 shown，折叠时（SHOW_LIMIT=30）地图上会多出
    // 列表里没有的 31 号、32 号，点了也对不上卡片。展开「显示其余 N 家」后这里自然变全
    drawMap(visible);
    // 地图层是透明态插进 DOM 的，两帧后补 in 触发淡入（见 revealMap）。
    // 少了这一步地图会永远停在 opacity 0——首查出结果时整块地图隐形就是这么来的
    revealMap();
  }

  // ---------------------------------------------------------------- 骑行 / 天气（高德）

  // 骑行超过这个直线距离就不算：10 km 骑车要 40 分钟以上，已经不是「顺路去借本书」的选项了
  var BIKE_MAX_M = 10000;

  // 图标代替「骑行」两个字，数字后面跟一个小号「分」
  var ICON_BIKE = icon('bike');

  function rideHTML(minutes, note) {
    if (minutes == null || isNaN(minutes)) return '';
    var n = Math.max(1, Math.round(minutes));
    return '<span class="ride bike" title="' + esc(note) + '">' +
      ICON_BIKE + n + '<span class="u">分</span></span>';
  }

  // 骑行用时是异步补的：先渲染，再逐行查，查到就填，失败就空着不留占位。
  function fillRides() {
    if (!S.spot) return;
    var from = S.spot.lng.toFixed(5) + ',' + S.spot.lat.toFixed(5);
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.rides[data-to]'));
    if (!nodes.length) return;

    var i = 0;
    function paint(el, r) {
      var m = parseFloat(el.getAttribute('data-m'));
      // isFinite：没坐标的馆 data-m 是空串，parseFloat 得 NaN
      // 超过 10 公里的不估用时（直线距离不是骑行距离，除出来的是编数），
      // 两种情况都留空：这一行本来就是「顺路骑车要几分钟」的附加信息，没有就没
      if (!isFinite(m) || m > BIKE_MAX_M) { el.innerHTML = ''; return; }
      el.innerHTML = (r && r.bike != null)
        ? rideHTML(r.bike, '骑行约 ' + r.bike + ' 分钟' +
          (r.bikeKm ? '，' + r.bikeKm + ' 公里' : ''))
        : '';
    }

    function one(el) {
      var to = el.getAttribute('data-to');
      var m = parseFloat(el.getAttribute('data-m'));
      var ck = from + '|' + to;
      var got = S.ride[ck];
      if (got) { paint(el, got); return Promise.resolve(); }

      var acc = {};
      // 无坐标的不发请求；超 10km 的发请求也没有意义
      if (!isFinite(m) || m > BIKE_MAX_M) return Promise.resolve();
      return apiGet('/api/cycling?from=' + from + '&to=' + to)
        .then(function (j) {
          acc.bike = j.minutes;
          acc.bikeKm = j.distance ? (j.distance / 1000).toFixed(1) : '';
          paint(el, acc);
          if (acc.bike != null) S.ride[ck] = acc;
        }).catch(function () {});
    }

    function worker() {
      if (i >= nodes.length) return Promise.resolve();
      return one(nodes[i++]).then(worker);
    }
    var runners = [];
    // 每行一次请求，并发压到 3，免得上图和高德都被打满
    for (var k = 0; k < 3; k++) runners.push(worker());
  }

  // ---------------------------------------------------------------- 地图（高德 JS API）
  //
  // 这里用的是**另一把** Key：上面骑行/天气是服务端拿「Web 服务」Key 去调 REST 接口，
  // 地图必须由浏览器自己加载 JS API，得用「Web端(JS API)」类型 + 安全密钥，两把不通用。
  // 脚本只在第一次需要时插一次；加载失败不重试，避免反复刷错误提示。

  var AMAP_STATE = 'idle';   // idle | loading | ready | fail
  var AMAP_QUEUE = [];       // 等脚本加载完的回调
  var MAP = null;            // 当前 AMap.Map 实例
  var MAP_MARKERS = [];      // 与 shown 同序（序号对得上卡片）
  var MAP_SHOWN = [];        // 这批 marker 对应的 places
  var MAP_BY_IDX = {};       // shown 下标 -> marker
  var MAP_INFO = null;       // 共用的自定义 InfoWindow
  var MAP_SHEET = null;      // 手机全屏地图的实例（跟背景地图分开，不能共用一个容器）
  var sheetReturnFocus = null;
  // 滚轮缩放是逐帧推的（见 onWheelZoom）：目标级别 + 自己记的浮点级别 + 光标下的地理点
  var zoomTarget = null;
  var zoomCur = null;
  var zoomAnchor = null;
  var zoomFrames = 0;
  var zoomRaf = 0;
  var zoomAnchorX = 0, zoomAnchorY = 0;

  function stopZoom() {
    if (zoomRaf) { cancelAnimationFrame(zoomRaf); zoomRaf = 0; }
    zoomTarget = null;
    zoomCur = null;
    zoomAnchor = null;
    zoomFrames = 0;
  }

  function amapCfg() { return (S.cfg && S.cfg.map) || {}; }
  function amapReady() { return !!(window.AMap && window.AMap.Map); }
  function canMap() { return !!amapCfg().key; }

  function dropMap() {
    stopZoom();
    if (MAP) { try { MAP.destroy(); } catch (e) {} }
    MAP = null;
    MAP_MARKERS = [];
    MAP_BY_IDX = {};
    MAP_SHOWN = [];
    MAP_INFO = null;
  }

  function resetAmap() {
    AMAP_STATE = 'idle';
    AMAP_QUEUE = [];
    dropMap();
    S.mapView = null;
  }

  function ensureAmap() {
    if (amapReady()) return Promise.resolve(window.AMap);
    if (!canMap()) return Promise.reject(new Error('没配地图 Key'));
    if (AMAP_STATE === 'fail') return Promise.reject(new Error('地图脚本加载失败'));
    return new Promise(function (res, rej) {
      AMAP_QUEUE.push({ res: res, rej: rej });
      if (AMAP_STATE === 'loading') return;
      AMAP_STATE = 'loading';
      var c = amapCfg();
      // 安全密钥必须在 JS API 脚本执行前写好，脚本内部会读这个全局
      if (c.security) window._AMapSecurityConfig = { securityJsCode: c.security };
      var s = document.createElement('script');
      s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(c.key);
      s.async = true;
      s.onload = function () {
        var ok = amapReady();
        AMAP_STATE = ok ? 'ready' : 'fail';
        AMAP_QUEUE.splice(0).forEach(function (q) {
          if (ok) q.res(window.AMap); else q.rej(new Error('地图对象没就绪'));
        });
      };
      s.onerror = function () {
        AMAP_STATE = 'fail';
        AMAP_QUEUE.splice(0).forEach(function (q) { q.rej(new Error('地图脚本没能下载')); });
      };
      document.head.appendChild(s);
    });
  }

  // 地图配色：亮色用「月光银」（light），暗色用「幻影黑」（dark）
  function mapStyleNow() {
    return document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'amap://styles/dark' : 'amap://styles/light';
  }

  // 地图不再是一张卡片，而是**结果区的背景**：整块铺满结果面板，卡片浮在它上面。
  // 外层 #mapWrap 交给 CSS 做 fixed 定位 + 边缘淡出遮罩，里面 .map-veil 只负责装高德容器
  // （遮罩和压暗只作用在 .map-veil 上，图例那颗小胶囊要保持清楚）。
  function mapHTML() {
    if (!S.mapOn || !canMap() || window.innerWidth < MAP_BG_MIN) return '';
    // aria-hidden 挂在装饰层（地图瓦片）上，不挂外层：外层现在装着实用的加减号按钮，
    // 整块藏起来的话读屏用户就按不到了
    return '<div class="map-bg" id="mapWrap">' +
      '<div class="map-veil" aria-hidden="true"><div class="map-box" id="mapBox"></div></div>' +
      '<div class="map-legend">' +
      // 图例要短且成对。灰点不能说「都借出」：只有馆内阅览本的馆也是灰的，
      // 那是「借不到」不是「借光了」
      '<i class="mdot ok"></i>有可借<i class="mdot no"></i>借不到' +
      // 「我的位置」只在定位成功后才上图例：没定位时图上没有橙点，图例不该凭空写它
      (S.spot ? '<i class="mdot me"></i>我的位置' : '') +
      '</div>' +
      // 加减号：滚轮毕竟要对着地图才有用，键盘/触控板用户给两个明摆着的按钮
      '<div class="map-zoom">' +
      '<button type="button" class="zbtn" id="recenter" title="回到我的位置" ' +
      'aria-label="回到我的位置">' + ICON_LOCATE + '</button>' +
      '<button type="button" class="zbtn" id="zoomIn" title="放大" aria-label="放大">' + ICON_PLUS + '</button>' +
      '<button type="button" class="zbtn" id="zoomOut" title="缩小" aria-label="缩小">' + ICON_MINUS + '</button>' +
      '</div>' +
      '</div>';
  }

  // 「回到我的位置」：桌面背景地图和手机全屏地图共用这一套。
  // 没定位时不把按钮做成死的——点一下说清该去哪儿设位置，比灰着不给理由好
  function recenterMap() {
    if (!S.spot) {
      toast('尚未获取位置：请点右上角的定位按钮，或手动填写地址', 'err');
      return;
    }
    var sheetOpen = $('mapSheet') && $('mapSheet').classList.contains('show');
    var map = sheetOpen ? MAP_SHEET : MAP;
    if (!map) return;
    var c = [S.spot.lng, S.spot.lat];
    var z = Math.max(13, Math.round(map.getZoom() || 13));
    try { map.setZoomAndCenter(z, c); } catch (e) {
      try { map.setCenter(c); } catch (e2) {}
    }
    if (!sheetOpen) S.mapView = { center: c, zoom: z };
  }

  // ---- 手机全屏地图
  // 桌面地图是结果区的背景；窄屏没有背景层，改为按需铺满整屏。
  // 两个 AMap 实例不共容器：这里单独建一张，关闭即销毁，不占内存。
  function openMapSheet() {
    var sheet = $('mapSheet');
    if (!sheet || !S.mapShown.length) return;
    var pts = [];
    S.mapShown.forEach(function (p, idx) {
      if (p.lat != null && p.lng != null) pts.push({ p: p, idx: idx });
    });
    if (!pts.length) return;
    sheetReturnFocus = document.activeElement;
    var me = $('msLegendMe');
    if (me) me.hidden = !S.spot;
    sheet.classList.add('show');
    sheet.setAttribute('aria-hidden', 'false');
    // 等一帧：容器拿到真实宽高后高德才量得准
    requestAnimationFrame(function () {
      if (!sheet.classList.contains('show')) return;
      try { $('mapSheetClose').focus(); } catch (e) {}
      drawSheetMap(pts);
    });
  }

  function closeMapSheet() {
    var sheet = $('mapSheet');
    if (!sheet || !sheet.classList.contains('show')) return;
    sheet.classList.remove('show');
    sheet.setAttribute('aria-hidden', 'true');
    if (MAP_SHEET) { try { MAP_SHEET.destroy(); } catch (e) {} MAP_SHEET = null; }
    restoreFocus(sheetReturnFocus);
    sheetReturnFocus = null;
  }

  function drawSheetMap(pts) {
    var box = $('msMap');
    if (!box) return;
    ensureAmap().then(function (AMap) {
      // 脚本是异步回来的：这期间用户可能已经关掉了
      if (!$('mapSheet').classList.contains('show')) return;
      if (MAP_SHEET) { try { MAP_SHEET.destroy(); } catch (e) {} MAP_SHEET = null; }
      // 上一次失败留下的 .ms-fail 不能跟着新地图一起显示
      box.innerHTML = '';
      MAP_SHEET = new AMap.Map(box, {
        zoom: 12,
        center: S.spot ? [S.spot.lng, S.spot.lat] : [pts[0].p.lng, pts[0].p.lat],
        mapStyle: mapStyleNow(),
        viewMode: '2D',
        showLabel: true,
        resizeEnable: true
      });
      var marks = [];
      pts.forEach(function (it) {
        var mk = new AMap.Marker({
          position: [it.p.lng, it.p.lat],
          content: '<div class="mpin ' + (it.p.available ? 'ok' : 'no') + '">' + (it.idx + 1) + '</div>',
          // 全屏地图上的标记在 CSS 里放大到 28px，偏移跟着改
          offset: new AMap.Pixel(-14, -14),
          zIndex: 100,
          title: it.p.display,
          map: MAP_SHEET
        });
        // 点标记 → 关掉地图、回到列表并高亮那张卡。
        // 不在手机上开信息窗：整屏地图里它正好挡住落点附近的馆。
        // destroy 必须推迟到本次事件派发结束：高德在回调返回后还要读地图实例
        // （containerTolnglat），当场销毁会抛错
        mk.on('click', function () {
          setTimeout(function () {
            closeMapSheet();
            hitCard(it.idx);
          }, 0);
        });
        marks.push(mk);
      });
      if (S.spot) {
        new AMap.Marker({
          position: [S.spot.lng, S.spot.lat],
          content: '<div class="mpin me"></div>',
          offset: new AMap.Pixel(-7, -7),
          zIndex: 130,
          title: '我的位置',
          map: MAP_SHEET
        });
      }
      if (MAP_SHEET.resize) { try { MAP_SHEET.resize(); } catch (e) {} }
      if (marks.length) fitMapTo(MAP_SHEET, box, marks, 60);
    }).catch(function (e) {
      box.innerHTML = '<div class="ms-fail">地图没加载出来：' + esc(e.message) +
        '。检查设置里的 Web 端 Key 和安全密钥。</div>';
    });
  }

  // 地图做背景的最小窗口宽：再窄结果区本来就占满，地图铺在背后只会把正文衬花。
  // 必须和 style.css 里那条 @media 的断点一致
  var MAP_BG_MIN = 861;
  // 手机断点：也必须是 style.css 里最后那条 @media 的断点
  var NARROW_W = 640;

  // ---------------------------------------------------------------- 头部占位

  // 头部（药丸检索 + 圆钮）是 fixed 的，本身不占布局高度，两列的滚动区内得替它让出位置。
  // 手机上头部会折成两行、矮屏下药丸还会缩一档，高度不是常数，所以量出来写进 --hdr-h
  function measureHeader() {
    var h = $('bar');
    if (!h) return;
    var px = Math.round(h.getBoundingClientRect().height);
    if (px) document.documentElement.style.setProperty('--hdr-h', px + 'px');
  }

  // 背景地图是 fixed + inset 定位，尺寸由 CSS 给，JS 只在高德那边重算一次瓦片。
  // 窗口尺寸一变（书单收起、换分辨率）就得叫一次，否则瓦片会拉伸或留边
  function sizeMap() {
    if (!MAP) return;
    if (window.innerWidth < MAP_BG_MIN) return;
    if (MAP.resize) { try { MAP.resize(); } catch (e) {} }
  }

  // 地图层淡入：.map-bg 是透明态插进 DOM 的（style.css 里 .map-bg:not(.in)），
  // 两帧后补 in 让 opacity 过渡跑起来。首查、切筛选、重新查询、设置里改默认，
  // 全都靠 renderResult 末尾调它——没有 in 地图会永远停在 opacity 0（隐形）
  function revealMap() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var w = $('mapWrap');
        if (w) w.classList.add('in');
      });
    });
  }

  // 地图开/关：position 从 fixed 变 static 是不可过渡的，直接重绘就是整列瞬移。
  // 关：先给地图层加 leaving（opacity .22s 淡出），淡完再重绘，结果列靠自己的
  // resIn 滑入补上位置变化；开：先重绘让地图以透明态插入，renderResult 末尾的
  // revealMap 两帧后补 in 淡入，跟结果列的滑入叠成一次交叉过渡
  function toggleMap() {
    S.mapOn = !S.mapOn;
    lsSet('shlib.map', S.mapOn ? '1' : '0');
    S.mapView = null;   // 重新展开时按当前结果重新框一次
    syncMapSeg(S.mapOn);
    // 没选书：结果区还是初始空态，重绘会把它换成转圈骨架。只改值和记忆，不动界面
    if (!S.activeId) return;
    var wrap = $('mapWrap');
    if (!S.mapOn && wrap) {
      wrap.classList.add('leaving');
      setTimeout(renderResult, 220);
    } else {
      renderResult();
    }
  }

  function infoHTML(p, idx) {
    var a = availStatus(p);
    var st = icon(a.icon) + (a.sr ? '<span class="sr">' + a.sr + '</span>' : '') + a.text;
    var meta = [];
    if (p.distanceText) meta.push(esc(p.distanceText));
    if (p.today) meta.push(openInfoHTML(p));
    else meta.push('<span class="iw-st notime">开馆时间未知</span>');
    if (p.callnos && p.callnos.length) meta.push('索书号 ' + esc(p.callnos[0]));
    return '<div class="iw">' +
      '<div class="iw-h"><i class="' + (p.available ? 'ok' : 'no') + '">' + (idx + 1) + '</i>' +
      esc(p.display) + '</div>' +
      '<div class="iw-b"><span class="avail ' + a.cls + '" title="' + esc(a.title) + '">' +
      st + '</span>' +
      (meta.length ? '<div class="iw-s">' + joinSep(meta) + '</div>' : '') +
      (p.address ? '<div class="iw-s">' + esc(p.address) + '</div>' : '') +
      '</div></div>';
  }

  function drawMap(shown) {
    var box = $('mapBox');
    if (!box) return;
    var pts = shown.filter(function (p) { return p.lat != null && p.lng != null; });
    if (!pts.length) {
      // 一家有坐标的都没有：地图没信息量，整列收起，列表也退回单列宽度
      var wrap = $('mapWrap');
      if (wrap) wrap.classList.add('hidden');
      var inner = document.querySelector('.result-inner.has-map');
      if (inner) inner.classList.remove('has-map');
      return;
    }
    ensureAmap().then(function (AMap) {
      // 加载是异步的，回来时页面可能已经重绘过，这个容器已经不在 DOM 里了
      if ($('mapBox') !== box) return;
      if (MAP) {
        // 重绘会换掉这个实例，滚轮那段逐帧推进必须先停，否则下一帧会去问一个
        // 已经销毁的地图要 zoom
        stopZoom();
        try { MAP.destroy(); } catch (e) {}
        MAP = null;
      }

      // 取景有三种情形，优先级从高到低：
      // ① 用户刚点过定位（spotRecenter）：以「我」为中心，把人放在画面正中——
      //    否则 fitAll 的取景框每次都一样，挪了两公里地图看着纹丝不动，只当没刷新
      // ② 记住了视野（keep）：沿用，别切个筛选就乱跳
      // ③ 都没有：把所有馆框进来（首屏默认视角）
      var recenter = S.spotRecenter;
      S.spotRecenter = false;
      var keep = recenter ? null : S.mapView;
      var center, zoom;
      if (recenter && S.spot) {
        center = [S.spot.lng, S.spot.lat];
        zoom = 13;                 // 街区级：看得见周围几家馆
      } else if (keep) {
        center = keep.center;
        zoom = keep.zoom;
      } else {
        center = S.spot ? [S.spot.lng, S.spot.lat] : [pts[0].lng, pts[0].lat];
        zoom = 12;
      }
      MAP = new AMap.Map(box, {
        zoom: zoom,
        center: center,
        mapStyle: mapStyleNow(),
        viewMode: '2D',
        showLabel: true,
        resizeEnable: true,
        // 滚轮由下面的 onWheelZoom 自己处理，高德那套必须关掉：两边都收 wheel 时，
        // 它在动画里往回拽、我们把 zoom 拍到位，实测滚一格会先上去再掉回来
        scrollWheel: false,
        dragEnable: true,
        zoomEnable: true,
        doubleClickZoom: true
      });
      // 容器高度是按视口算出来的，创建后让高德按实际尺寸再算一次瓦片
      if (MAP.resize) { try { MAP.resize(); } catch (e) {} }
      // 滚轮缩放自己来：高德 2.0 在「fixed 容器 + pointer-events 覆盖层」这套结构里
      // 会 preventDefault 掉 wheel 却不改 zoom（实测 zoom 纹丝不动），
      // 所以在捕获阶段拿住事件自己算——顺便能用光标所在点做锚点，缩放时鼠标下的地方不动
      if (!box.__wheelBound) {
        box.__wheelBound = true;
        box.addEventListener('wheel', function (e) { onWheelZoom(e, box); },
          { passive: false, capture: true });
      }
      // 调试钩子：只有 ?debug=1 时才挂出去（截图/自动检查脚本要用）
      if (/[?&]debug=1/.test(location.search)) window.__MAP = MAP;

      // pts 是筛掉「没坐标」之后的数组，下标跟 shown 对不上，
      // 所以另建一张 idx → marker 的表，供卡片反查
      MAP_SHOWN = shown;
      MAP_MARKERS = [];
      MAP_BY_IDX = {};
      pts.forEach(function (p) {
        var idx = shown.indexOf(p);
        var mk = new AMap.Marker({
          position: [p.lng, p.lat],
          content: '<div class="mpin ' + (p.available ? 'ok' : 'no') + '">' + (idx + 1) + '</div>',
          offset: new AMap.Pixel(-12, -12),
          zIndex: 100,
          title: p.display,
          map: MAP
        });
        mk.on('click', function () { openInfo(p, idx); hitCard(idx); });
        MAP_MARKERS.push(mk);
        MAP_BY_IDX[idx] = mk;
      });

      if (S.spot) {
        new AMap.Marker({
          position: [S.spot.lng, S.spot.lat],
          content: '<div class="mpin me"></div>',
          offset: new AMap.Pixel(-7, -7),
          zIndex: 130,
          title: '我的位置',
          map: MAP
        });
      }

      // 取景：以我为中心时不框所有点（框了等于又回到全市全景，「没刷新」的观感照旧）
      if (!keep && !recenter) fitAll();
      else {
        MAP.on('moveend', saveView);
        MAP.on('zoomend', saveView);
      }
    }).catch(function (e) {
      var wrap = $('mapWrap');
      if (!wrap) return;
      wrap.innerHTML = '<div class="map-fail">地图没加载出来：' + esc(e.message) +
        '。检查设置里的 JS API Key 和安全密钥。</div>';
    });
  }

  // 光标下那个地理点：滚轮期间它必须一直待在光标底下。
  // 每帧**现量**它现在在屏幕哪，再按「把它挪回去」求新中心——不要按级别差代数推算：
  // 高德会把 zoom 量化（设 9.6、回报 9.59），推算出来的位移和实际差一点点，
  // 而这个差会在逐帧里一帧一帧累成平移，表现就是「松手了地图还在自己动」
  function pointUnder(px, py) {
    if (!MAP || !MAP.containerToLngLat || !window.AMap || !window.AMap.Pixel) return null;
    try { return MAP.containerToLngLat(new window.AMap.Pixel(px, py)); } catch (e) { return null; }
  }

  // 缩放到 next 后，要让 zoomAnchor 仍落在 (zoomAnchorX, zoomAnchorY) 上，中心该在哪：
  // 放大 k 倍，锚点相对中心的偏移也放大 k 倍。k·(p − C) = v → C = p − v/k
  // （p = 锚点现在的屏幕位置，v = 光标相对容器中心的偏移）
  function centerForAnchor(next, cur, box) {
    if (!MAP || !zoomAnchor || !MAP.lngLatToContainer || !window.AMap || !window.AMap.Pixel) return null;
    var k = Math.pow(2, next - cur);
    if (!isFinite(k) || k <= 0) return null;
    var p;
    try { p = MAP.lngLatToContainer(zoomAnchor); } catch (e) { return null; }
    if (!p) return null;
    var px = p.getX ? p.getX() : p.x, py = p.getY ? p.getY() : p.y;
    var cx = px - (zoomAnchorX - box.clientWidth / 2) / k;
    var cy = py - (zoomAnchorY - box.clientHeight / 2) / k;
    try { return MAP.containerToLngLat(new window.AMap.Pixel(cx, cy)); } catch (e) { return null; }
  }

  // 滚轮缩放：一格（deltaY 100）走 0.6 级，够接近系统缩放的力度又不至于一碰就飞出去。
  // 关键是**逐帧逼近**而不是「每个 wheel 事件 setZoom 一次」——后者会让高德每来一个事件
  // 就重起一段 200ms 动画，轮子转得快时地图就一顿一顿的
  var WHEEL_ZOOM_PER_PX = 0.006;
  var ZOOM_EASE = 0.3;          // 每帧吃掉剩余距离的 30%：约 12 帧（200ms）贴住目标
  var ZOOM_EPS = 0.01;          // 剩下不到这点就落位。0.01 级不到 1px，再追看不见
  var ZOOM_MAX_FRAMES = 60;     // 保险丝：万一哪帧就是不收敛，1 秒后强制落位

  function onWheelZoom(e, box) {
    if (!MAP || !e.deltaY) return;
    e.preventDefault();
    e.stopPropagation();
    // deltaMode：0 像素（触控板）、1 行、2 页。统一折成像素再算，否则一格滚轮在
    // 不同浏览器里从 0.6 级到 20 级都有可能
    var dy = e.deltaY * (e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 100 : 1));
    if (zoomCur === null) zoomCur = MAP.getZoom();
    var base = zoomTarget === null ? zoomCur : zoomTarget;
    var next = Math.max(3, Math.min(19, base - dy * WHEEL_ZOOM_PER_PX));
    if (Math.abs(next - base) < 1e-4) return;
    zoomTarget = next;
    var r = box.getBoundingClientRect();
    zoomAnchorX = e.clientX - r.left;
    zoomAnchorY = e.clientY - r.top;
    zoomAnchor = pointUnder(zoomAnchorX, zoomAnchorY);
    zoomFrames = 0;
    if (prefersReducedMotion()) { landZoom(box); return; }
    if (!zoomRaf) zoomRaf = requestAnimationFrame(function () { pumpZoom(box); });
  }

  // 收敛看的是**自己记的浮点级别**（zoomCur），不是 MAP.getZoom()：
  // 后者是量化过的，拿它算「还差多少」会永远差一点点，rAF 就一直空转
  function pumpZoom(box) {
    zoomRaf = 0;
    if (!MAP || zoomTarget === null) { zoomCur = null; return; }
    if (prefersReducedMotion() || ++zoomFrames > ZOOM_MAX_FRAMES) { landZoom(box); return; }
    if (zoomCur === null) zoomCur = MAP.getZoom();
    var left = zoomTarget - zoomCur;
    if (Math.abs(left) < ZOOM_EPS) { landZoom(box); return; }
    zoomCur += left * ZOOM_EASE;
    stepZoom(zoomCur, box);
    zoomRaf = requestAnimationFrame(function () { pumpZoom(box); });
  }

  // 落位：还可能是没走完的一帧（用户突然停手 / 关掉了动效），最后一步必须精确到目标
  function landZoom(box) {
    if (!MAP || zoomTarget === null) { stopZoom(); return; }
    var z = zoomTarget;
    zoomTarget = null;
    zoomCur = null;
    stepZoom(z, box);
    saveView();
  }

  // 单步：immediately=true 是必须的。不传这个参数高德会自己起一段 200ms 动画，
  // 逐帧推就变成了逐帧重启动画，比原来还抖。
  // 中心始终按「锚点现在在哪」现算，所以某帧被高德吸到别的级别上也不会把误差留到下一帧
  function stepZoom(next, box) {
    if (!MAP) return;
    var c = box ? centerForAnchor(next, MAP.getZoom(), box) : null;
    try {
      if (c) MAP.setZoomAndCenter(next, c, true);
      else MAP.setZoomAndCenter(next, MAP.getCenter(), true);
    } catch (e) {}
  }

  // 加减号按钮：按中心缩放整级，交给高德动画。
  // 先把滚轮那段逐帧推进掐掉，否则两边会抢 zoom，按完 + 号又被惯性拽回去
  function zoomStep(dz) {
    if (!MAP) return;
    stopZoom();
    var z = Math.max(3, Math.min(19, Math.round(MAP.getZoom()) + dz));
    try { MAP.setZoom(z); } catch (e) {}
  }

  function saveView() {
    if (!MAP) return;
    var c = MAP.getCenter();
    S.mapView = { center: [c.lng, c.lat], zoom: MAP.getZoom() };
  }

  // 取景：容器本身就等于「面板右边看得见的那半块」（见 style.css 的 .map-bg），
  // 所以只要把这组点框满容器就行。高德自带的 setFitView 在这儿不生效（实测标记纹丝不动），
  // 还是自己量：先落到 12 级量像素跨度，按比例反推级别，再把包围盒中心摆到容器正中。
  // 上下留 70：上面躲开浮着的药丸、下面躲开图例。
  // 左右留白按容器宽度走（10%，40~84）：固定 84 在 900px 窗口里只剩 100px 可用，
  // 视野会被拉远到整个长三角；这条比例正好让最西边的标记落在左沿淡出之外。
  var FIT_PAD_Y = 70;

  function fitPadX(w) {
    return Math.max(40, Math.min(84, Math.round(w * 0.1)));
  }

  function fitAll() {
    if (!MAP) return;
    var list = MAP_MARKERS.slice();
    var done = false;
    try { done = fitToContainer(list); } catch (e) { done = false; }
    if (!done) {
      try { MAP.setFitView(list, false, FIT_PAD_Y, 14); } catch (e) {}
    }
    MAP.on('moveend', saveView);
    MAP.on('zoomend', saveView);
  }

  function fitToContainer(list) {
    return fitMapTo(MAP, $('mapBox'), list, FIT_PAD_Y);
  }

  // 同一套取景算法给桌面背景地图和手机全屏地图共用
  function fitMapTo(map, box, list, padY) {
    var AMap = window.AMap;
    if (!box || !map || !AMap || !AMap.LngLat) return false;
    if (!map.lngLatToContainer || !map.setZoomAndCenter) return false;
    var pts = list.map(function (m) { return m.getPosition(); })
      .filter(function (p) { return p && p.lng != null && p.lat != null; });
    if (!pts.length) return false;

    var W = box.clientWidth, H = box.clientHeight;
    if (!W || !H) return false;
    var vw = Math.max(120, W - fitPadX(W) * 2);
    var vh = Math.max(160, H - padY * 2);

    var lngs = pts.map(function (p) { return p.lng; });
    var lats = pts.map(function (p) { return p.lat; });
    var minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var c = new AMap.LngLat((minLng + maxLng) / 2, (minLat + maxLat) / 2);

    // 墨卡托每一级正好差一倍：在 12 级量跨度，按比例取 log2，向下取整保证装得下
    map.setZoomAndCenter(12, c);
    var p1 = map.lngLatToContainer(new AMap.LngLat(minLng, maxLat));
    var p2 = map.lngLatToContainer(new AMap.LngLat(maxLng, minLat));
    var spanX = Math.abs(pxOf(p2, 'x') - pxOf(p1, 'x')) || 1;
    var spanY = Math.abs(pxOf(p2, 'y') - pxOf(p1, 'y')) || 1;
    var z = 12 + Math.log(Math.min(vw / spanX, vh / spanY)) / Math.LN2;
    z = Math.max(3, Math.min(14, Math.floor(z)));   // 14 = 上限，别放大到街角
    map.setZoomAndCenter(z, c);
    return true;
  }

  // AMap 的 Pixel 有的版本给 x/y 属性、有的给 getX()/getY()，两种都接住
  function pxOf(p, k) {
    if (!p) return 0;
    if (p[k] != null) return p[k];
    var fn = p['get' + k.toUpperCase()];
    return typeof fn === 'function' ? fn.call(p) : 0;
  }

  function openInfo(p, idx) {
    if (!MAP || !window.AMap) return;
    if (!MAP_INFO) {
      MAP_INFO = new window.AMap.InfoWindow({
        isCustom: true,
        content: '',
        offset: new window.AMap.Pixel(0, -30),
        closeWhenClickMap: true
      });
    }
    MAP_INFO.setContent(infoHTML(p, idx));
    MAP_INFO.open(MAP, [p.lng, p.lat]);
  }

  // 点卡片 → 地图飞过去；点标记 → 卡片高亮并滚进来
  function focusPlace(idx) {
    if (!MAP || !MAP_BY_IDX[idx]) return;
    var mk = MAP_BY_IDX[idx];
    var pos = mk.getPosition();
    MAP.setZoomAndCenter(Math.max(MAP.getZoom(), 14), [pos.lng, pos.lat]);
    var p = MAP_SHOWN[idx];
    if (p) openInfo(p, idx);
  }

  function hitCard(idx) {
    var card = document.querySelector('.card[data-idx="' + idx + '"]');
    if (!card) return;   // 被「显示其余 N 家」折叠着，就不折腾了
    Array.prototype.forEach.call(document.querySelectorAll('.card.hit'), function (c) {
      c.classList.remove('hit');
    });
    // 同一张卡重复点名时，先 remove 再 add 不会重放脉冲动画（同一样式批处理），
    // 强制读一次布局让浏览器把上一条样式结算掉，动画才能重新起跑
    void card.offsetWidth;
    card.classList.add('hit');
    if (card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }


  // 馆内阅览的三类：有复本，但不能外借。可借数只统计普通/少儿外借，
  // 所以一家馆可能 total === 0、这几类却有册数——不能再把它说成「全部借出」。
  var IN_HOUSE_KINDS = ['reference', 'preserved', 'other'];

  function inHouseTotal(p) {
    var kn = (p && p.kinds) || {};
    var n = 0;
    IN_HOUSE_KINDS.forEach(function (k) {
      var g = kn[k];
      if (g) n += g.total || 0;
    });
    return n;
  }

  // 借阅状态的唯一出处：X/Y 可借、0/N 无可外借、仅馆内。
  // 卡片和信息窗都从这里取，避免一边写「全部借出，共 0」另一边写「仅馆内」。
  function availStatus(p) {
    if (p.available > 0) {
      return {
        cls: 'ok', icon: 'book-check', text: p.available + '/' + p.total,
        sr: '可借 ', title: '可借 ' + p.available + ' / 共 ' + p.total + ' 册'
      };
    }
    if (p.total === 0 && inHouseTotal(p) > 0) {
      return {
        cls: 'no inhouse', icon: 'eye', text: '仅馆内', sr: '',
        title: '只有馆内阅览本，不能外借'
      };
    }
    return {
      cls: 'no', icon: 'book-x', text: '0/' + p.total,
      sr: '无可外借 ', title: '外借本已全部借出，共 ' + p.total + ' 册'
    };
  }

  function availBadgeHTML(p) {
    var a = availStatus(p);
    return '<span class="tag ' + a.cls + '" title="' + esc(a.title) + '">' +
      icon(a.icon) + (a.sr ? '<span class="sr">' + a.sr + '</span>' : '') + a.text + '</span>';
  }

  // 「今日 9:00-20:00 营业中」这类文字，卡片和信息窗共用
  function todayText(p) {
    // 假期/调休日按常规时间闭馆：只是待确认，不能补一句「已闭馆」
    if (p.holidayUnknown) return esc(p.today);
    return p.today === '今日闭馆'
      ? '今日闭馆'
      : esc(p.today) + (p.openNow ? ' 营业中' : ' 已闭馆');
  }

  function holidayTitle(p) {
    var sp = p.holiday || {};
    return '按常规开放时间今天闭馆，但今天是' +
      (sp.name || '') + (sp.kind === 'workday' ? '调休工作日' : '假期') +
      '，开馆安排可能调整，去之前建议先打电话确认';
  }

  function openTagHTML(p) {
    if (p.holidayUnknown) {
      return '<span class="tag notime" title="' + esc(holidayTitle(p)) + '">' +
        esc(p.today) + '</span>';
    }
    var t = todayText(p);
    // 没在营业就补一句「下次几点开」：明天能不能跑一趟是决策信息，不能要用户自己猜。
    // 当天已过早时段、下午还有第二段时说的是「今天」；原文一条都没解析出来的
    // （写法没认出来），或推算会跨进假期/调休日时，nextOpenAt 返回 null，不编时间
    var next = '';
    if (!p.openNow) {
      var nx = SHLIB.nextOpenAt(p.hours);
      if (nx) next = '<span class="next">· ' + esc(nx.when) + ' ' + esc(nx.at) + ' 开</span>';
    }
    return '<span class="tag ' + (p.openNow ? 'open' : 'closed') + '">' + t + next + '</span>';
  }

  function openInfoHTML(p) {
    if (p.holidayUnknown) {
      return '<span class="iw-st closed" title="' + esc(holidayTitle(p)) + '">' +
        esc(p.today) + '</span>';
    }
    var t = todayText(p);
    var next = '';
    if (!p.openNow) {
      var nx = SHLIB.nextOpenAt(p.hours);
      if (nx) next = ' · ' + esc(nx.when) + ' ' + esc(nx.at) + ' 开';
    }
    return '<span class="iw-st ' + (p.openNow ? 'open' : 'closed') + '">' + t + next + '</span>';
  }

  // 上图压根没给开放时间（479 家里有 37 家），或原文写法没认出来 → today 为空。
  // 以前这里什么都不渲染，看不出是「没数据」还是「程序漏了」，
  // 而且这类馆会被「营业中」当成在营业放过去。现在明说「未知」，并且不再算营业中。
  function noHoursTagHTML() {
    return '<span class="tag notime" title="上图没有这家馆的开馆时间，无法判断此刻是否营业，去之前建议先打电话确认">' +
      '开馆时间未知</span>';
  }

  // 借阅类型分两簇：外借类型一簇、馆内类型一簇。
  // 同一簇内部用「·」，簇之间仍由 .badges 的「|」分隔；馆内只保留一个眼睛。
  // 保存本/参考外借不能外借，但读者可能想在馆内看，别丢掉。
  // availOnly=true（「只看可借」视图）：馆内这一簇跟可借视图矛盾，整簇不渲染，
  // 结果区只保留「X/Y 可借」一种信息，避免噪音。
  function kindTagsHTML(p, availOnly) {
    var order = ['general', 'children', 'reference', 'preserved', 'other'];
    var kn = p.kinds || {};
    // 「普通外借 3/5」跟左边那个「3/5 可借」是同一组数字，默认不出：
    //  - 没有馆内本时，整枚标签纯重复；
    //  - 有馆内本、但普通外借是唯一外借类型时，N/M 仍是同一组数字，同样重复。
    // 只有普通 + 少儿外借并存时，N/M 是两者合计，才需要这枚标签把数字拆开。
    var inHouseVisible = !availOnly && inHouseTotal(p) > 0;
    var lend = [];
    var inhouse = [];
    order.forEach(function (k) {
      var g = kn[k];
      if (!g || !g.total) return;
      // 可借视图：参考外借 / 保存本 / 馆内阅览（不能外借）一律不出
      if (availOnly && IN_HOUSE_KINDS.indexOf(k) !== -1) return;
      if (k === 'general' && (!inHouseVisible || g.total === p.total)) return;
      var lbl = SHLIB.KIND_LABEL[k];
      if (k === 'general' || k === 'children') {
        lend.push('<span class="ki">' + lbl + ' ' +
          (g.avail ? '<b>' + g.avail + '</b>/' + g.total : '已借出') + '</span>');
      } else {
        inhouse.push('<span class="ki">' + lbl + ' ' + g.total + '</span>');
      }
    });
    var out = [];
    if (lend.length) {
      out.push('<span class="tag kind kg lend-group">' + lend.join('') + '</span>');
    }
    if (inhouse.length) {
      out.push('<span class="tag kind dim kg inhouse-group" title="馆内阅览，不能外借">' +
        '<span class="sr">馆内阅览，不能外借：</span>' + icon('eye') + inhouse.join('') + '</span>');
    }
    return out.join('');
  }

  function cardHTML(p, idx) {
    // 三行封顶：① 序号 + 馆名 + 拨号/导航 + 距离 ② 可借/开放/借阅类型 + 右端骑行用时 ③ 索书号 + 库室
    // 区字段（p.zone）现在只在匹配分馆时用，不再上屏
    var badges = [];
    badges.push(availBadgeHTML(p));
    if (p.today) badges.push(openTagHTML(p));
    else badges.push(noHoursTagHTML());
    badges.push(kindTagsHTML(p, S.filter === 'avail'));

    // 索书号可能很长（版次 + 复本号），屏幕上会截断成省略号，
    // 所以 title 里带全文：鼠标停上去能看全，点了复制的也永远是全文
    var callnos = p.callnos.map(function (c) {
      return '<span class="callno" data-copy="' + esc(c) + '" title="' + esc(c) + '（点击复制）">' + esc(c) + '</span>';
    }).join('');

    // 地址不再铺在卡片上（列表里最长、最占地方，真正要用的人是站在馆门口导航过去的）。
    // 电话和导航收成两个图标：点电话直接拨号（tel:），点箭头直接发起导航（高德 URI，手机会拉起 App）
    var acts = [];
    if (p.tel) {
      var dial = dialNo(p.tel);
      if (dial) {
        acts.push('<a class="ico" href="tel:' + dial + '" title="拨打 ' + esc(p.tel) + '"' +
          ' aria-label="拨打 ' + esc(p.tel) + '">' + ICON_TEL + '</a>');
      }
    }
    if (p.lat != null && p.lng != null) {
      acts.push('<a class="ico" href="https://uri.amap.com/navigation?to=' + p.lng + ',' + p.lat + ',' +
        encodeURIComponent(p.display) + '&mode=car&coordinate=gaode&callnative=1"' +
        ' target="_blank" rel="noreferrer" title="导航到 ' + esc(p.display) + '"' +
        ' aria-label="导航到 ' + esc(p.display) + '">' + ICON_NAV + '</a>');
    } else if (p.address) {
      // 没坐标的馆（网借中心之类）没有目的地，只能按地址在地图上搜
      acts.push('<a class="ico" href="https://uri.amap.com/search?keyword=' + encodeURIComponent(p.address) +
        '" target="_blank" rel="noreferrer" title="在地图上搜 ' + esc(p.address) + '"' +
        ' aria-label="在地图上搜 ' + esc(p.address) + '">' + ICON_NAV + '</a>');
    }
    var actsHTML = acts.length ? '<span class="acts">' + acts.join('') + '</span>' : '';

    // 骑行用时：挂在第二行最右（margin-left:auto），正好落在第一行「距离」的下方——
    // 「多远」和「多久」竖着对成一列，读起来是一组。先留空容器，算好再填（空时 display:none）
    var rides = (S.spot && p.lat != null && p.lng != null)
      ? '<span class="rides" data-to="' + p.lng + ',' + p.lat + '" data-m="' +
        (p.distance != null ? Math.round(p.distance) : '') + '"></span>'
      : '';

    // 库室留在第三行，跟索书号并排。超过 3 个不显示；单个超长按 ellipsis 截断，
    // 全名放 title 里悬停可看（2026-10-21 定：截断 + 悬停看全名）
    var roomsTxt = (p.rooms.length && p.rooms.length <= 3) ? p.rooms.join(' | ') : '';
    var rooms = roomsTxt
      ? '<span class="rooms" title="' + esc(roomsTxt) + '">' + esc(roomsTxt) + '</span>'
      : '';

    // 索书号和库室是「站到架子跟前才用」的信息，几十张卡逐行铺开只会把「哪家能借」推远。
    // 默认收成一枚「索书号 · 库室 ▾」：点一下钉住展开，桌面鼠标停在卡上也临时给全
    var foot = '';
    if (callnos || rooms) {
      var fKey = p.name || p.display;
      var fOpen = !!S.footOpen[fKey];
      foot = '<div class="foot' + (fOpen ? ' open' : '') + '">' +
        '<button type="button" class="foot-tgl" data-foot-toggle="' + esc(fKey) + '"' +
        ' aria-expanded="' + (fOpen ? 'true' : 'false') + '">索书号 · 库室' +
        icon('chevron-down') + '</button>' +
        '<div class="foot-body">' +
        (callnos ? '<span class="callnos">' + callnos + '</span>' : '') +
        rooms + '</div></div>';
    }

    // 序号跟地图上的标记一一对应。没坐标的馆地图上没标记，给它编号只会让人对不上，干脆不编。
    // 窄屏没有背景地图，但工具栏上有「全屏地图」按钮，标记编号照样要看得到，
    // 所以「地图开着」或「窄屏（用全屏地图）」都显示序号。
    var hasPin = p.lat != null && p.lng != null;
    var no = (hasPin && canMap() && (S.mapOn || window.innerWidth < MAP_BG_MIN))
      ? '<span class="idx" title="对应地图上的 ' + (idx + 1) + ' 号标记">' + (idx + 1) + '</span>' : '';

    // 第一行右侧一簇：拨号/导航 → 距离（骑行用时已挪到第二行右端，见 rides 的注释）
    var distHTML = '<span class="dist' + (p.distanceText ? '' : ' none') + '">' +
      (p.distanceText || '距离未知') + '</span>';

    // with-idx：有徽标时第二三行才补 26px 左padding 跟馆名对齐（见 style.css）。
    // 地图折叠 / 无坐标馆不渲染徽标，馆名贴左沿，这两行也跟着贴齐。
    // --ci：错峰进入的序号（第 10 张起钳在 9，见 style.css 的 cardIn）——
    // 切筛选时整列重绘，卡片按次序依次就位比整批硬切有次序感
    return '<div class="card' + (p.available ? '' : ' out') + (no ? ' with-idx' : '') + '"' +
      ' style="--ci:' + Math.min(idx, 9) + '"' +
      (hasPin ? ' data-idx="' + idx + '"' : '') + '>' +
      '<div class="row1">' + no + '<span class="name">' + esc(p.display) + '</span>' +
      '<span class="rside">' + actsHTML + distHTML + '</span></div>' +
      '<div class="meta"><div class="badges">' + badges.join('') + '</div>' + rides + '</div>' +
      foot +
      '</div>';
  }

  function bindResultEvents(book, shown, filterOn) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (b) {
      b.addEventListener('click', function () {
        var from = segOnPos(document.querySelector('.toolbar .seg'));
        var list = document.querySelector('.res-list');
        var scrollPos = list ? list.scrollTop : 0;
        S.filter = b.getAttribute('data-filter');
        // 不重置 showAll：用户点了「显示其余 N 家」后切筛选，期望仍看到全部结果，
        // 而不是又退回前 30 家再点一次。156→30→30 的体验问题
        renderResult();
        slideSegThumb(document.querySelector('.toolbar .seg'), from);
        // 恢复滚动位置：重绘会重建 DOM，scrollTop 归零，用户失去阅读位置
        var newList = document.querySelector('.res-list');
        if (newList) newList.scrollTop = scrollPos;
      });
    });
    if ($('zoomIn')) $('zoomIn').addEventListener('click', function () { zoomStep(1); });
    if ($('zoomOut')) $('zoomOut').addEventListener('click', function () { zoomStep(-1); });
    if ($('recenter')) $('recenter').addEventListener('click', recenterMap);
    var more = $('more');
    if (more) more.addEventListener('click', function () { S.showAll = !S.showAll; renderResult(); });

    // 首屏定位引导条上的两颗按钮：跟顶栏那颗定位钮走同一套逻辑（tryGeo / openAddr）
    var geoGo = $('geoGo');
    if (geoGo) geoGo.addEventListener('click', function () { tryGeo(); });
    var addrGo = $('addrGo');
    if (addrGo) addrGo.addEventListener('click', function () { openAddr(); });

    var tgl = $('onlyOpen');
    if (tgl) tgl.addEventListener('click', function () {
      var on = tgl.getAttribute('aria-pressed') !== 'true';
      tgl.setAttribute('aria-pressed', on ? 'true' : 'false');
      var list = document.querySelector('.res-list');
      var scrollPos = list ? list.scrollTop : 0;
      S.onlyOpen = on;
      // 不重置 showAll：同筛选切换的理由，用户点过「显示全部」就不该被悄悄退回前 30
      renderResult();
      var newList = document.querySelector('.res-list');
      if (newList) newList.scrollTop = scrollPos;
    });

    // 地图折叠：只重绘本区，不丢 book/shown 的上下文。过渡时序见 toggleMap
    var mt = $('mapToggle');
    if (mt) mt.addEventListener('click', toggleMap);
    var msb = $('mapSheetBtn');
    if (msb) msb.addEventListener('click', openMapSheet);

    // 重新查询：丢掉这本书的内存缓存，并让服务端绕过 12 小时磁盘缓存，回上图重抓实时状态
    ['requery', 'staleRequery'].forEach(function (id) {
      var rq = $(id);
      if (rq) rq.addEventListener('click', requeryActive);
    });

    // 点卡片 → 地图飞过去。导航链接、索书号和「索书号 · 库室」展开钮各有自己的动作，别抢
    Array.prototype.forEach.call(document.querySelectorAll('.card[data-idx]'), function (c) {
      c.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('a, .callno, .foot-tgl')) return;
        focusPlace(parseInt(c.getAttribute('data-idx'), 10));
      });
    });

    // 展开第三行：只翻一个类，不重绘结果区（重绘会丢掉滚动位置和地图视角）
    Array.prototype.forEach.call(document.querySelectorAll('[data-foot-toggle]'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var key = b.getAttribute('data-foot-toggle');
        var open = !S.footOpen[key];
        S.footOpen[key] = open;
        var foot = b.parentElement;
        if (foot) foot.classList.toggle('open', open);
        b.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.callno'), function (el) {
      el.addEventListener('click', function () {
        var t = el.getAttribute('data-copy');
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject())
          .then(function () { toast('已复制索书号 ' + t, 'ok'); })
          .catch(function () { toast('复制失败，请手动选：' + t, 'err'); });
      });
    });
  }

  // ---------------------------------------------------------------- 设置

  // Web 服务用自绘 listbox，视觉跟 32px 输入框对齐；值仍写回隐藏的 #setProvider，
  // 保存/测试那两处继续读 .value，也照常派发 change 给原来的 Key 占位提示
  var PROVIDER_LABEL = { amap: '高德', qq: '腾讯' };

  function providerOptions() {
    return Array.prototype.slice.call(document.querySelectorAll('#providerMenu .select-opt'));
  }

  function syncProviderUI(v) {
    v = v === 'qq' ? 'qq' : 'amap';
    $('setProvider').value = v;
    $('providerVal').textContent = PROVIDER_LABEL[v];
    providerOptions().forEach(function (o) {
      var on = o.getAttribute('data-v') === v;
      o.classList.toggle('on', on);
      o.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function closeProviderMenu(focusBtn) {
    var menu = $('providerMenu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    $('providerSelect').classList.remove('open');
    $('providerBtn').setAttribute('aria-expanded', 'false');
    if (focusBtn) $('providerBtn').focus();
  }

  function openProviderMenu(dir) {
    var menu = $('providerMenu');
    if (!menu) return;
    if (menu.hidden) {
      menu.hidden = false;
      $('providerSelect').classList.add('open');
      $('providerBtn').setAttribute('aria-expanded', 'true');
    }
    var opts = providerOptions();
    if (!opts.length) return;
    var cur = opts.filter(function (o) { return o.getAttribute('aria-selected') === 'true'; })[0];
    (dir === 'up' ? opts[opts.length - 1] : (cur || opts[0])).focus();
  }

  function chooseProvider(v) {
    var old = $('setProvider').value;
    syncProviderUI(v);
    if (old !== v) $('setProvider').dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setupProviderSelect() {
    var root = $('providerSelect');
    if (!root) return;
    var btn = $('providerBtn');
    var menu = $('providerMenu');

    btn.addEventListener('click', function () {
      if (menu.hidden) openProviderMenu('down');
      else closeProviderMenu(false);
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openProviderMenu(e.key === 'ArrowDown' ? 'down' : 'up');
      }
    });

    providerOptions().forEach(function (o) {
      o.addEventListener('click', function () {
        chooseProvider(o.getAttribute('data-v'));
        closeProviderMenu(true);
      });
    });

    menu.addEventListener('keydown', function (e) {
      var opts = providerOptions();
      var i = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var d = e.key === 'ArrowDown' ? 1 : -1;
        opts[(i + d + opts.length) % opts.length].focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        opts[e.key === 'Home' ? 0 : opts.length - 1].focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (i >= 0) opts[i].click();
      } else if (e.key === 'Escape') {
        // 设置面板的 Esc 监听挂在 document 上，这里不拦住会把设置一起关掉
        e.preventDefault();
        e.stopPropagation();
        closeProviderMenu(true);
      } else if (e.key === 'Tab') {
        // 先把焦点还给按钮，Tab 的默认动作再从按钮接着走；
        // 否则焦点会留在刚被 hidden 的选项上，下一跳从文档开头算
        closeProviderMenu(true);
      }
    });

    document.addEventListener('pointerdown', function (e) {
      if (!menu.hidden && !e.target.closest('#providerSelect')) closeProviderMenu(false);
    });
  }

  var settingsReturnFocus = null;

  // 项目主页和发布页都以服务端给的地址为准；只接受 github.com 的 https 地址，
  // 不把接口里的任意字符串直接塞进 href
  function projectUrl() {
    return (S.cfg && S.cfg.homepage) || 'https://github.com/Giant-Apple/shlib-finder';
  }

  function releaseUrl(u) {
    return /^https:\/\/([a-z0-9-]+\.)*github\.com\//i.test(u || '')
      ? u : projectUrl() + '/releases';
  }

  // 检查结果写在按钮上：已是最新 / 新版本 x.y.z / 检查失败。
  // 用户选的是「结果并进按钮」——版本行只放版本号，不再单起一行写结论。
  // 有新版本时按钮必须说出「有新版」这件事实（只写「打开发布页」是个动作，
  // 用户看不出查到了什么），点击才是打开 GitHub 发布页。
  function paintUpdate(res) {
    var btn = $('checkUpdate');
    if (!btn) return;
    S.update = res || null;
    // 局域网只读：服务端不收写请求，这里也别把按钮点亮
    btn.disabled = !!(S.cfg && S.cfg.readOnly);
    btn.classList.remove('has-update');
    if (!res || res.never) {
      btn.textContent = '检查更新';
      btn.title = '检查 GitHub 上有没有新版本';
      return;
    }
    var when = res.checkedAt ? '上次检查：' + res.checkedAt + '；' : '';
    if (res.failed) {
      btn.textContent = '检查失败';
      btn.title = res.err ? '检查更新失败：' + res.err + '；点击重试' : when + '没连上 GitHub，点击重试';
    } else if (res.newer) {
      // 版本号走 textContent（来自接口的字符串不拼进 HTML），箭头是固定的图标串
      btn.classList.add('has-update');
      btn.textContent = '新版本 ' + (res.latest || '');
      btn.insertAdjacentHTML('beforeend', icon('external-link', 'ic-ext'));
      btn.title = when + '当前 ' + res.current + '，新版本 ' + res.latest + '；点击打开发布页';
    } else {
      btn.textContent = '已是最新';
      btn.title = when + '已是最新版本 ' + res.current + '，点击重新检查';
    }
  }

  // 打开设置时只读服务端缓存，不联网：检查更新只在用户点按钮时发生
  function loadUpdatePeek() {
    apiGet('/api/update-check').then(paintUpdate).catch(function () {
      paintUpdate(null);
    });
  }

  function checkUpdate() {
    var btn = $('checkUpdate');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '检查中…';
    btn.title = '';
    apiPost('/api/update-check', {}).then(paintUpdate).catch(function (e) {
      paintUpdate({
        failed: true,
        err: e.message || '请求没发出去',
        current: (S.cfg && S.cfg.version) || ''
      });
      toast('检查更新失败：' + (e.message || ''), 'err');
    }).then(function () {
      applyReadOnly(S.cfg);
    });
  }

  // 按钮只有一个：有新版本时带用户去发布页，其余时候都是「再查一次」
  function onUpdateClick() {
    if (S.update && S.update.newer && !S.update.failed) {
      window.open(releaseUrl(S.update.url), '_blank', 'noopener');
      return;
    }
    checkUpdate();
  }

  // 从其他设备（局域网 IP）打开时服务端只给只读配置（readOnly=true）：
  // 把会写盘的控件全部禁用，别让人填完再吃一个 403。地图默认展开只是本机偏好，照常可点。
  function applyReadOnly(cfg) {
    var ro = !!(cfg && cfg.readOnly);
    var note = $('setRo');
    if (note) note.hidden = !ro;
    ['setDoulist', 'setWish', 'setKey', 'setMapKey', 'setMapSec'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = ro;
    });
    var prov = $('setProvider');
    if (prov) prov.disabled = ro;
    var pb = $('providerBtn');
    if (pb) pb.disabled = ro;
    var save = $('setSave');
    if (save) save.disabled = ro;
    var test = $('keyTest');
    if (test) test.disabled = ro;
    var lan = $('lanToggle');
    if (lan) lan.disabled = ro;
    // 检查更新是写操作（POST，服务端只收本机请求），只读时不给点
    var cu = $('checkUpdate');
    if (cu) cu.disabled = ro;
    if (ro) closeProviderMenu(false);
  }

  // 校验没过的输入框：红边 + 框下面一行原因。服务端在 400 里给 field（就是配置键名），
  // 这里换成对应的输入框；换不出来（比如 lan 开关）返回 false，让调用方退回 toast
  var FIELD_INPUT_ID = {
    doulist_url: 'setDoulist',
    wish_url: 'setWish',
    geocode: 'setKey',
    map: 'setMapKey'
  };
  var fieldErr = null;   // { input: 输入框, msg: 那行原因的节点 }

  function clearFieldErr() {
    if (!fieldErr) return;
    fieldErr.input.classList.remove('bad');
    if (fieldErr.msg.parentNode) fieldErr.msg.parentNode.removeChild(fieldErr.msg);
    fieldErr = null;
  }

  function showFieldErr(field, text) {
    var id = FIELD_INPUT_ID[field];
    var inp = id ? $(id) : null;
    if (!inp) return false;
    clearFieldErr();
    inp.classList.add('bad');
    var msg = document.createElement('p');
    msg.className = 'f-err';
    msg.textContent = text;
    // setKey 的父节点是并在同一行的那条 .row，提示要落在整格下面，不能挤进那一行
    (inp.closest('.field') || inp.parentNode).appendChild(msg);
    fieldErr = { input: inp, msg: msg };
    inp.focus({ preventScroll: true });
    // 面板可能已经滚过去了：把这一格带回视野
    inp.scrollIntoView({ block: 'nearest' });
    return true;
  }

  // focus 传 'doulist' / 'wish' 时，打开面板后把光标落到对应地址输入框并选中整条地址
  // （「改地址」就在对应分组的组标题右边，用户点它是奔着换地址来的）
  function openSettings(focus) {
    var cfg = S.cfg || {};
    settingsReturnFocus = document.activeElement;
    clearFieldErr();
    applyReadOnly(cfg);
    $('setDoulist').value = cfg.doulist_url || '';
    $('setWish').value = cfg.wish_url || '';
    syncProviderUI((cfg.geocode && cfg.geocode.provider) || 'amap');
    closeProviderMenu(false);
    $('setKey').value = '';
    $('setKey').placeholder = (cfg.geocode && cfg.geocode.hasKey)
      ? '已保存（' + cfg.geocode.keyTail + '），留空不改' : '在这里粘贴 Key';
    $('setMapKey').value = '';
    $('setMapSec').value = '';
    var mc = cfg.map || {};
    $('setMapKey').placeholder = mc.hasKey
      ? '已保存（' + mc.keyTail + '），留空不改' : '在这里粘贴 Key';
    // 版本号：放在「关于」分组里
    var vEl = $('setVer');
    if (vEl) {
      vEl.textContent = '上图馆藏查询 v' + (S.cfgVersion || '—');
      if (S.cfgBuild) {
        var sm = document.createElement('small');
        sm.textContent = '构建 ' + S.cfgBuild;
        vEl.appendChild(sm);
      }
    }
    // 「重启服务」只在回环地址上出现：服务端也只接受 127.0.0.1 / ::1 的请求
    var rb = $('restartSrv');
    if (rb) {
      rb.hidden = !!cfg.readOnly ||
        ['127.0.0.1', 'localhost', '[::1]', '::1'].indexOf(location.hostname) < 0;
    }
    // GitHub 项目主页：地址由服务端给，老服务端没有这个键就用常量兜底
    var home = $('homeLink');
    if (home) home.href = projectUrl();
    // 更新状态先显示上次检查的结果（缓存），不发请求
    loadUpdatePeek();
    // 同步外观开关的高亮（不写 localStorage）
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light', false);
    // 地图默认展不展开：没存过就按启动时的判定显示（宽屏开、窄屏关），
    // 别把窄屏下的临时收起当成用户已经做过选择
    var mv0 = lsGet('shlib.map');
    syncMapSeg(mv0 === null ? window.innerWidth > NARROW_W : mv0 !== '0', false);
    // 内容区上次停在哪就还停在哪，重开面板会接着读半截；回到最上面
    var sm = $('settings').querySelector('.set-main');
    if (sm) sm.scrollTop = 0;
    $('settings').classList.add('show');
    $('settings').setAttribute('aria-hidden', 'false');
    loadLanInfo();
    if ((focus === 'doulist' || focus === 'wish') && !cfg.readOnly) {
      var inp = focus === 'wish' ? $('setWish') : $('setDoulist');
      try { inp.focus(); inp.select(); } catch (e) {}
    } else {
      // 初始焦点落在关闭按钮：读屏用户一进来先知道「这是个能退出的对话框」
      try { $('setClose').focus(); } catch (e) {}
    }
  }

  // 设置面板的「从其他设备访问」：开关只改本地状态，保存时才写进 config.json。
  // 服务收到保存请求就当场换监听地址（server.py 的 apply_lan_binding），不用重启——
  // 重启会把手机上正开着的页面断掉。开启后其他设备是只读的，这里同时把二维码和地址给出来。
  function loadLanInfo() {
    var field = $('lanField');
    if (!field) return;
    return apiGet('/api/lan-qr').then(function (j) {
      S.lanInfo = j || { enabled: false, on: false };
      paintLan(S.lanInfo);
      return S.lanInfo;
    }).catch(function () {
      S.lanInfo = { enabled: false, on: false };
      paintLan(S.lanInfo);
      return S.lanInfo;
    });
  }

  // 已经真的在监听时的那句状态；拨开关和读配置两条路都要写它，所以只留一份
  var LAN_LIVE_TEXT = '已开启：其他设备可以打开下面的地址';

  function paintLan(j) {
    var on = !!j.enabled;
    var live = !!j.on;
    var tgl = $('lanToggle');
    if (tgl) {
      tgl.setAttribute('aria-pressed', on ? 'true' : 'false');
      tgl.disabled = !!(S.cfg && S.cfg.readOnly);
    }
    var stat = $('lanStat');
    if (stat) {
      // 开着却没在监听只有两种原因，说清楚是哪种——否则「已开启」配一条空地址，
      // 看着像开关坏了
      if (live) stat.textContent = LAN_LIVE_TEXT;
      else if (j.local) stat.textContent = '服务是用 --local 启动的，这个开关不会生效';
      else if (on) stat.textContent = '已开启，但没能监听局域网：端口可能被别的程序占着';
      else stat.textContent = '未开启，只有这台电脑能访问';
    }
    var share = $('lanShare');
    if (share) share.hidden = !live;
    var urlEl = $('lanUrl');
    var qr = $('lanQr');
    var ro = $('lanRo');
    if (!live) {
      if (qr) { qr.hidden = true; qr.innerHTML = ''; }
      if (ro) ro.hidden = true;
      if (urlEl) { urlEl.textContent = '—'; urlEl.onclick = null; }
      return;
    }
    if (ro) ro.hidden = false;
    if (urlEl) {
      urlEl.textContent = j.url || '—';
      // 注意要包一层函数：直接写 onclick = copyText(...) 会立刻执行一次
      urlEl.onclick = j.url ? function () { copyText(j.url, '地址已复制'); } : null;
    }
    if (qr) {
      if (j.qr) { qr.innerHTML = j.qr; qr.hidden = false; }
      else { qr.hidden = true; }
    }
  }

  // 复制文本：navigator.clipboard 只在安全上下文（https / localhost）可用，
  // 局域网 http 下就退回 execCommand 那条老路
  function copyText(text, okMsg) {
    function done() { toast(okMsg, 'ok'); }
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('复制失败，手动选中复制', 'err');
      } catch (e) { toast('复制失败，手动选中复制', 'err'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
  }

  // 逐项打一次真实请求，比看「已保存」有用——上一轮就吃过「Key 存了但服务是旧进程」的亏
  function testKey() {
    if (S.cfg && S.cfg.readOnly) {
      toast('从其他设备打开时这里是只读的：测试 Key 请回到运行服务的那台电脑', 'err');
      return;
    }
    var typed = $('setKey').value.trim();
    var btn = $('keyTest');
    // 状态行去掉了，进行中就写在这颗按钮上，不然点了像没反应
    btn.disabled = true;
    btn.textContent = '测试中…';

    // 输入框里有新 Key 就先存下来再测，省得「测的是旧的」
    var save = typed
      ? apiPost('/api/config', { geocode: { provider: $('setProvider').value, key: typed } })
      : Promise.resolve();

    var o = '121.4737,31.2304', d = '121.4455,31.2098';  // 人民广场 → 上图淮海路馆

    save.then(function () { return apiGet('/api/config'); }).then(function (cfg) {
      S.cfg = cfg;
      if (typed) {
        $('setKey').value = '';
        $('setKey').placeholder = '已保存（' + (cfg.geocode.keyTail || '') + '），留空不改';
      }
      var ok = [], bad = [];
      var probe = function (name, path) {
        return apiGet(path).then(function () { ok.push(name); },
          function (e) { bad.push(name); });
      };
      return probe('地址转坐标', '/api/geocode?q=' + encodeURIComponent('上海图书馆'))
        .then(function () { return probe('骑行', '/api/cycling?from=' + o + '&to=' + d); })
        .then(function () {
          // 只报结论，不摊「可用：无；不可用：地址转坐标、骑行」这种清单：
          // 两项都不通时清单里没有一项值得读，直接说都不通
          if (!bad.length) toast('Key 可用', 'ok');
          else if (!ok.length) toast('Key 都不通', 'err');
          else toast(ok.join('、') + '可用，' + bad.join('、') + '不通', 'err');
        });
    }).catch(function (e) {
      toast('测试失败：' + e.message, 'err');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '测试';
    });
  }

  // 重启服务：服务端起新进程后退出，旧页面靠 bootId 判断新的已经起来了，再刷新。
  // 轮询期间服务会短暂不可用，请求失败是预期内的，继续等就好
  function restartServer() {
    var btn = $('restartSrv');
    if (!btn || btn.disabled) return;
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '重启中…';
    apiPost('/api/restart', {}).then(function (j) {
      var oldBoot = (j && j.bootId) || (S.cfg && S.cfg.bootId) || '';
      toast('服务正在重启…', 'ok');
      var tries = 0;
      function poll() {
        tries++;
        apiGet('/api/config?t=' + Date.now()).then(function (cfg) {
          if (cfg && cfg.bootId && cfg.bootId !== oldBoot) {
            location.reload();
            return;
          }
          throw new Error('still-old');
        }).catch(function () {
          if (tries >= 30) {
            btn.disabled = false;
            btn.textContent = label;
            toast('重启超时，请用 restart-server.bat 手动重启', 'err');
            return;
          }
          setTimeout(poll, 350);
        });
      }
      setTimeout(poll, 700);
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = label;
      toast('重启失败：' + e.message, 'err');
    });
  }

  function closeSettings() {
    closeProviderMenu(false);
    $('settings').classList.remove('show');
    $('settings').setAttribute('aria-hidden', 'true');
    restoreFocus(settingsReturnFocus);
    settingsReturnFocus = null;
  }

  function saveSettings() {
    if (S.cfg && S.cfg.readOnly) {
      toast('从其他设备打开时这里是只读的：改设置请回到运行服务的那台电脑', 'err');
      return;
    }
    var body = {
      doulist_url: $('setDoulist').value.trim(),
      // 想读地址带着豆瓣账号 ID，同样只存本机；两个地址可以只填一个
      wish_url: $('setWish').value.trim()
    };
    // 笔记路径不在这里提交：它只在 config.json 里，面板上干脆不露面
    // Key 留空 = 不改 Key，但 provider 仍然要提交——否则只换高德/腾讯会静默不生效
    var key = $('setKey').value.trim();
    body.geocode = { provider: $('setProvider').value };
    if (key) body.geocode.key = key;

    // JS API 那两把同理：留空不动，填了才覆盖
    var mkey = $('setMapKey').value.trim();
    var msec = $('setMapSec').value.trim();
    if (mkey || msec) {
      body.map = {};
      if (mkey) body.map.key = mkey;
      if (msec) body.map.security = msec;
    }

    // 从其他设备访问的开关：保存时服务端会当场换监听地址，不用重启
    var wantLan = $('lanToggle').getAttribute('aria-pressed') === 'true';
    var hadLan = !!(S.cfg && S.cfg.lan && S.cfg.lan.enabled);
    body.lan = wantLan;

    apiPost('/api/config', body).then(function () {
      return Promise.all([apiGet('/api/config'), loadLanInfo()]);
    }).then(function (arr) {
      var cfg = arr[0], lan = arr[1] || {};
      S.cfg = cfg;
      closeSettings();
      // 拨过开关才提这一句：别的设备能不能连，是这次保存唯一看不见的后果
      if (wantLan !== hadLan) {
        if (wantLan && !lan.on) {
          toast('设置已保存，但没能对其他设备开放：' +
            (lan.local ? '服务是用 --local 启动的' : '端口可能被别的程序占着'), 'err');
        } else {
          toast(wantLan ? '设置已保存，其他设备现在可以打开了'
            : '设置已保存，其他设备已经打不开了', 'ok');
        }
      } else {
        toast('设置已保存', 'ok');
      }
      if (key) loadVenues();
      if (mkey || msec) { resetAmap(); if (S.activeId) renderResult(); }
      loadLists(false);
    }).catch(function (e) {
      // 校验失败：话说到那一格去（红边 + 框下原因），别再单独发一条 toast 说同一件事
      if (e.field && showFieldErr(e.field, e.message)) return;
      toast('保存失败：' + e.message, 'err');
    });
  }

  // ---------------------------------------------------------------- 启动

  function loadVenues() {
    return apiGet('/api/venues').then(function (j) {
      var n = SHLIB.setVenues(j.venues || []);
      return n;
    });
  }

  function init() {
    // 先把 HTML 里的图标占位填上，再做别的（后面取按钮尺寸、切主题都依赖图标已在位）
    hydrateIcons();
    // 便携模式：打包产物里会被置成 "1"。此时整站不往本机留任何痕迹——
    // 不读也不写 localStorage（位置、主题、面板开合全不记），
    // 免得一个「拷来拷去」的包在别人机器上留下你的坐标。
    // 开关必须先读，所以这一条不能放在下面的 try 里等默认值。
    try { S.nostore = localStorage.getItem('shlib.nostore') === '1'; } catch (e) {}
    try {
      if (S.nostore) { purgeLocal(); } else {
        var saved = lsGet('shlib.spot');
        if (saved) S.spot = JSON.parse(saved);
        var mv = lsGet('shlib.map');
        if (mv === '0') S.mapOn = false;
        // 手机上默认收起地图：窄屏一列，地图一展开就吃掉半屏。用户自己开过一次就记住他的选择
        if (mv === null && window.innerWidth <= NARROW_W) S.mapOn = false;
        // 书单收起的记忆要先恢复（不写回 localStorage）
        if (lsGet('shlib.aside') === '0') setAside(true, false);
        // 三个书架的收起状态：只认这三个来源，坏数据就当全部展开
        try {
          var folded = JSON.parse(lsGet('shlib.groups') || '{}');
          ['manual', 'doulist', 'wish'].forEach(function (k) {
            if (folded && folded[k]) S.folded[k] = true;
          });
        } catch (e) {}
      }
    } catch (e) {}
    // 手动加的书先读回来：豆瓣书单还要等接口，但书架不该跟着空一截
    S.manual = loadManual();
    // 主题是 head 内联脚本按 localStorage 设好的，但头部那颗开关的图标/tooltip
    // 要等 applyTheme 才会摆对——启动时必须补一次，否则暗色进来按钮上还挂着太阳。
    // persist=false：只是恢复现场，不要把刚读出来的值又写回去
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light', false);
    renderLoc();

    Promise.all([apiGet('/api/config'), loadVenues()]).then(function (arr) {
      S.cfg = arr[0];
      S.cfgVersion = arr[0].version || '';
      S.cfgBuild = arr[0].build || '';
      // 老版本服务端没有 features 键：骑行接口还没注册，提示一句，别让人以为功能坏了
      if (!S.cfg.features) {
        toast('本地服务是旧进程：骑行功能需要重启服务（可在设置里点「重启服务」）', 'err');
      }
      // 位置和距离都要靠地址换算，没配 Web 服务 Key 就先提示一次
      if (!S.cfg.geocode.hasKey) {
        toast('还没配 Web 服务 Key：距离和骑行用不了，在右上角设置里填', 'err');
      }
      loadLists(false);
      if (!S.spot) tryGeo();
    }).catch(function (e) {
      toast('本地服务没响应：' + e.message, 'err');
      // 启动失败时「正在准备」界面会永久显示，给一个重试入口
      $('result').innerHTML = '<div class="empty">' +
        '<h2>本地服务没响应</h2>' +
        '<p>' + esc(e.message) + '</p>' +
        '<p><button class="primary" id="retryInit">重试</button></p>' +
        '</div>';
      $('retryInit').addEventListener('click', function() {
        $('result').innerHTML = '<div class="empty"><h2>正在准备</h2>' +
          '<p>读取书架、网点数据和你的位置…</p></div>';
        init();
      });
    });

    $('geoBtn').addEventListener('click', tryGeo);
    // 结果区会局部重绘（版本行 / 选择器 / 加载 / 错误），事件委托挂在一直存在的 #result 上
    $('result').addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-db-act]') : null;
      var book = findBook(S.activeId);
      if (el && $('result').contains(el) && book) {
        var act = el.getAttribute('data-db-act');
        if (act === 'isbn') { openEdition(el); return; }
        if (act === 'ver-toggle') {
          S.versOpen[book.id] = !S.versOpen[book.id];
          paintVersions(book);
          return;
        }
        if (act === 'ver-retry') {
          delete S.editions[editionKey(book.title, false)];
          ensureEditions(book);
          return;
        }
      }
      var pv = e.target.closest ? e.target.closest('[data-act="pick-ver"]') : null;
      if (pv && $('result').contains(pv)) pickVersion(pv);
    });
    // 书单收起 / 展开：head 里那个箭头收起，收起后剩下的竖 rail 点一下回来
    $('asideToggle').addEventListener('click', function () { setAside(true); });
    $('asideRail').addEventListener('click', function () { setAside(false); });
    // 位置名称本身就是「更改位置」的入口（原来那个铅笔按钮已去掉）
    $('loc').addEventListener('click', openAddr);
    $('loc').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAddr(); }
    });
    // 地址对话框：取消 / 确定 / 回车 / Esc / 点遮罩
    $('addrCancel').addEventListener('click', closeAddr);
    $('addrOk').addEventListener('click', submitAddr);
    $('addrDlg').addEventListener('click', function (e) {
      if (e.target === this) closeAddr();
    });
    // 点最近地址：坐标是存过的，直接设位置，不再走一次地理编码
    $('addrRecent').addEventListener('click', function (e) {
      var b = e.target.closest('[data-addr]');
      if (!b) return;
      var a = getAddrs()[parseInt(b.getAttribute('data-addr'), 10)];
      if (!a) return;
      closeAddr();
      rememberAddr(a.label, a.lat, a.lng);
      setSpot({ lat: a.lat, lng: a.lng, label: a.label, src: 'addr' }, { recenter: true });
      toast('位置已设为：' + a.label, 'ok');
    });
    $('addrInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitAddr(); }
    });
    $('addrDlg').addEventListener('keydown', function (e) { trapTab(this, e); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('addrDlg').classList.contains('show')) closeAddr();
    });
    $('mapSheetClose').addEventListener('click', closeMapSheet);
    $('msRecenter').addEventListener('click', recenterMap);
    $('mapSheet').addEventListener('keydown', function (e) { trapTab(this, e); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('mapSheet').classList.contains('show')) closeMapSheet();
    });
    $('settingsBtn').addEventListener('click', openSettings);
    // 头部的外观开关：夹在定位钮和设置钮中间
    $('themeBtn').addEventListener('click', toggleTheme);
    // 手动加书：按钮开对话框；回车、Esc、点遮罩都跟地址框一个套路
    $('shelfAdd').addEventListener('click', openAdd);
    $('addCancel').addEventListener('click', closeAdd);
    $('addOk').addEventListener('click', submitAdd);
    $('addDlg').addEventListener('click', function (e) {
      if (e.target === this) closeAdd();
    });
    $('addInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitAdd(); }
    });
    $('addDlg').addEventListener('keydown', function (e) { trapTab(this, e); });
    // 书名匹配到多个版本时，候选行点一下 = 按那一版的 ISBN 加书并查询
    $('addCands').addEventListener('click', function (e) {
      var b = e.target.closest('[data-add-isbn]');
      if (!b) return;
      closeAdd();
      pushHist(b.getAttribute('data-add-title') || b.getAttribute('data-add-isbn'));
      addEditionBook({
        isbn: b.getAttribute('data-add-isbn'),
        title: b.getAttribute('data-add-title'),
        author: b.getAttribute('data-add-author'),
        publisher: b.getAttribute('data-add-pub'),
        year: b.getAttribute('data-add-year')
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('addDlg').classList.contains('show')) closeAdd();
    });
    // 窗口尺寸变了：药丸可能缩了一档、头部可能折行，让位和地图列都要重算，
    // 高德也要重算瓦片，否则右侧会留白或压扁
    // 跨过「地图背景断点」（861px）时，结果区要不要铺地图这个判断会变，
    // 但结果区是整块 innerHTML 写出来的，只有重绘 renderResult 才会把地图层加进来或拆掉。
    // 不重绘的话：从宽缩到窄，地图层还赖在 DOM 里衬花正文；从窄拉到宽，地图层根本没被插进来。
    // 用「想要的状态」和「DOM 里实际有没有」对比：不一致（且确实有结果在显示）就重绘一次，
    // 让 hasMap 重新判定；一致就不重绘，纯尺寸变化只让高德重算瓦片。
    // 注：首屏加载不会派发 resize，所以不能用「记录上一次宽度」来判跨点——直接用 DOM 现状比对更稳
    window.addEventListener('resize', function () {
      measureHeader();
      var wide = window.innerWidth >= MAP_BG_MIN;
      if (S.activeId && S.results[S.activeId]) {
        var wantMap = canMap() && S.mapOn && wide;
        var hasMapDom = !!document.getElementById('mapWrap');
        if (wantMap !== hasMapDom) renderResult();
      }
      if (MAP && MAP.resize) { try { MAP.resize(); } catch (e) {} }
      if (MAP_SHEET && MAP_SHEET.resize) { try { MAP_SHEET.resize(); } catch (e) {} }
      // 分段控件的宽度按文字撑出来，字体加载/缩放变化后要重新对位
      var ts = document.querySelector('.toolbar .seg');
      if (ts) placeSegThumb(ts);
      var ms = $('mapSeg');
      if (ms) placeSegThumb(ms);
    });
    measureHeader();
    if (window.ResizeObserver && $('bar')) {
      try { new ResizeObserver(measureHeader).observe($('bar')); } catch (e) {}
    }
    // 吸顶那条实底跟着滚动走：一帧最多算一次。
    // 书单高度变了（收/放整列、换窗口尺寸）也要重算，不然重开后 .pin 还停在旧位置
    if ($('bookList')) {
      var pinRaf = 0;
      $('bookList').addEventListener('scroll', function () {
        if (pinRaf) return;
        pinRaf = requestAnimationFrame(function () { pinRaf = 0; syncShelfPins(); });
      }, { passive: true });
      if (window.ResizeObserver) {
        try { new ResizeObserver(syncShelfPins).observe($('bookList')); } catch (e) {}
      }
    }
    // 书架整体是重画的，事件挂在 #bookList 上做委托：
    // 行内 × = 移出手动书；组标题上的动作 = 加书 / 改地址 / 重读；其余点行 = 切书
    $('bookList').addEventListener('click', function (e) {
      var x = e.target.closest('[data-shelf-remove]');
      if (x) {
        e.stopPropagation();
        removeManual(x.getAttribute('data-shelf-remove'));
        return;
      }
      var act = e.target.closest('[data-shelf-act]');
      if (act) {
        var a = act.getAttribute('data-shelf-act');
        // 收起按钮的 data-field 是 manual/doulist/wish，别走下面那套「非 wish 即豆列」。
        // e.detail === 0 是键盘/读屏触发的 click，重画后要把焦点还回原处
        if (a === 'fold') {
          toggleFold(act.getAttribute('data-field'), e.detail === 0);
          return;
        }
        var field = act.getAttribute('data-field') === 'wish' ? 'wish' : 'doulist';
        if (a === 'add') openAdd();
        else if (a === 'edit') openSettings(field);
        else if (a === 'refresh') loadList(field, true);
        else if (a === 'more') loadList(field, false, true);
        return;
      }
      var el = e.target.closest('.book');
      if (el) selectBook(el.getAttribute('data-id'));
    });
    bindSearch();
    bindSettingsModal();
  }

  // ---------------------------------------------------------------- 药丸检索

  function bindSearch() {
    var q = $('q');

    // 输入中给「书单里匹配到的书」，空输入给最近搜索
    q.addEventListener('input', function () { setClearBtn(); openSug(); });
    // 点进空框也给下拉：要么是最近搜索，要么什么都没有（那就别弹空白）
    q.addEventListener('focus', function () { openSug(); });
    // Esc：下拉开着就先收下拉，再按一次才清空内容
    q.addEventListener('keydown', function (e) {
      var opts = sugOptions();
      var open = !$('sug').classList.contains('hidden');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!open) { openSug(); opts = sugOptions(); }
        if (!opts.length) return;
        e.preventDefault();
        var d = e.key === 'ArrowDown' ? 1 : -1;
        var i = sugAuto < 0 ? (d > 0 ? 0 : opts.length - 1) : (sugAuto + d + opts.length) % opts.length;
        sugHi(i);
        return;
      }
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        // 高亮着哪条就查哪条，没高亮就把框里的原样拿去查
        var cur = sugAuto >= 0 ? opts[sugAuto] : null;
        if (cur) { cur.click(); return; }
        doSearch(q.value);
        return;
      }
      if (e.key === 'Escape') {
        if (open) { e.preventDefault(); closeSug(); return; }
        if (q.value) { e.preventDefault(); q.value = ''; setClearBtn(); closeSug(); }
      }
    });
    q.addEventListener('blur', function () {
      // 下拉里的按钮要能点到：等 pointerdown 派发完再收。点了外面才真的收
      setTimeout(function () {
        if (!document.activeElement || !$('sug').contains(document.activeElement)) closeSug();
      }, 120);
    });

    $('qBtn').addEventListener('click', function () { doSearch(q.value); });
    $('qClear').addEventListener('click', function () {
      q.value = '';
      setClearBtn();
      q.focus();
      openSug();
    });
    // 点/触摸下拉外面任何地方都收起来
    document.addEventListener('pointerdown', function (e) {
      if (!$('sug').classList.contains('hidden') &&
          !e.target.closest('.qpill') && e.target !== q) closeSug();
    });
  }

  // ---------------------------------------------------------------- 设置面板

  function bindSettingsModal() {
    $('setSave').addEventListener('click', saveSettings);
    // 一动就清掉旧的校验错误：人已经在改了，红边还挂着会像没生效
    ['setDoulist', 'setWish', 'setKey', 'setMapKey', 'setMapSec'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('input', clearFieldErr);
    });
    $('setCancel').addEventListener('click', closeSettings);
    $('setClose').addEventListener('click', closeSettings);
    setupProviderSelect();
    // Esc 关设置：弹窗是模态，按 Esc 退出是约定俗成的操作，不必非去点 X 或底部按钮。
    // 只看 .show：没有这个类时面板本来就没开，别把 Esc 浪费在隐藏节点上。
    // 下拉开着时先收下拉；焦点在菜单里时菜单自己的 handler 已经拦住，这一条兜住外面的情况
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !$('settings').classList.contains('show')) return;
      if (!$('providerMenu').hidden) { closeProviderMenu(true); return; }
      closeSettings();
    });
    // 焦点圈在面板里：读屏/键盘用户 Tab 不到背后那层页面
    $('settings').addEventListener('keydown', function (e) { trapTab(this, e); });
    $('keyTest').addEventListener('click', testKey);
    $('restartSrv').addEventListener('click', restartServer);
    $('checkUpdate').addEventListener('click', onUpdateClick);
    // 「从其他设备访问」开关：只翻状态，保存时才写配置（见 saveSettings）。
    // 服务收到保存就会换监听地址，所以这里只说「保存后生效」，不再问要不要重启
    $('lanToggle').addEventListener('click', function () {
      var want = this.getAttribute('aria-pressed') !== 'true';
      this.setAttribute('aria-pressed', want ? 'true' : 'false');
      var saved = !!(S.lanInfo && S.lanInfo.enabled);
      var stat = $('lanStat');
      if (stat) {
        if (want === saved) {
          stat.textContent = S.lanInfo && S.lanInfo.on
            ? LAN_LIVE_TEXT : '未开启，只有这台电脑能访问';
        } else {
          stat.textContent = '保存后生效';
        }
      }
    });
    // 换服务商必须同时换 Key：两家的 Key 不通用，只切下拉会让地理编码直接失败
    $('setProvider').addEventListener('change', function () {
      var cur = ((S.cfg || {}).geocode || {}).provider || 'amap';
      if (this.value !== cur) {
        $('setKey').placeholder = '切到' + (this.value === 'amap' ? '高德' : '腾讯') +
          '了，这里要贴对应的 Key（两家不通用）';
      } else {
        $('setKey').placeholder = '已保存（' + ((S.cfg || {}).geocode || {}).keyTail +
          '），留空不改';
      }
    });

    // 地图默认展开：点一下立刻切并记住，不用等「保存」（跟主题开关一样）。
    // 走 toggleMap 复用淡出/淡入那套过渡，宽屏下当场看到地图开合；值与工具栏
    // 那颗地图钮、localStorage 的 shlib.map 是同一个
    Array.prototype.forEach.call(document.querySelectorAll('#mapSeg button'), function (b) {
      b.addEventListener('click', function () {
        if ((b.getAttribute('data-map-val') === '1') !== S.mapOn) toggleMap();
        else syncMapSeg(S.mapOn);
      });
    });

    $('settings').addEventListener('click', function (e) {
      if (e.target === $('settings')) closeSettings();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
