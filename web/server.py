"""
上图馆藏查询 · 本地网页版服务器

它同时干四件事：
  1. 把 web/ 当静态站点提供（浏览器打开 http://127.0.0.1:8765）
  2. 把 /vufind/* 转发到 https://vufind.library.sh.cn/*
     上图的状态接口没给 CORS 头，浏览器的跨域限制绕不过，由这一层补上
  3. 抓豆瓣公开书单，翻页取书名，再逐本进详情页取 ISBN（带磁盘缓存）
  4. 地址转坐标、骑行用时

用法：
  python web/server.py                默认只监听本机；「从其他设备访问」在设置里开启
  python web/server.py --local        强制只监听本机（忽略设置里的开关）
  python web/server.py --port 9000 --no-open

局域网是只读的：明文 Key、设置写入和重启只接受真正的回环来源；
手机可以查书、看结果，但改配置要回到运行服务的这台电脑上。

配置在项目根目录 config.json。
"""

import argparse
import concurrent.futures
import hashlib
import html as _html
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler

WEB_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(WEB_DIR)
VERSION_PATH = os.path.join(ROOT, 'version.json')


def read_version():
    """版本号只有一个源：根目录 version.json。读不到就给个兜底，
    不因为少一个文件把整站拖崩——它只是用来认「跑的是哪一版」的"""
    try:
        with open(VERSION_PATH, encoding='utf-8') as f:
            v = json.load(f)
        return (v.get('version') or '0.0.0').strip(), (v.get('build') or '').strip()
    except Exception:
        return '0.0.0', ''


VERSION, BUILD = read_version()
# 每次启动都不同：页面上的「重启服务」靠它区分「旧进程还在响应」和「新进程已经起来」
BOOT_ID = '%d-%d' % (os.getpid(), time.time_ns())

DATA_DIR = os.path.join(ROOT, 'data')
CONFIG_PATH = os.path.join(ROOT, 'config.json')
VENUES_PATH = os.path.join(DATA_DIR, 'libraries.json')
DOULIST_CACHE = os.path.join(DATA_DIR, 'doulist-cache.json')
GEOCODE_CACHE = os.path.join(DATA_DIR, 'geocode-cache.json')
# 馆藏页面（AjaxTab 原始 HTML）的磁盘缓存：结构一天之内不会变，变的是每册的在架状态。
# 命中缓存能省掉一次往返上图（1~3 秒），缓存 TTL 见 HOLDINGS_TTL。
HOLDINGS_DIR = os.path.join(DATA_DIR, 'holdings')
HOLDINGS_TTL = 12 * 3600
# 设置接口的请求体上限：正常配置不到 1KB，给 64KB 已经很宽松。
# 不设上限时 Content-Length 由对方声明，局域网里可以拿来把进程内存打满。
MAX_BODY = 64 * 1024
HOLDINGS_WRITES = 0   # 写了多少次，攒够一批清一次过期文件
SHL_RETRY_TTL = 7 * 24 * 3600   # 上图查不到 record 的书，多久之后再试一次

# 上图版本查询（/api/editions）的磁盘缓存：
#   records = 每条记录的书目字段（RIS 导出，约 200 字节），书目信息很少变，留 30 天
#   queries = 一次书名检索命中的记录 id 列表，留 1 天（新入藏的版本不用等太久）
EDITIONS_CACHE = os.path.join(DATA_DIR, 'editions-cache.json')
EDITIONS_REC_TTL = 30 * 24 * 3600
EDITIONS_QUERY_TTL = 24 * 3600
EDITIONS_MAX_RECORDS = 20   # 一次检索最多展开多少条记录去取 ISBN
EDITIONS_MAX_RETURN = 12    # 去重后最多返回多少个可查版本

# 豆瓣条目详情（其他版本 / 喜欢这本书的人也喜欢 / 高赞短评）已随「豆瓣上的书」模块一起撤掉。
# 这里只留抓条目页取 ISBN 所需的最小配置（书单补 ISBN 仍走豆瓣）。
DOUBAN_MIN_GAP = 0.6
# 书单分页一次抓多少本：25 本 = 豆瓣书单正好一页，一批只发一个请求，
# 跟普通翻一页没区别；100 本（4 页连发）会落到豆瓣「连续 3-5 页就 403」的区间。
# 再往后要用户点「继续加载」才抓下一批。
DOULIST_BATCH = 25
# 豆瓣「想读」默认网格一页 15 本：一批只发一个请求，翻页跟随页面上的 rel="next"，
# 不写死步长——豆瓣换列表模式时也不用跟着改。
WISH_BATCH = 15
# 防失控硬上限：正常豆列远到不了；到了就明确告诉用户「只载入了前 N 本」，不再静默截断
DOULIST_MAX_BOOKS = 2000
# 被豆瓣拦截后的冷却时间：期间不再打豆瓣，页面上的重试只会拿回同一句提示
DOUBAN_BLOCK_COOL = 10 * 60

# 公开仓地址只在这里写一次：页面上的「GitHub 项目主页」和更新检测都从它来
REPO = 'Giant-Apple/shlib-finder'
PROJECT_URL = 'https://github.com/' + REPO
UPDATE_API = 'https://api.github.com/repos/%s/releases/latest' % REPO
# GitHub API 在国内时通时不通；两个静态 version.json 作为降级。
# 都拿不到就如实说「查不到」，不能把失败当成「已是最新」。
UPDATE_FALLBACKS = (
    'https://raw.githubusercontent.com/%s/main/version.json' % REPO,
    'https://cdn.jsdelivr.net/gh/%s@main/version.json' % REPO,
)


def holdings_cache_sweep(max_age=None, max_size=None):
    """删掉早就过期的馆藏缓存。只读不判删的话这个目录只涨不落（实测 46 个文件 17MB），
    每份还是整页 HTML（单份最大 1.5MB）。启动时清一次，之后每 50 次写入清一次。
    2026-10-22 加 size 上限：旧版「全部查一遍」实测产生 24MB，无限制会吃光小容量磁盘。
    超过 max_size（默认 50MB）时按 mtime 从旧到新删，直到总大小回到上限以下。"""
    max_age = max_age or (HOLDINGS_TTL * 2)
    max_size = max_size or (50 << 20)  # 50 MB
    removed = 0
    try:
        now = time.time()
        # 第一遍：删过期文件
        for f in os.scandir(HOLDINGS_DIR):
            try:
                if now - f.stat().st_mtime > max_age:
                    os.remove(f.path)
                    removed += 1
            except OSError:
                pass
        # 第二遍：超容量时按 mtime 从旧到新删
        files = []
        total_size = 0
        for f in os.scandir(HOLDINGS_DIR):
            try:
                st = f.stat()
                files.append((st.st_mtime, st.st_size, f.path))
                total_size += st.st_size
            except OSError:
                pass
        if total_size > max_size:
            files.sort()  # oldest first
            for mtime, size, path in files:
                if total_size <= max_size:
                    break
                try:
                    os.remove(path)
                    total_size -= size
                    removed += 1
                except OSError:
                    pass
    except (FileNotFoundError, NotADirectoryError):
        return 0
    if removed:
        print('馆藏缓存清理：删掉 %d 个文件' % removed)
    return removed

# 明文地图 Key 只发给**真实回环来源**（见 Handler.is_loopback_req）：
# 开了局域网访问后，手机同网段也能用页面，但拿不到 Key；--lan-key 是显式放行。
# main() 里按命令行参数改写。
LISTEN_LOCAL = False
# 逃生口：--lan-key。明确知道自己在干什么、也想让手机上的地图能用时，
# 用这个开关在局域网模式下照样外发明文 Key（代价就是同 WiFi 的人都能读到）
EXPOSE_KEY_ON_LAN = False

# 豆瓣图片有防盗链：无 Referer 返 418（14 字节占位图），localhost Referer 返 403，
# 只有带 douban.com 的 Referer 才给真图。浏览器里改不了 Referer，所以由这一层代取。
# 取到的图**只放内存**：这条通道只在上图没封面时才走，不是常用资源，不值得往磁盘上摊。
COVER_HOSTS = ('doubanio.com', 'douban.com')
COVER_MIN_BYTES = 200   # 小于这个基本就是 418 那张占位图
COVER_MEM = {}          # 图地址 → (字节, Content-Type)，随进程活
COVER_MEM_MAX = 8 << 20
COVER_MEM_BYTES = 0

def key_visible(loopback_req=False):
    """明文地图 Key 能不能发给浏览器。
    按**真实来源**判定而不是 Host 头（Host 可以伪造）：监听 0.0.0.0 时，从 127.0.0.1
    打开的（就是本机浏览器）照常给，从局域网 IP 打开的不给——要的就是「外人拿不到」，
    没必要连自己桌面上的地图一起废掉。--lan-key 是显式放行。"""
    return bool(LISTEN_LOCAL or EXPOSE_KEY_ON_LAN or loopback_req)


# 二维码要用 qrcode 库：它装在项目自带的 vendor/ 里，跟着目录走，不依赖某台机器上的 venv。
# 必须在 import qrcode 之前把路径塞进去
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'vendor'))

UPSTREAM = 'https://vufind.library.sh.cn'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

DEFAULT_CONFIG = {
    # 不写任何具体书单：这是「某个人的豆列」，不该成为默认值跟着出厂。
    # 留空时页面显示一句「去设置里填书单地址」，用户自己贴自己的。
    'doulist_url': '',
    # 豆瓣个人「想读」列表：和豆列同时可用，也可以只填其中一个。
    # 地址里带豆瓣账号 ID，同样只留在本机。
    'wish_url': '',
    # 局域网访问：默认关闭，只监听 127.0.0.1。开启后监听 0.0.0.0，
    # 同一 WiFi 下的手机可以只读访问（见 api_config 的只读规则）。
    # 绑定在启动时决定，所以切换开关后需要重启服务。
    'lan': False,
    'geocode': {'provider': 'amap', 'key': ''},
    # 地图显示用的另一把 Key：高德「Web端(JS API)」类型，跟上面 Web 服务那把不通用。
    # 2021-12-02 之后申请的 Key 还要配 security 安全密钥（控制台同一行可见）。
    'map': {'key': '', 'security': ''},
}


# ---------------------------------------------------------------- 配置

# ThreadingTCPServer 每个请求一个线程：设置面板保存配置时可能正好有 geocode/cycling
# 在读同一个文件，读到写了一半的 JSON 会直接抛异常。读写都过这把锁。
# 原子写还有一层保险：先写临时文件再 os.replace，进程被杀也不会留下半个 config.json。
CFG_LOCK = threading.RLock()

# 豆瓣书单缓存（DOULIST_CACHE）的读写锁：多个不同 URL 并发抓取时，
# 各自「读全部缓存 → 加自己的条目 → 写整文件」会互相覆盖，套这把锁并在写前重读合并
DOULIST_LOCK = threading.RLock()

# 坐标缓存（GEOCODE_CACHE）的读写锁：多个地址并发编码时，
# 「读缓存 → 加条目 → 写文件」会互相覆盖，套这把锁并在写前重读合并
GEOCODE_LOCK = threading.RLock()

# 版本缓存（EDITIONS_CACHE）的读写锁：一次书名检索会并发取多条记录的 RIS，
# 每条都要「读缓存 → 合并 → 写整文件」，不加锁会互相覆盖。
EDITIONS_LOCK = threading.RLock()

# 豆瓣请求节流：两次请求的发起时间至少隔 DOUBAN_MIN_GAP 秒。
# 书单翻页和补 ISBN 都走这一道，连续请求很容易触发反爬。
DOUBAN_GAP_LOCK = threading.Lock()
DOUBAN_LAST_AT = 0.0

# 豆瓣反爬冷却：识别到拦截页后到某个时刻为止不再发请求，避免用户连点「重试」
# 反而把封禁时间越拖越长。状态只在内存里，重启服务即清空。
DOUBAN_BLOCK_LOCK = threading.Lock()
DOUBAN_BLOCKED_UNTIL = 0.0

# 补 ISBN 的节奏锁：豆列和想读各跑一个后台线程，如果各睡各的，两个 1 秒/本
# 叠起来就是 2 次/秒。把「取一本 + 歇一秒」整段放进同一把锁，两个来源合计
# 仍然最多 1 次/秒，代价是两边轮流补、都慢一点。
ISBN_PACE_LOCK = threading.Lock()

# 更新检测：RUN 锁保证一次只打一个检测（手动连点不叠加），STATE 锁只护结果缓存。
UPDATE_RUN_LOCK = threading.Lock()
UPDATE_STATE_LOCK = threading.Lock()
UPDATE_STATE = {'at': 0.0, 'result': None}


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    with CFG_LOCK:
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, encoding='utf-8') as f:
                    user = json.load(f)
                for k, v in user.items():
                    if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                        cfg[k].update(v)
                    else:
                        cfg[k] = v
            except Exception as e:
                sys.stderr.write('config.json 读取失败：%s\n' % e)
    # 环境变量优先级最高，方便临时覆盖
    if os.environ.get('AMAP_KEY'):
        cfg['geocode'] = {'provider': 'amap', 'key': os.environ['AMAP_KEY'].strip()}
    elif os.environ.get('QQMAP_KEY'):
        cfg['geocode'] = {'provider': 'qq', 'key': os.environ['QQMAP_KEY'].strip()}
    return cfg


def save_config(cfg):
    with CFG_LOCK:
        tmp = CONFIG_PATH + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, CONFIG_PATH)


def atomic_write_json(path, obj, indent=1):
    """原子写 JSON：先写临时文件、fsync、再 os.replace，进程被杀也不会留半截文件。

    比裸 json.dump(open(...)) 安全——缓存/配置/网点数据落盘统一走它。
    崩溃恰好发生在写文件途中时，临时文件要么没出现、要么没 replace，
    原文件（上一次的完整版本）始终还在，下次读取不会拿到半截 JSON。
    """
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ---------------------------------------------------------------- HTTP

def http_get(url, timeout=30, headers=None, data=None):
    h = {'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9'}
    if headers:
        h.update(headers)
    if data is not None and not isinstance(data, bytes):
        data = urllib.parse.urlencode(data).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', 'ignore')


# ---------------------------------------------------------------- 更新检测

def parse_semver(v):
    """'v1.2.3' / '1.2.3' → (1, 2, 3)；不合规返回 None。"""
    m = re.fullmatch(r'\s*[vV]?(\d+)\.(\d+)\.(\d+)\s*', str(v or ''))
    return tuple(int(x) for x in m.groups()) if m else None


def _newer(latest, current):
    a, b = parse_semver(latest), parse_semver(current)
    return bool(a and b and a > b)


def _latest_release():
    """查最新版本，返回 (版本号, 发布页)。查不到返回 (None, None)——不能把失败当「已是最新」。

    先问 GitHub Releases API；国内网络下它时通时不通，所以再用仓库里的
    version.json 兜底（raw.githubusercontent.com 和 jsDelivr 各一个）。
    这些都只是 GET 一个公开地址，不发任何本机信息。
    """
    try:
        data = json.loads(http_get(UPDATE_API, timeout=10,
                                   headers={'Accept': 'application/vnd.github+json'}))
        tag = str(data.get('tag_name') or '').strip()
        if parse_semver(tag):
            url = str(data.get('html_url') or '').strip()
            return tag.lstrip('vV'), url or (PROJECT_URL + '/releases')
    except Exception:
        pass
    for u in UPDATE_FALLBACKS:
        try:
            ver = str(json.loads(http_get(u, timeout=8)).get('version') or '').strip()
            if parse_semver(ver):
                return ver, PROJECT_URL + '/releases'
        except Exception:
            continue
    return None, None


def update_peek():
    """设置面板打开时读一眼缓存，不发请求——检查更新只在用户点按钮时发生。"""
    with UPDATE_STATE_LOCK:
        res = UPDATE_STATE.get('result')
    out = dict(res) if res else {'latest': '', 'url': PROJECT_URL + '/releases',
                                 'checkedAt': '', 'never': True}
    out['current'] = VERSION
    return out


def update_check():
    """用户点了「检查更新」：必须重新请求。成功才覆盖缓存，
    失败不会把上一次查到的结果冲掉（下次打开设置还能看到那条）。"""
    # 连点两下也只跑一次：第二下等第一下结束，拿同一份结果
    with UPDATE_RUN_LOCK:
        ver, url = _latest_release()
        res = {
            'current': VERSION,
            'latest': ver or '',
            'url': url or (PROJECT_URL + '/releases'),
            'newer': _newer(ver, VERSION),
            'failed': not ver,
            'checkedAt': time.strftime('%Y-%m-%d %H:%M'),
        }
        if ver:
            with UPDATE_STATE_LOCK:
                UPDATE_STATE['at'] = time.time()
                UPDATE_STATE['result'] = res
        return dict(res)


# ---------------------------------------------------------------- 豆瓣

DOULIST_RE = re.compile(r'^https?://(?:www\.)?douban\.com/doulist/(\d+)', re.I)
# 图书「想读」只认 book.douban.com；www.douban.com/people/<id>/wish 是影视「想看」，
# 别把电影列表抓进来当书查。
WISH_RE = re.compile(r'^https?://book\.douban\.com/people/([^/?#]+)/wish(?:[/?#]|$)', re.I)
WISH_MOVIE_RE = re.compile(r'^https?://(?:www|movie)\.douban\.com/people/([^/?#]+)/wish', re.I)


def list_kind_of(raw):
    return 'wish' if WISH_RE.match((raw or '').strip()) else 'doulist'


def doulist_url_of(raw):
    """支持整段 URL 或纯数字 id。"""
    raw = (raw or '').strip()
    if not raw:
        return ''
    if raw.isdigit():
        return 'https://www.douban.com/doulist/%s/' % raw
    m = DOULIST_RE.match(raw)
    if m:
        return 'https://www.douban.com/doulist/%s/' % m.group(1)
    return raw


def wish_url_of(raw):
    """把想读地址收成规范形式：去掉 ?start= 之类的翻页参数，只留账号和 /wish。"""
    raw = (raw or '').strip()
    if not raw:
        return ''
    m = WISH_RE.match(raw)
    if m:
        return 'https://book.douban.com/people/%s/wish' % m.group(1)
    if WISH_MOVIE_RE.match(raw):
        raise ValueError('这是影视「想看」页；图书「想读」地址要形如 '
                         'https://book.douban.com/people/你的ID/wish')
    raise ValueError('想读地址要形如 https://book.douban.com/people/你的ID/wish')


def _clean(s):
    s = re.sub(r'<[^>]+>', '', s or '')
    s = _html.unescape(s.replace('&nbsp;', ' '))
    return re.sub(r'\s+', ' ', s).strip()


def only_year(v):
    """出版年只留 4 位年份。豆瓣那边写的是「2017-1」这种年-月，跟上图只到年的
    RIS 并排显示会被读成「2017 年 1 月」——而卡片上它紧跟出版社，更像具体出版日期"""
    m = re.match(r'(\d{4})', str(v or ''))
    return m.group(1) if m else ''


def parse_doulist_page(html):
    """书单页里每条是 <div id=".." class="doulist-item">。"""
    books = []
    # 属性顺序、空白都可能随豆瓣改版变；只咬住 id + doulist-item 两个特征，
    # 少一个属性就整页解析成 0 本，长书单会在中途被当成「已经到底了」
    for blk in re.split(
            r'<div\s+(?:id="\d+"\s+class="doulist-item"|class="doulist-item"\s+id="\d+")',
            html)[1:]:
        m = re.search(r'<div class="title">\s*<a[^>]*href="([^"]*subject/(\d+)/?)"[^>]*>([\s\S]*?)</a>', blk)
        if not m:
            continue
        url, sid, title = m.group(1), m.group(2), _clean(m.group(3))
        if not title:
            continue
        cover = re.search(r'<div class="post">\s*<a[^>]*>\s*<img[^>]*src="([^"]+)"', blk)
        rating = re.search(r'rating_nums">\s*([\d.]+)\s*<', blk)
        abstract = re.search(r'<div class="abstract">([\s\S]*?)</div>', blk)
        info = {}
        if abstract:
            for line in re.split(r'<br\s*/?>', abstract.group(1)):
                t = _clean(line)
                if ':' in t or '：' in t:
                    k, v = re.split(r'[:：]', t, 1)
                    info[k.strip()] = v.strip()
        books.append({
            'id': sid,
            'title': title,
            'url': url,
            'cover': cover.group(1) if cover else '',
            'rating': rating.group(1) if rating else '',
            'author': info.get('作者', ''),
            'publisher': info.get('出版社', ''),
            'year': only_year(info.get('出版年', '')),
            # 豆列摘要里本来就有 ISBN 行：能读到就别再逐本抓详情页（想读页没有这行）
            'isbn': normalize_isbn(info.get('ISBN')),
        })
    return books


def page_name(html):
    """页面标题当列表名：豆列是「我的书单 - 豆瓣」，想读是「我想读的书(161)」。"""
    m = re.search(r'<title>([\s\S]*?)</title>', html)
    if not m:
        return ''
    name = _clean(m.group(1)).replace('豆瓣', '').strip(' |｜')
    return re.sub(r'[（(]\d+[)）]\s*$', '', name).strip()


def _split_pub(text):
    """「作者 / 出版社 / 2026-10 / 79.00元」→ 作者、出版社、年。

    想读页的 div.pub 没有「作者：」这种标签，只能按斜杠拆；年份和定价从右往左认，
    剩下的全算作者，多作者（A / B / 出版社 / 年）才不会被截掉一个。
    """
    parts = [p.strip() for p in re.split(r'\s*/\s*', text or '') if p.strip()]
    if parts and re.search(r'\d+(?:\.\d+)?\s*元', parts[-1]):
        parts.pop()
    year = ''
    for i in range(len(parts) - 1, -1, -1):
        if re.fullmatch(r'(?:19|20)\d{2}(?:-\d{1,2})?', parts[i]):
            year = only_year(parts.pop(i))
            break
    publisher = parts.pop() if parts else ''
    return ' / '.join(parts), publisher, year


def _attr(tag, name):
    m = re.search(r'\b%s="([^"]*)"' % re.escape(name), tag or '')
    return _html.unescape(m.group(1)) if m else ''


def parse_wish_page(html):
    """想读列表每条是 <li class="subject-item">，结构跟豆列完全不同：
    div.pic > img 是封面，div.info > h2 > a 是书名和条目链接，div.pub 是作者/出版社/年。
    """
    books = []
    for blk in re.split(r'<li[^>]*class="[^"]*subject-item[^"]*"', html)[1:]:
        m = re.search(
            r'<h2[^>]*>[\s\S]{0,300}?<a[^>]*href="([^"]*subject/(\d+)/?)"[^>]*>([\s\S]*?)</a>',
            blk)
        if not m:
            continue
        url, sid, title_html = m.group(1), m.group(2), m.group(3)
        title = _clean(title_html) or _attr(m.group(0), 'title')
        if not title:
            continue
        cover = ''
        pic = re.search(r'<div class="pic">([\s\S]*?)</div>', blk)
        if pic:
            img = re.search(r'<img[^>]*>', pic.group(1))
            if img:
                cover = _attr(img.group(0), 'data-src') or _attr(img.group(0), 'src')
        pub = re.search(r'<div class="pub">([\s\S]*?)</div>', blk)
        author, publisher, year = _split_pub(_clean(pub.group(1)) if pub else '')
        books.append({
            'id': sid,
            'title': title,
            'url': url,
            'cover': cover,
            'rating': '',
            'author': author,
            'publisher': publisher,
            'year': year,
            'isbn': '',
        })
    return books


def parse_wish_next(html, base_url):
    """想读页自带 <link rel="next">；跟着它走，不猜一页是 15 还是 30。"""
    m = re.search(r'<link\s+rel="next"\s+href="([^"]+)"', html, re.I)
    if not m:
        m = re.search(r'<span class="next">[\s\S]{0,400}?<a[^>]*href="([^"]+)"', html)
    if not m:
        return ''
    nxt = urllib.parse.urljoin(base_url, _html.unescape(m.group(1)))
    return nxt if nxt != base_url else ''


def check_wish_page(html):
    """想读页读不到时给出「为什么」，别把私密/改版当成「已经到底了」。"""
    if 'interest-list' in html:
        return
    head = html[:4000]
    if '登录' in head or 'accounts/login' in head or '仅自己可见' in head:
        raise DoubanPrivate()
    if '页面不存在' in html or '你要访问的页面不存在' in html:
        raise DoubanGone()
    raise DoubanFormat()


ISBN_PATTERNS = [
    r'<span class="pl">\s*ISBN:\s*</span>\s*([0-9Xx][0-9Xx\-]{9,20})',
    r'property="book:isbn"\s+content="([0-9Xx\-]+)"',
    r'"isbn13"\s*:\s*"?([0-9]{13})"?',
    r'"isbn10"\s*:\s*"?([0-9Xx]{10})"?',
]


def parse_isbn(html):
    for p in ISBN_PATTERNS:
        m = re.search(p, html)
        if m:
            v = re.sub(r'[^0-9Xx]', '', m.group(1)).upper()
            if len(v) in (10, 13):
                return v
    return ''


class DoubanBlocked(RuntimeError):
    """豆瓣的拦截页 / 403 / 429。retry_after 是还要等多少秒再试。"""

    def __init__(self, retry_after=0):
        minutes = max(1, (int(retry_after) + 59) // 60)
        super().__init__('豆瓣暂时限制了访问，约 %d 分钟后再试' % minutes)
        self.retry_after = int(retry_after)


class DoubanListError(RuntimeError):
    """列表页本身读不了：私密、地址不存在、页面改版。

    这些和反爬是两回事，不能进 10 分钟冷却——否则用户改一次隐私设置，
    就要白等十分钟，重试还会拿回同一句「豆瓣限制了访问」。
    """


class DoubanPrivate(DoubanListError):
    def __init__(self):
        super().__init__('这份想读列表不是公开的：在豆瓣把它设为公开后再试')


class DoubanGone(DoubanListError):
    def __init__(self):
        super().__init__('这个豆瓣想读地址不存在，检查一下地址')


class DoubanFormat(DoubanListError):
    def __init__(self):
        super().__init__('豆瓣想读页的样子跟程序认的不一样，可能改版了，要更新程序')


def douban_blocked_for():
    """冷却还剩多少秒。0 = 现在可以请求。"""
    with DOUBAN_BLOCK_LOCK:
        return max(0, int(DOUBAN_BLOCKED_UNTIL - time.time()))


def _mark_douban_blocked():
    global DOUBAN_BLOCKED_UNTIL
    with DOUBAN_BLOCK_LOCK:
        DOUBAN_BLOCKED_UNTIL = max(DOUBAN_BLOCKED_UNTIL, time.time() + DOUBAN_BLOCK_COOL)
        left = int(DOUBAN_BLOCKED_UNTIL - time.time())
    return DoubanBlocked(left)


def douban_get(url, timeout=20, private_hint=False):
    """抓豆瓣页面，并把「反爬拦截页」当成失败。

    豆瓣没有公开 API，页面只能照网页解析。连续快速请求会返一个「有异常请求」
    提示页（HTTP 200），如果照常解析就会得到一本空书——必须显式识别出来，
    让上层保留旧缓存/显示可重试的错误，而不是把空数据写进缓存。
    识别到一次就进入冷却：冷却期内直接抛 DoubanBlocked，不再往上发请求。

    private_hint=True 用于想读列表：403 也可能是「仅自己可见」，这时响应体里
    是登录/权限提示而不是反爬标记。分出来单独报错，别让隐私设置背反爬的锅。
    """
    global DOUBAN_LAST_AT
    left = douban_blocked_for()
    if left > 0:
        raise DoubanBlocked(left)
    with DOUBAN_GAP_LOCK:
        wait = DOUBAN_MIN_GAP - (time.time() - DOUBAN_LAST_AT)
        if wait > 0:
            time.sleep(wait)
        DOUBAN_LAST_AT = time.time()
    try:
        page = http_get(url, timeout=timeout, headers={'Referer': 'https://www.douban.com/'})
    except urllib.error.HTTPError as e:
        # 403/418/429 都是豆瓣对抓取的明确拒绝，跟拦截页同等处理
        if e.code in (403, 418, 429):
            if private_hint and e.code == 403:
                try:
                    body = e.read().decode('utf-8', 'ignore')[:4000]
                except Exception:
                    body = ''
                anti = ('有异常请求', 'sec.douban.com', '禁止访问')
                private = ('登录', '仅自己可见', '没有权限')
                if body and not any(x in body for x in anti) and any(x in body for x in private):
                    raise DoubanPrivate()
            raise _mark_douban_blocked()
        raise
    head = page[:4000]
    if 'sec.douban.com' in head or '有异常请求' in head or '禁止访问' in head:
        raise _mark_douban_blocked()
    return page


def fetch_isbn(subject_url):
    """详情页里 ISBN 在 #info 的 ISBN: 标签后。失败了不影响主流程。

    拦截不能在这里吞掉：后台补 ISBN 的线程收到 DoubanBlocked 要停下来等冷却，
    否则会对着拦截页一本一本地白打几十个请求。
    """
    try:
        return parse_isbn(douban_get(subject_url, timeout=25))
    except DoubanBlocked:
        raise
    except Exception:
        return ''


def fetch_editions(term, by_isbn=False):
    """按书名（或 ISBN）列出上图可查的版本，每条都带 ISBN。

    书名列的是「记录」，同一条书目会有多个副本记录；能拿去查馆藏的键是 ISBN，
    所以先去 /api/v1/search 拿记录 id，再读每条记录的 RIS 导出（约 200 字节，
    含 ISBN / 书名 / 作者 / 出版社 / 出版年 / 版次），按 ISBN 去重。

    为什么不用书名直接查馆藏：上图书名检索是模糊匹配，会把别的书的馆藏算进来
    （实测「中文计算机」第一条是《计算机绘图 中文版AutoCAD 2010》）。
    RIS 导出比整页 2MB 的 Record 页轻得多，适合逐条取。
    """
    term = (term or '').strip()[:120]
    if not term:
        return {'q': '', 'byIsbn': False, 'editions': [], 'records': 0}
    key = ('isbn:' if by_isbn else 'title:') + _norm_title(term)
    now = time.time()

    ids = []
    with EDITIONS_LOCK:
        cache = load_json(EDITIONS_CACHE, {})
        hit = (cache.get('queries') or {}).get(key)
    if hit and now - hit.get('at', 0) < EDITIONS_QUERY_TTL:
        ids = hit.get('ids') or []
    else:
        q = urllib.parse.urlencode({
            'lookfor': term,
            'type': 'ISBN' if by_isbn else 'Title',
            'limit': EDITIONS_MAX_RECORDS,
            'page': 1,
        })
        data = json.loads(http_get(UPSTREAM + '/api/v1/search?' + q, timeout=20))
        ids = [r.get('id') for r in (data.get('records') or []) if r.get('id')]
        ids = ids[:EDITIONS_MAX_RECORDS]
        with EDITIONS_LOCK:
            cache = load_json(EDITIONS_CACHE, {})
            cache.setdefault('queries', {})[key] = {'at': now, 'ids': ids}
            atomic_write_json(EDITIONS_CACHE, cache, indent=1)

    if not ids:
        return {'q': term, 'byIsbn': by_isbn, 'editions': [], 'records': 0}

    # 4 路并发：20 条记录约 1~3 秒；单条失败只跳过它，不让整次检索失败
    def one(rid):
        try:
            return fetch_record_meta(rid)
        except Exception:
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        metas = list(ex.map(one, ids))

    seen = set()
    items = []
    for i, m in enumerate(metas):
        if not m or not m.get('isbn') or m['isbn'] in seen:
            continue
        seen.add(m['isbn'])
        items.append({
            'isbn': m['isbn'],
            'title': m.get('title') or '',
            'author': m.get('author') or '',
            'publisher': m.get('publisher') or '',
            'year': m.get('year') or '',
            'edition': m.get('edition') or '',
            'recId': m.get('id') or '',
            # 和检索词是同一本书吗：书名归一后相等或互为前缀。
            # 前端据此做「唯一版本匹配」，不靠模糊检索的第一条。
            'same': True if by_isbn else title_same(term, m.get('title') or ''),
            '_i': i,
        })
    # 同一本书的版本排前面（上图相关度排序里偶尔混进同名的别的书）
    items.sort(key=lambda e: (0 if e['same'] else 1, e['_i']))
    total = len(items)
    for e in items:
        e.pop('_i', None)
    return {
        'q': term,
        'byIsbn': by_isbn,
        'editions': items[:EDITIONS_MAX_RETURN],
        'total': total,
        'records': len(ids),
    }


def _norm_title(s):
    """书名归一：去掉空白、标点、括号，只留字和字母（用于判断「是不是同一本书」）。"""
    return re.sub(r'[\s\u3000·・:：;；,，.。、()（）\[\]【】\-—_/\\]+', '', s or '').lower()


def title_same(q, t):
    """检索词和候选书名是不是同一本书：归一后相等，或一方是另一方的前缀。
    「置身事内」↔「置身事内 中国政府与经济发展」算同一本；
    「置身事内」↔「魏玛文化 置身事内的局外人」不算（前缀不成立）。"""
    a, b = _norm_title(q), _norm_title(t)
    if not a or not b:
        return False
    return a == b or b.startswith(a) or a.startswith(b)


def parse_ris(text):
    """RIS 导出 → 书目字段。RIS 一行一个字段：「TI  - 书名」。"""
    out = {'title': '', 'author': [], 'publisher': '', 'year': '', 'edition': '', 'isbn': []}
    for line in (text or '').splitlines():
        m = re.match(r'^([A-Z][A-Z0-9])  - (.*)$', line.rstrip())
        if not m:
            continue
        tag, val = m.group(1), m.group(2).strip()
        if tag == 'TI' and not out['title']:
            out['title'] = val
        elif tag == 'AU':
            out['author'].append(val)
        elif tag == 'PB' and not out['publisher']:
            out['publisher'] = val
        elif tag == 'PY' and not out['year']:
            out['year'] = val
        elif tag == 'ET' and not out['edition']:
            out['edition'] = val
        elif tag == 'SN':
            out['isbn'].append(val)
    out['year'] = only_year(out['year'])
    return out


def normalize_isbn(v):
    d = re.sub(r'[^0-9Xx]', '', v or '').upper()
    return d if len(d) in (10, 13) else ''


def fetch_record_meta(rec_id):
    """一条上图记录的 RIS 导出 → {isbn,title,author,publisher,year,edition}，磁盘缓存 30 天。"""
    now = time.time()
    with EDITIONS_LOCK:
        rec = (load_json(EDITIONS_CACHE, {}).get('records') or {}).get(rec_id)
    if rec and now - rec.get('at', 0) < EDITIONS_REC_TTL:
        return rec

    url = UPSTREAM + '/Record/%s/Export?style=RIS' % urllib.parse.quote(rec_id, safe='')
    p = parse_ris(http_get(url, timeout=15))
    isbn = ''
    for cand in p['isbn']:
        n = normalize_isbn(cand)
        if len(n) == 13:
            isbn = n
            break
        if n and not isbn:
            isbn = n
    rec = {
        'at': now,
        'id': rec_id,
        'isbn': isbn,
        'title': p['title'],
        'author': ' / '.join(p['author']),
        'publisher': p['publisher'],
        'year': p['year'],
        'edition': p['edition'],
    }
    with EDITIONS_LOCK:
        cache = load_json(EDITIONS_CACHE, {})
        cache.setdefault('records', {})[rec_id] = rec
        atomic_write_json(EDITIONS_CACHE, cache, indent=1)
    return rec


def fetch_shl_id(isbn):
    """按 ISBN 查上图拿 instanceId，给封面接口 /Cover/Show 用。失败返回 ''，不阻塞书单主流程。

    上图的封面接口没有防盗链（无 Referer 也 200，实测过），比豆瓣的 418 占位图省心；
    但封面挂在版本记录（instanceId）上，所以要先检索一次。

    只认 ISBN 检索，不用书名兜底：书名检索是模糊匹配，「中文计算机」能返回 190 条、
    第一条是《计算机绘图 中文版AutoCAD 2010》，抓谁都是错版的封面（2026-10-21 实测，
    书单 5 本里 2 本中招）。假 ISBN 实测返 0 条，不会误配；上图确实没有这本书就留空，
    前端退回豆瓣封面——那才是豆列自己的图，永远对得上。
    """
    if not isbn:
        return ''
    try:
        q = urllib.parse.urlencode({'lookfor': isbn, 'type': 'ISBN', 'limit': 1, 'page': 1})
        d = json.loads(http_get(UPSTREAM + '/api/v1/search?' + q, timeout=15))
        recs = d.get('records') or []
        if recs and recs[0].get('id'):
            return recs[0]['id']
    except Exception:
        pass
    return ''


# 封面 enrich 的逻辑版本。v1 = 允许书名模糊检索兜底（会抓回错版的封面，见 fetch_shl_id）；
# v2 = 只认 ISBN。缓存里 shlVer 不是当前版本的，旧 shlId 一律作废重查——否则错值会
# 被「有值就跳过」的逻辑永久粘住（2026-10-21 修 bug 时引入）。
SHL_ENRICH_VER = 2


def ensure_shl_ids(entry):
    """给缺 shlId 的书补上图 instanceId。返回是否有改动（要写回缓存）。

    只补有 ISBN 的书：ISBN 由 _fill_isbn_bg 后台补（1s/本），冷缓存刚建好时还没有，
    这时候拿书名去搜就是模糊匹配，搜到啥是啥。没 ISBN 的先跳过，等下一轮（书单
    缓存里 ISBN 补齐后自然就有了）；这期间封面走豆瓣代理，图是对的。
    """
    changed = False
    books = entry.get('books') or []
    if entry.get('shlVer') != SHL_ENRICH_VER:
        for b in books:
            if b.get('shlId') or b.get('shlAt'):
                b['shlId'] = ''
                b['shlAt'] = 0
                changed = True
        entry['shlVer'] = SHL_ENRICH_VER
        changed = True
    for b in books:
        if b.get('shlId'):
            continue
        # 查过但没查到（上图确实没有这本书）的，7 天内不再重试。
        # 以前只看值：失败返回空串，下次 open 页面又当成「没查过」重来一遍——
        # 每开一次页面都重发 N 次上图请求 + N×0.3s 串行，而且每次都重写整个缓存文件
        if b.get('shlAt') and time.time() - float(b['shlAt']) < SHL_RETRY_TTL:
            continue
        if not b.get('isbn'):
            continue
        b['shlId'] = fetch_shl_id(b.get('isbn'))
        b['shlAt'] = time.time()
        changed = True
        time.sleep(0.3)   # 对上图也客气点
    return changed


# 后台补 ISBN 按书单 URL 去重：同一个书单同时只跑一个 worker。
# 用户点「继续加载」追加新书时，worker 每轮重读缓存会把新书带上；
# 不能为每一批再起一个线程——那会对豆瓣并发请求，正好撞在反爬上。
ISBN_WORK_LOCK = threading.Lock()
ISBN_WORKERS = set()

# 上图封面 id 的后台 worker 也一样按 URL 去重。以前它在 /api/doulist 里同步跑，
# 书一多（每本 0.3 秒）打开书架就要干等几十秒——ISBN 补齐后先返回页面，
# 封面 id 慢慢补，下次打开就齐了。
SHL_WORK_LOCK = threading.Lock()
SHL_WORKERS = set()


def _read_doulist_cache():
    try:
        with open(DOULIST_CACHE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def _write_doulist_entry(url, entry, merge=False):
    """写回缓存。merge=True 时把磁盘上已有的同书单条目按 id 并进来，
    避免两个请求各拿旧快照互相覆盖。调用方要持有 DOULIST_LOCK。"""
    latest = _read_doulist_cache()
    if merge:
        old = latest.get(url) or {}
        base = list(old.get('books') or [])
        have = {b.get('id') for b in base}
        for b in entry.get('books') or []:
            if b.get('id') not in have:
                base.append(b)
                have.add(b.get('id'))
        entry = dict(entry)
        entry['books'] = base
    latest[url] = entry
    atomic_write_json(DOULIST_CACHE, latest, indent=1)
    return entry


def _isbn_worker(url):
    """后台补 ISBN：一本一本查（1s/本），每 5 本合并回缓存。
    撞上豆瓣拦截立刻停（冷却期内不再发请求），已经补到的先落盘。"""
    filled = {}

    def flush():
        if not filled:
            return
        with DOULIST_LOCK:
            latest = _read_doulist_cache()
            entry = latest.get(url)
            if entry:
                changed = False
                for b in entry.get('books') or []:
                    if not b.get('isbn') and b.get('url') in filled:
                        b['isbn'] = filled[b['url']]
                        changed = True
                if changed:
                    atomic_write_json(DOULIST_CACHE, latest, indent=1)
        filled.clear()

    try:
        while True:
            entry = _read_doulist_cache().get(url)
            books = (entry or {}).get('books') or []
            pending = [b for b in books
                       if not b.get('isbn') and b.get('url') and b['url'] not in filled]
            if not pending:
                flush()
                return
            for b in pending:
                try:
                    # 豆列和想读各有一个 worker：把「取一本 + 歇一秒」整段锁住，
                    # 两个来源合计仍是最多 1 次/秒，不会叠成 2 次/秒去撞反爬
                    with ISBN_PACE_LOCK:
                        try:
                            isbn = fetch_isbn(b['url'])
                        finally:
                            time.sleep(1.0)
                except DoubanBlocked:
                    flush()
                    return
                except Exception:
                    isbn = ''
                if isbn:
                    filled[b['url']] = isbn
                    if len(filled) >= 5:
                        flush()
            if not filled:
                return   # 一整轮一本都没补到，别再空转
    finally:
        try:
            flush()
        except Exception:
            pass
        with ISBN_WORK_LOCK:
            ISBN_WORKERS.discard(url)


def ensure_isbn_worker(url):
    if douban_blocked_for() > 0:
        return
    with ISBN_WORK_LOCK:
        if url in ISBN_WORKERS:
            return
        ISBN_WORKERS.add(url)
    threading.Thread(target=_isbn_worker, args=(url,), daemon=True).start()


def _shl_worker(url):
    """后台补上图封面 id。在副本上跑 ensure_shl_ids，跑完再按条目 url 合并回缓存，
    免得网络请求期间跟响应序列化抢同一份 books 列表。"""
    try:
        with DOULIST_LOCK:
            entry = _read_doulist_cache().get(url)
            entry = json.loads(json.dumps(entry)) if entry else None
        if not entry or not ensure_shl_ids(entry):
            return
        with DOULIST_LOCK:
            latest = _read_doulist_cache()
            cur = latest.get(url)
            if not cur:
                return
            src = {b.get('url'): b for b in entry.get('books') or []}
            for b in cur.get('books') or []:
                found = src.get(b.get('url'))
                if found and found.get('shlId') and not b.get('shlId'):
                    b['shlId'] = found['shlId']
                    b['shlAt'] = found.get('shlAt') or time.time()
            cur['shlVer'] = entry.get('shlVer', cur.get('shlVer'))
            atomic_write_json(DOULIST_CACHE, latest, indent=1)
    finally:
        with SHL_WORK_LOCK:
            SHL_WORKERS.discard(url)


def ensure_shl_worker(url):
    with SHL_WORK_LOCK:
        if url in SHL_WORKERS:
            return
        SHL_WORKERS.add(url)
    threading.Thread(target=_shl_worker, args=(url,), daemon=True).start()


def _doulist_page_url(url, start):
    if start <= 0:
        return url
    return url + ('&' if '?' in url else '?') + 'start=%d' % start


def load_doulist(raw_url, refresh=False, more=False, ttl=12 * 3600, with_isbn=True,
                 kind=None):
    """抓一份豆瓣豆列或想读列表，按批返回。

    - 默认：缓存完整且未过期就用缓存；否则从第 1 页开始抓一批。
    - more=True：从缓存里的翻页位置接着抓下一批，并回同一份缓存。
    - refresh=True：丢掉进度，从第 1 页重新抓一批。

    豆列一页 25 本、用 ?start=N 翻页；想读一页 15 本、跟页面上的 rel="next" 走。
    两种页面结构完全不同，解析函数也分开，只有缓存和限流这一层共用。
    每页都走 douban_get（限流 + 反爬识别），一批最多 batch 本。
    被拦截时：有旧数据就返回旧数据并带 blockedFor，让页面继续用旧列表；
    没有旧数据才抛 DoubanBlocked。私密/不存在/改版走 DoubanListError，不进冷却，
    也不会被当成「已经到底了」。
    """
    kind = kind or list_kind_of(raw_url)
    if kind == 'wish':
        url = wish_url_of(raw_url)
        batch = WISH_BATCH
        parse_page = parse_wish_page
    else:
        kind = 'doulist'
        url = doulist_url_of(raw_url)
        batch = DOULIST_BATCH
        parse_page = parse_doulist_page
    if not url:
        raise ValueError('没有想读地址' if kind == 'wish' else '没有书单地址')

    cache = _read_doulist_cache()
    hit = cache.get(url)
    if hit:
        # 老缓存里存的是「2017-1」这种年-月：读出来就地收成 4 位，不用等下一次重抓
        for b in hit.get('books') or []:
            b['year'] = only_year(b.get('year'))
        # 旧版本缓存没有 complete 字段：有书就按完整处理，别让页面一直挂着「继续加载」
        if 'complete' not in hit:
            hit['complete'] = bool(hit.get('books'))
        # 旧代码曾被反爬页骗出一份 0 本的空缓存：直接当没有，重新抓
        if not hit.get('books'):
            hit = None

    if hit and not refresh and not more:
        serve = None
        if hit.get('complete'):
            if time.time() - hit.get('at', 0) < ttl:
                serve = hit
        else:
            # 分批抓到一半：先把已有的给页面，下一批等用户点「继续加载」
            serve = hit
        if serve:
            # 缓存命中也补 ISBN：补全线程按缓存里的书逐本抓，只在真的抓过列表后才启动的话，
            # 重启后只读缓存的老书单永远补不上（想读页本身没有 ISBN）
            if with_isbn:
                ensure_isbn_worker(url)
            return serve

    old_books = list(hit.get('books') or []) if hit else []
    if more:
        if not hit or hit.get('complete') or hit.get('truncated'):
            return hit or {'url': url, 'kind': kind, 'name': '', 'at': 0, 'books': [],
                           'complete': True, 'nextStart': 0, 'nextUrl': ''}
        start = int(hit.get('nextStart') or len(old_books))
        cursor = hit.get('nextUrl') or ''
        books = list(old_books)
        if kind == 'wish' and not cursor:
            # 想读缓存是这版才加的，正常都有 nextUrl；万一没有就当已到底，
            # 别从第 1 页重抓一遍把同一批书叠进去
            out = dict(hit)
            out['complete'] = True
            return out
    else:
        start = 0
        cursor = url
        books = []

    # 冷却期内不再打豆瓣：有旧数据就照常返回，只是标注还要等多久
    left = douban_blocked_for()
    if left > 0:
        if hit:
            out = dict(hit)
            out['blockedFor'] = left
            return out
        raise DoubanBlocked(left)

    name = (hit or {}).get('name', '')
    seen = {b.get('id') for b in books}
    added = 0
    complete = False
    truncated = False
    blocked_for = 0
    failed = False
    first_page = not more

    while len(books) < DOULIST_MAX_BOOKS:
        page_url = cursor if kind == 'wish' else _doulist_page_url(url, start)
        try:
            page = douban_get(page_url, timeout=25, private_hint=(kind == 'wish'))
        except DoubanBlocked as e:
            blocked_for = e.retry_after
            break
        except DoubanListError:
            # 私密 / 地址不存在 / 改版：不是反爬，不进冷却，原样告诉用户。
            # 手上还有旧数据也照抛——用户多半是刚把列表设成私密，得让他知道
            raise
        except Exception:
            failed = True
            break
        if first_page:
            name = page_name(page) or name
            first_page = False
        if kind == 'wish':
            check_wish_page(page)
            page_books = parse_page(page)
            cursor = parse_wish_next(page, page_url)
        else:
            page_books = parse_page(page)
        if not page_books:
            # 想读页有「下一页」却一条都没解析出来，只能是结构变了；
            # 当成到底会把半份列表写成完整缓存
            if kind == 'wish' and cursor:
                raise DoubanFormat()
            complete = True
            break
        fresh = [b for b in page_books if b.get('id') not in seen]
        if not fresh:
            complete = True
            break
        for b in fresh:
            seen.add(b.get('id'))
        books.extend(fresh)
        added += len(fresh)
        if kind == 'wish':
            # 想读一批就是一个请求，翻页位置已经跟着 rel="next" 更新好了
            if not cursor:
                complete = True
            break
        start += 25
        if added >= batch:
            break

    if kind == 'doulist' and start >= DOULIST_MAX_BOOKS:
        truncated = True
    elif len(books) >= DOULIST_MAX_BOOKS:
        truncated = True

    # 一本都没拿到：有旧数据就认旧的；没有旧数据就明确报错，
    # 别让页面把「被拦截 / 网络失败」显示成「尚未设置书单」
    if not books:
        if blocked_for and old_books:
            out = dict(hit)
            out['blockedFor'] = blocked_for
            return out
        if blocked_for:
            raise DoubanBlocked(blocked_for)
        noun = '想读列表' if kind == 'wish' else '书单'
        if failed:
            raise RuntimeError('网络请求失败，没能读到豆瓣%s' % noun)
        raise RuntimeError('豆瓣没有返回%s条目，可能暂时被限制，请稍后再试' % noun)

    # 自动续期（不是用户点刷新）撞上一批抓不完的长书单时，不能把更全的旧缓存
    # 覆盖成一小截。显式刷新才允许用新进度替换——页面会明说「已载入 N 本」。
    if not more and not refresh and not complete and len(books) < len(old_books):
        out = dict(hit)
        out['blockedFor'] = blocked_for
        return out

    out = {
        'url': url, 'kind': kind, 'name': name, 'at': time.time(), 'books': books,
        'complete': complete, 'nextStart': 0 if complete else start,
        'nextUrl': '' if complete or kind != 'wish' else cursor,
        'truncated': truncated,
    }
    with DOULIST_LOCK:
        out = _write_doulist_entry(url, out, merge=bool(more))
    # blockedFor 只在这一响应里有效，不落缓存——否则重启后还在倒计时
    if blocked_for:
        out = dict(out)
        out['blockedFor'] = blocked_for
    if with_isbn:
        ensure_isbn_worker(url)
    return out


# ---------------------------------------------------------------- 地理编码

def load_json(path, default):
    try:
        return json.load(open(path, encoding='utf-8'))
    except Exception:
        return default


# 上海的判断：行政编码 31 开头最准，上游没给 adcode 时退到经纬度方框
SH_ADPCODE = '31'
SH_LNG = (120.85, 122.00)
SH_LAT = (30.65, 31.90)
# 高德对一个整城/整区的名字也给结果，坐标落在市中心（实测 上海市南京南站 + city=上海
# → adcode 310000、level「省」、121.473667,31.230525 = 人民广场）。用户明明输了更具体的
# 地方却只匹配到行政区划，就是那次静默兜底，别把它当成命中
GEO_ADMIN_LEVELS = ('国家', '省', '市', '区县', '区', '县')


def in_shanghai(lat, lng, adcode=''):
    ac = str(adcode or '')
    if ac[:2] == SH_ADPCODE:
        return True
    if len(ac) >= 6:
        return False
    return SH_LNG[0] <= lng <= SH_LNG[1] and SH_LAT[0] <= lat <= SH_LAT[1]


def _is_area_name(addr, place):
    """用户就输了个行政区名（上海 / 上海市）：这种输入给市中心是对的，不算错点"""
    a = re.sub(r'(省|市|区|县|自治区)$', '', (addr or '').strip())
    p = re.sub(r'(省|市|区|县|自治区)$', '', (place or '').strip())
    return bool(a) and (a == p or (p and p.startswith(a)))


def _geocode_once(provider, addr, key):
    """一次上游查询 → (lat, lng, 落在哪个城市, adcode, 匹配层度, 错误说明)。
    出错时前五个是 None/空串，最后一个是给用户看的一句话。"""
    try:
        if provider == 'qq':
            d = json.loads(http_get('https://apis.map.qq.com/ws/geocoder/v1/?' +
                                    urllib.parse.urlencode({'address': addr, 'key': key}),
                                    timeout=15))
            if d.get('status') != 0:
                return None, None, '', '', '', '地理编码失败（腾讯地图无法识别此地址）'
            res = d.get('result') or {}
            loc = res.get('location') or {}
            comp = res.get('addressComponent') or {}
            return (float(loc.get('lat')), float(loc.get('lng')),
                    comp.get('city') or comp.get('province') or '',
                    str(comp.get('adcode') or ''), '', None)
        d = json.loads(http_get('https://restapi.amap.com/v3/geocode/geo?' +
                                urllib.parse.urlencode({'address': addr, 'key': key}),
                                timeout=15))
        geos = d.get('geocodes') or []
        if d.get('status') != '1' or not geos:
            return None, None, '', '', '', '地理编码失败（高德地图无法识别此地址）'
        g = geos[0]
        lng, lat = str(g.get('location', '')).split(',')[:2]
        return (float(lat), float(lng), g.get('city') or g.get('province') or '',
                str(g.get('adcode') or ''), str(g.get('level') or ''), None)
    except Exception:
        # 不暴露异常原文（可能包含技术细节），给用户友好的提示
        return None, None, '', '', '', '地理编码失败（网络请求出错，请稍后重试）'


def geocode_address(addr, cfg):
    """地址 → GCJ-02 坐标，返回 (lat, lng, 说明, 错误码)。

    只认上海范围内的位置。以前这里给所有输入硬加「上海市」前缀、再带上 city=上海，
    高德对「南京南站」匹配不到就退成整城记录（坐标正是市中心），于是定位悄悄跳到
    人民广场，页面还报「位置已设为：南京南站」。改成先按原样全国检索：落在别的省市
    就明说拒掉；但裸地名（「人民广场」）全国检索会撞上别的城市的同名地点，所以那种
    情况还要再补一发「上海市+输入」，上海这边查得到就用上海的。距离、骑行、地图全都
    建立在「从这儿骑到上图分馆」上，位置在上海之外时它们不是不准，是无意义。
    """
    addr = (addr or '').strip()
    if not addr:
        return None, None, '地址为空', ''
    gcfg = cfg.get('geocode') or {}
    key = (gcfg.get('key') or '').strip()
    if not key:
        return None, None, '没有配置 Web 服务 Key', 'needKey'
    provider = gcfg.get('provider', 'amap')

    tries = [addr]
    if not addr.startswith('上海'):
        # 第二发把「上海市」拼进地址串，而不是用接口的 city 参数：实测高德 v3 的 city
        # 对裸地名根本不起作用（人民广场 + city=上海 照样回眉山），只有地址前缀改得动归属。
        # 腾讯那个接口也没有可用的城市限制参数，两边正好用同一种写法
        tries.append('上海市' + addr)

    last_err = '没查到这个位置'
    far_place = ''
    far_blind = False
    for t in tries:
        # 键带 v2：老键是「上海市+用户输入」拼出来的旧版结果，里面存着上一版静默兜底
        # 出来的市中心错点，换了命名空间就不会再被读到
        ck = 'v2|%s|%s' % (provider, t)
        # 读缓存加锁：并发请求时避免读到写了一半的文件
        with GEOCODE_LOCK:
            cache = load_json(GEOCODE_CACHE, {})
            if ck in cache and cache[ck].get('lat'):
                c = cache[ck]
                return c['lat'], c['lng'], 'cache', ''

        lat, lng, place, adcode, level, err = _geocode_once(provider, t, key)
        if err:
            last_err = err
            # 前面已经撞上一个外地同名点、这一发又只是「查不到」：那就分不清是用户
            # 真指外地，还是地图临时没答上（实测同一个地址连着两发结果会不一样）
            far_blind = far_blind or bool(far_place)
            continue
        if not in_shanghai(lat, lng, adcode):
            # 全国检索撞上别的城市的同名地点（裸地名十有八九是这样）：先记下，
            # 不能就此拒掉——这应用只算上海，用户指的是上海那一个的概率更高，
            # 后面那次上海限定才是给他的答案。上海限定也没结果时才回报这个外地
            far_place = far_place or (place or '别的城市')
            continue
        if level in GEO_ADMIN_LEVELS and not _is_area_name(t, place):
            # 只匹配到行政区划 = 这一版没真找到，别再拿市中心当答案（留给下一次尝试）
            last_err = '「%s」在上海没查到具体的地方，换个更完整的说法再试' % addr
            continue

        # 写缓存加锁：写前重读最新缓存再合并，避免并发写入互相覆盖丢条目
        with GEOCODE_LOCK:
            latest = load_json(GEOCODE_CACHE, {})
            latest[ck] = {'lat': lat, 'lng': lng, 'at': time.time()}
            # 顺手清掉老命名的条目：上一版静默兜底出来的市中心错点就存在这里面，
            # 而网点坐标早就写进 libraries.json，老键没人在读了
            latest = dict((k, v) for k, v in latest.items() if k.startswith('v2|'))
            atomic_write_json(GEOCODE_CACHE, latest, indent=1)
        return lat, lng, 'ok', ''
    if far_place:
        if far_blind:
            # 别把上游没答上来报成「你在外地」——那是查不到，不是位置不对
            return (None, None,
                    '「%s」在上海没查到（网上只匹配到%s的同名地点），换个更完整的地址再试'
                    % (addr, far_place),
                    '')
        return (None, None,
                '「%s」在%s，不在上海——距离、骑行和地图只算得出上海范围内的位置'
                % (addr, far_place),
                'outOfShanghai')
    return None, None, last_err, ''


# ---------------------------------------------------------------- 骑行（高德）

BIKE_CACHE = {}

# 高德骑行规划的并发上限是每秒 3 次。前端已经把同时请求压到 3（app.js 的 worker 池），
# 可这 3 条是同时发出去的，加上第二个标签页、手机、地图重绘，照样会在同一个瞬间撞到
# 上限——上游返回 400，界面上就是一片没有骑行时间的卡片，看着像功能坏了。
# 这里按「两次上游请求至少隔 1/3 秒」串行放行：排队半秒用户看不出来，返 400 看得出来。
# 缓存命中的那次不发请求，不受这个间隔影响。
BIKE_MIN_GAP = 1.0 / 3
BIKE_GAP_LOCK = threading.Lock()
BIKE_LAST_AT = 0.0


def bike_gate():
    """等一个能向高德发骑行请求的时机（全进程共享，见 BIKE_MIN_GAP）。"""
    global BIKE_LAST_AT
    with BIKE_GAP_LOCK:
        wait = BIKE_MIN_GAP - (time.time() - BIKE_LAST_AT)
        if wait > 0:
            time.sleep(wait)
        BIKE_LAST_AT = time.time()


def amap_key(cfg):
    """骑行只走高德；配置成腾讯 Key 时自动不可用。"""
    g = cfg.get('geocode') or {}
    if g.get('provider') != 'amap':
        return ''
    return (g.get('key') or '').strip()


def bike_estimate(origin, dest, cfg):
    """origin/dest 都是 'lng,lat'（GCJ-02）。返回 ({minutes, distance}, 说明)。"""
    key = amap_key(cfg)
    if not key:
        return None, '骑行时间需要高德 Key'
    ck = origin + '|' + dest
    hit = BIKE_CACHE.get(ck)
    if hit and time.time() - hit['at'] < 3600:
        return hit['v'], 'cache'
    bike_gate()
    try:
        q = urllib.parse.urlencode({'origin': origin, 'destination': dest, 'key': key})
        d = json.loads(http_get('https://restapi.amap.com/v4/direction/bicycling?' + q, timeout=12))
        if str(d.get('errcode')) != '0':
            # 不暴露上游原始错误信息，给用户友好的提示
            return None, '骑行路径规划失败（高德无法计算此路线）'
        paths = (d.get('data') or {}).get('paths') or []
        if not paths:
            return None, '没有骑行路线'
        p = paths[0]
        v = {
            'minutes': int(round(float(p.get('duration') or 0) / 60.0)),
            'distance': int(float(p.get('distance') or 0)),
        }
        BIKE_CACHE[ck] = {'at': time.time(), 'v': v}
        return v, 'ok'
    except Exception as e:
        # 不暴露异常原文，给用户友好的提示
        return None, '骑行路径规划失败（网络请求出错，请稍后重试）'


# ---------------------------------------------------------------- 网点补坐标（后台线程）

BACKFILL = {'running': False, 'done': 0, 'total': 0, 'ok': 0, 'fail': 0, 'current': '', 'error': ''}

# 本进程实际监听在哪里。默认 127.0.0.1；设置里的开关拨一下就地换（见 apply_lan_binding），
# 不用重启——重启意味着手机上那页会断，而用户只是在电脑上动了个开关。
PORT = 8765
LAN_BOUND = False
HTTPD = None            # 当前这个监听实例；换监听地址时整体替换
STOP = threading.Event()   # 主线程靠它挂住（serve_forever 挪到了后台线程）
LAN = {'on': False, 'url': '', 'qr': ''}


def lan_ip():
    """本机在局域网里的 IP（连外网探一下出口方向，不发包）。"""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('223.5.5.5', 80))
        return s.getsockname()[0]
    finally:
        s.close()


def build_lan_info():
    """局域网访问的现状：开关值、实际是否在监听、手机该打开的地址和二维码。

    地址每次现算：换 WiFi / DHCP 换 IP 后二维码跟着变，不用为此重启服务。
    二维码用 vendor/ 里的 qrcode 画成 SVG；库缺失时 qr 留空，前端只显示地址。
    """
    cfg = load_config()
    enabled = bool(cfg.get('lan'))
    # local：进程是 --local 起的，开关拨上去也不会监听局域网——前端据此说清楚原因，
    # 不然「已开启但没生效」看起来像是坏了
    local = LISTEN_LOCAL
    if not enabled or not LAN_BOUND:
        return {'enabled': enabled, 'on': False, 'url': '', 'qr': '', 'local': local}
    try:
        url = 'http://%s:%d/' % (lan_ip(), PORT)
    except Exception:
        return {'enabled': enabled, 'on': False, 'url': '', 'qr': '', 'local': local,
                'error': '没找到本机内网地址'}
    if LAN.get('url') == url and LAN.get('qr'):
        return dict(LAN, enabled=enabled, local=local)
    qr = ''
    try:
        import qrcode, qrcode.image.svg
        img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, border=2)
        qr = img.to_string().decode('utf-8')
    except Exception:
        pass
    LAN.update({'on': True, 'url': url, 'qr': qr})
    return dict(LAN, enabled=enabled, local=local)


def _bind(host, port):
    """在 host:port 上开一个新的监听实例（端口被占就抛 OSError）。"""
    socketserver.TCPServer.allow_reuse_address = True
    return socketserver.ThreadingTCPServer((host, port), Handler)


def apply_lan_binding(want):
    """把监听地址就地切到 want 要的那一边，不重启进程。

    返回 {'ok': bool, 'bound': 实际监听地址, 'error': 失败原因}。
    Windows 和 Linux 都不允许同一个端口同时绑在回环和通配上，所以顺序只能是
    「先关旧的、再绑新的」；新地址绑不上就把旧地址恢复回来——宁可维持原状，
    也不能让服务停在半路（设置面板自己也在这个端口上）。
    已经在这个地址上就直接返回，不白关一次。
    """
    global HTTPD, LAN_BOUND
    if LISTEN_LOCAL and want:
        return {'ok': False, 'bound': '127.0.0.1',
                'error': '服务是用 --local 启动的，不会监听局域网'}
    target = '0.0.0.0' if want else '127.0.0.1'
    if HTTPD is None:
        return {'ok': False, 'bound': '', 'error': '服务还没开始监听'}
    cur = HTTPD.server_address[0]
    if cur == target:
        LAN_BOUND = bool(want)
        return {'ok': True, 'bound': cur}
    try:
        HTTPD.shutdown()        # 停 serve_forever 循环，正在处理的请求会走完
        HTTPD.server_close()    # shutdown 不关套接字，这一步才真的让出端口
    except Exception:
        pass
    try:
        HTTPD = _bind(target, PORT)
    except OSError as e:
        try:
            HTTPD = _bind(cur, PORT)   # 回滚：这次换不了，至少保住原来那个
        except OSError:
            HTTPD = None
            LAN_BOUND = False
            return {'ok': False, 'bound': '', 'error': '端口 %d 重新监听失败：%s' % (PORT, e)}
        threading.Thread(target=HTTPD.serve_forever, kwargs={'poll_interval': .2},
                         daemon=True).start()
        LAN_BOUND = (cur == '0.0.0.0')
        return {'ok': False, 'bound': cur, 'error': str(e)}
    threading.Thread(target=HTTPD.serve_forever, kwargs={'poll_interval': .2},
                     daemon=True).start()
    LAN_BOUND = bool(want)
    return {'ok': True, 'bound': target}


def _full_address(item):
    addr = (item.get('address') or '').strip()
    if not addr or addr in ('无', '-', '/'):
        return ''
    # 「暂停开放 / 待定」这类不是地址，但高德照样会给一个结果——兜底解析到市中心，
    # 于是网点被放到市政府那个点上（差 30km 以上）。有坐标的错点比没坐标更坑，宁可不给
    if re.search(r'(暂停|暂不开放|待定|暂未开放)', addr):
        return ''
    if not addr.startswith('上海'):
        addr = '上海市' + addr
    for ch in ('（', '('):
        if ch in addr:
            addr = addr.split(ch)[0]
    return addr.strip()


def backfill_thread(cfg):
    global BACKFILL
    items = load_json(VENUES_PATH, [])
    todo = [x for x in items if _full_address(x) and x.get('lat') is None]
    BACKFILL.update({'running': True, 'done': 0, 'total': len(todo),
                     'ok': 0, 'fail': 0, 'current': '', 'error': ''})
    try:
        for i, it in enumerate(todo, 1):
            BACKFILL['current'] = it.get('display') or it.get('name') or ''
            lat, lng, _msg, _code = geocode_address(_full_address(it), cfg)
            if lat is not None:
                it['lat'], it['lng'] = lat, lng
                BACKFILL['ok'] += 1
            else:
                BACKFILL['fail'] += 1
            BACKFILL['done'] = i
            if i % 20 == 0:
                atomic_write_json(VENUES_PATH, items)
            time.sleep(0.2)
        atomic_write_json(VENUES_PATH, items)
    except Exception as e:
        BACKFILL['error'] = str(e)
    finally:
        BACKFILL['running'] = False
        BACKFILL['current'] = ''


# ---------------------------------------------------------------- HTTP 处理

class Handler(SimpleHTTPRequestHandler):
    server_version = 'ShlibFinder/' + VERSION

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    # ---- 路由
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if self.path.startswith('/vufind/'):
            return self.proxy()
        if path == '/api/config':
            return self.api_config()
        if path == '/api/lan-qr':
            return self.json(build_lan_info())
        if path == '/api/venues':
            return self.api_venues()
        if path == '/api/doulist':
            return self.api_doulist()
        if path == '/api/update-check':
            return self.json(update_peek())
        if path == '/api/editions':
            return self.api_editions()
        if path == '/api/cover':
            return self.api_cover()
        if path == '/api/geocode':
            return self.api_geocode()
        if path == '/api/cycling':
            return self.api_cycling()
        if path == '/api/venues/geocode':
            return self.json(dict(BACKFILL))
        return super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if self.path.startswith('/vufind/'):
            return self.proxy(post=True)
        if path == '/api/config':
            return self.api_save_config()
        if path == '/api/update-check':
            if not self.write_ok():
                return self.deny_write()
            return self.json(update_check())
        if path == '/api/restart':
            return self.api_restart()
        if path == '/api/venues/geocode':
            return self.api_start_backfill()
        # 只有前端比服务端新（没重启）才会走到这里，所以直接给出路，不说「未知接口」
        return self.json({'error': '本地服务还不认这个操作，在设置里点「重启服务」后再试'}, 404)

    # ---- 工具
    def json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def body(self, json_only=False):
        """读取请求体。json_only=True 时只接受 JSON，解析失败返回 None；
        False 时 fallback 到表单解析（兼容旧客户端）。"""
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return None
        if n < 0 or n > MAX_BODY:
            return None
        raw = self.rfile.read(n) if n else b''
        if not raw:
            return {}
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            if json_only:
                return None
            return dict(urllib.parse.parse_qsl(raw.decode('utf-8', 'ignore')))

    def query(self):
        return dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))

    def end_headers(self):
        # 开发期别缓存，改完代码刷新就能看到
        if self.path.split('?')[0].endswith(('.html', '.js', '.css', '.json')):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    # ---- 接口实现
    def is_loopback_req(self):
        """这个请求是不是**真实**从本机回环地址发来的。

        只认 client_address，不看 Host：Host 是请求方可控的，用它判断等于把
        「是不是本机」交给对方自己声明。以前这里看 Host，局域网里伪造一个
        Host: 127.0.0.1 就能读到明文地图 Key。
        """
        peer = (self.client_address[0] if self.client_address else '') or ''
        return peer in ('127.0.0.1', '::1', '::ffff:127.0.0.1') or peer.startswith('127.')

    def write_ok(self):
        """写操作（改配置 / 重启 / 补坐标）的门槛：真实回环 + 自定义头 + 同源。

        自定义头 X-Shlib-Write 是防 CSRF 的关键：跨站表单带不上自定义头，
        跨站 fetch 带它要先过 CORS 预检，而服务端不给预检响应。
        Origin/Sec-Fetch-Site 再补一道同源检查；localhost 用别的端口开的页面也进不来。
        """
        if not self.is_loopback_req():
            return False
        if (self.headers.get('X-Shlib-Write') or '').strip() != '1':
            return False
        site = (self.headers.get('Sec-Fetch-Site') or '').strip()
        if site and site not in ('same-origin', 'none'):
            return False
        origin = (self.headers.get('Origin') or '').strip()
        if origin:
            try:
                pu = urllib.parse.urlparse(origin)
            except ValueError:
                return False
            if pu.netloc != (self.headers.get('Host') or '').strip():
                return False
        return True

    def deny_write(self):
        if not self.is_loopback_req():
            msg = '从其他设备打开时这里是只读的：改设置请回到运行服务的那台电脑'
        else:
            # 走到这里说明 Origin / Sec-Fetch-Site 对不上，多半是页面挂了很久：
            # 「请求来源校验失败」是内部说法，用户能做的只有刷新
            msg = '这个页面的会话过期了，刷新后再试'
        return self.json({'error': msg}, 403)

    def api_config(self):
        cfg = load_config()
        venues = load_json(VENUES_PATH, [])
        key = (cfg.get('geocode') or {}).get('key', '')
        m = cfg.get('map') or {}
        mkey = (m.get('key') or '').strip()
        peer_local = self.is_loopback_req()
        vis = key_visible(peer_local)
        self.json({
            # 页面右下角那行小字用它：在另一台机器上跑时，一眼能看出装的是哪一版
            'version': VERSION,
            'build': BUILD,
            'bootId': BOOT_ID,
            # 设置面板里那个「GitHub 项目主页」直接用服务端给的地址
            'homepage': PROJECT_URL,
            # 书单地址属于个人数据：手机能读结果，但没必要把「你订阅了哪份豆列」也发过去
            # 想读地址里还带着豆瓣账号 ID，更要只留在本机
            'doulist_url': cfg.get('doulist_url', '') if peer_local else '',
            'wish_url': cfg.get('wish_url', '') if peer_local else '',
            # 手机打开时设置面板是只读的，前端据此禁用保存/测试，别再让人点出一个 403
            'readOnly': not peer_local,
            'geocode': {
                'provider': (cfg.get('geocode') or {}).get('provider', 'amap'),
                'hasKey': bool(key),
                # 后四位也算 Key 的一部分：局域网来源连它都不该看到
                'keyTail': ('***' + key[-4:]) if peer_local and len(key) >= 4 else '',
            },
            # JS API 的 Key 必须原样交给浏览器（页面自己拼 script 标签去加载地图），
            # 所以本机来源照常明文给。开了局域网访问后同网段任何人都能 GET /api/config，
            # 因此只在真实回环来源时给明文，对外只回「有没有配」。想让手机也能用地图，
            # 就加 --lan-key 启动。
            'map': {
                'hasKey': bool(mkey),
                'key': mkey if vis else '',
                'security': (m.get('security') or '').strip() if vis else '',
                'keyTail': ('***' + mkey[-4:]) if vis and len(mkey) >= 4 else '',
                'hiddenByLan': not vis,
            },
            'venues': {
                'total': len(venues),
                'withCoord': sum(1 for v in venues if v.get('lat') is not None),
                'withAddress': sum(1 for v in venues if _full_address(v)),
            },
            # 前端用它判断服务端是不是旧进程：老版本没有这个键，就没有骑行接口
            'features': {
                'cycling': bool(amap_key(cfg)),
                'editions': True,
            },
            # 开关的值和「本次进程实际有没有监听局域网」是两回事：拨完开关就地换监听地址
            # （见 apply_lan_binding），所以正常情况下这两个值一保存就一致；
            # 只有端口换不过去（或者服务是 --local 起的）时 enabled 才会是 true、active 是 false
            'lan': {
                'enabled': bool(cfg.get('lan')),
                'active': LAN_BOUND,
                'local': LISTEN_LOCAL,
            },
        })

    def api_restart(self):
        """设置里的「重启服务」：起一个新进程再退掉自己。

        只认真实的回环来源 + 同源写头（见 write_ok）——局域网里的手机点不到这里，
        外部网页也没法用表单触发重启。新进程带 --no-open，免得每次重启都再弹一个浏览器标签页。
        """
        if not self.write_ok():
            return self.deny_write()
        script = os.path.abspath(sys.argv[0] or '')
        if not script.lower().endswith('.py'):
            return self.json({'error': '当前进程不是用脚本启动的，无法自动重启'}, 400)
        # sys.argv 里已经带着上一次重启传下来的 --no-open，先滤掉再加，
        # 否则每重启一次就多攒一个（日志里见过连着六个）
        rest = [a for a in sys.argv[1:] if a != '--no-open']
        cmd = [sys.executable, script] + rest + ['--no-open']
        self.json({'ok': True, 'bootId': BOOT_ID})
        threading.Thread(target=self._relaunch, args=(cmd,), daemon=True).start()

    @staticmethod
    def _relaunch(cmd):
        # 先把响应写完，再起新进程。监听套接字默认不可继承（PEP 446），
        # 旧进程退出后端口自然释放；main() 里再补一段绑定重试兜住慢释放。
        time.sleep(.6)
        try:
            log = open(os.path.join(DATA_DIR, 'server.log'), 'a', encoding='utf-8', buffering=1)
            log.write('\n[%s] 网页按钮触发重启：%s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), ' '.join(cmd)))
        except OSError:
            log = subprocess.DEVNULL
        kw = dict(cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True)
        if os.name == 'nt':
            kw['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        else:
            kw['start_new_session'] = True
        try:
            subprocess.Popen(cmd, **kw)
        finally:
            try:
                if log is not subprocess.DEVNULL:
                    log.close()
            except OSError:
                pass
        os._exit(0)

    def api_save_config(self):
        if not self.write_ok():
            return self.deny_write()
        body = self.body(json_only=True)
        if body is None:
            return self.json({'error': '请求体必须是有效的 JSON'}, 400)
        if not isinstance(body, dict):
            return self.json({'error': '配置格式不对：必须是 JSON 对象'}, 400)

        cfg = load_config()

        def take_str(src, key, limit=512):
            v = src.get(key)
            if v is None:
                return None
            if not isinstance(v, str):
                raise ValueError('%s 必须是字符串' % key)
            return v.strip()[:limit]

        try:
            if 'doulist_url' in body:
                v = take_str(body, 'doulist_url', 2048)
                cfg['doulist_url'] = v or ''
            if 'wish_url' in body:
                v = take_str(body, 'wish_url', 2048)
                # 地址当场校验：影视「想看」页和乱填的地址在这里就挡下来，
                # 别等刷新书架时才报错
                cfg['wish_url'] = wish_url_of(v) if v else ''
            if 'lan' in body:
                if not isinstance(body['lan'], bool):
                    raise ValueError('lan 必须是布尔值')
                cfg['lan'] = body['lan']
            for section, keys in (('geocode', ('provider', 'key')),
                                  ('map', ('key', 'security'))):
                if section not in body:
                    continue
                part = body[section]
                if not isinstance(part, dict):
                    raise ValueError('%s 必须是对象' % section)
                cur = cfg.setdefault(section, {})
                for k in keys:
                    v = take_str(part, k)
                    if v is not None:
                        cur[k] = v
                if section == 'geocode' and cur.get('provider') not in ('amap', 'qq'):
                    raise ValueError('Web 服务只能是 amap 或 qq')
        except ValueError as e:
            return self.json({'error': str(e)}, 400)
        save_config(cfg)
        # 开关一动手就当场换监听地址（以前要重启，可重启会把手机上正开着的页面断掉）。
        # 换不换得成不看这里的返回值：前端保存后会重新读 /api/config，那里的
        # enabled / active 两个值才是实情，失败时状态行自己会说
        if 'lan' in body and bool(body['lan']) != LAN_BOUND:
            apply_lan_binding(bool(body['lan']))
        self.json({'ok': True})

    def api_venues(self):
        venues = load_json(VENUES_PATH, [])
        self.json({'venues': [{
            'n': (v.get('name') or '').strip(),
            'd': (v.get('display') or v.get('name') or '').strip(),
            'a': (v.get('address') or '').strip(),
            't': (v.get('tel') or '').strip(),
            'z': (v.get('district') or '').strip(),
            'h': (v.get('hours') or '').strip(),
            'lat': v.get('lat'),
            'lng': v.get('lng'),
        } for v in venues if (v.get('name') or '').strip()]})

    def api_cover(self):
        """代理豆瓣封面图，只在内存里留一份。

        豆瓣图片的防盗链按 Referer 判：无 Referer → 418 占位图，localhost → 403，
        只有 douban.com 才放行。浏览器里没法伪造 Referer，所以这一层代取。
        这个是**回落通道**：上图有封面时前端根本不会走到这里，所以它不是常用资源，
        写进 data/covers 只是把一次性代取的图长期摊在磁盘上。进程内存里存着够本进程反复用，
        重启后哪张还需要就再取一次（一张图几十 KB、一次请求）。
        """
        u = self.query().get('u', '').strip()
        if not u:
            return self.json({'error': '缺少 u 参数'}, 400)
        pu = urllib.parse.urlparse(u)
        host = (pu.hostname or '').lower()
        if pu.scheme not in ('http', 'https') or not any(
                host == h or host.endswith('.' + h) for h in COVER_HOSTS):
            return self.json({'error': '只代理豆瓣的图片地址'}, 403)

        # 内存缓存：键就是图地址本身（豆瓣同一张图地址稳定），值 (字节, Content-Type)
        hit = COVER_MEM.get(u)
        if hit:
            return self.send_image(hit[0], hit[1])

        try:
            req = urllib.request.Request(u, headers={
                'User-Agent': UA,
                'Referer': 'https://www.douban.com/',
                'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
            })
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read()
                ctype = r.headers.get('Content-Type', '')
        except Exception as e:
            return self.json({'error': '取图失败：%s' % e}, 502)

        if len(data) < COVER_MIN_BYTES:
            return self.json({'error': '豆瓣没给真图（可能已下架）'}, 404)
        if ctype and not ctype.startswith('image/'):
            return self.json({'error': '返回的不是图片'}, 502)

        # 满了先丢最早放进去的：书单翻来覆去就那几十本，8MB 够放一百多张
        # 注意：这里要给模块级变量重新赋值，必须 global，否则 Python 把
        # COVER_MEM_BYTES 当成局部变量，读到第 738 行就 UnboundLocalError
        # ——每取一张封面就抛一次，线程里堆栈一路冒到 socketserver。
        global COVER_MEM_BYTES
        if COVER_MEM_BYTES + len(data) > COVER_MEM_MAX and COVER_MEM:
            COVER_MEM.clear()
            COVER_MEM_BYTES = 0
        COVER_MEM[u] = (data, ctype)
        COVER_MEM_BYTES += len(data)
        self.send_image(data, ctype, cache=True)

    def send_image(self, data, ctype=None, cache=True):
        if not ctype:
            ctype = 'image/jpeg'
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        # 回落图不进磁盘，但可以让浏览器自己留一天：同一张图别每次都绕一圈服务端
        self.send_header('Cache-Control', 'public, max-age=86400' if cache else 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def api_doulist(self):
        q = self.query()
        cfg = load_config()
        kind = 'wish' if q.get('source') == 'wish' else 'doulist'
        if kind == 'wish':
            url = q.get('url') or cfg.get('wish_url') or ''
        else:
            url = q.get('url') or cfg.get('doulist_url') or ''
        # 没配列表是正常初始状态（新装的包就是空的），不是一个错误
        if not url.strip():
            return self.json({'url': '', 'kind': kind, 'name': '', 'fetchedAt': '',
                              'books': [], 'empty': True, 'complete': True})
        try:
            data = load_doulist(url, kind=kind,
                                refresh=q.get('refresh') in ('1', 'true'),
                                more=q.get('more') in ('1', 'true'))
        except DoubanBlocked as e:
            return self.json({'error': str(e), 'blockedFor': e.retry_after}, 502)
        except ValueError as e:
            return self.json({'error': str(e)}, 400)
        except Exception as e:
            return self.json({'error': '%s失败：%s' % ('抓想读' if kind == 'wish' else '抓书单', e)}, 502)
        # 封面 id 在后台补：以前在这里同步逐本查上图，书一多就拖住整个响应
        ensure_shl_worker(data['url'])
        self.json({
            'url': data['url'],
            'kind': kind,
            'name': data.get('name', ''),
            'fetchedAt': time.strftime('%Y-%m-%d %H:%M', time.localtime(data.get('at', time.time()))),
            'books': data['books'],
            'complete': data.get('complete', True),
            'truncated': bool(data.get('truncated')),
            'blockedFor': int(data.get('blockedFor') or 0),
        })

    def api_editions(self):
        """查上图书目里这本书有哪些版本（每条都带 ISBN，能直接拿去查馆藏）。

        q 可以是书名，也可以是 ISBN：ISBN 走精确检索，命中的那一条标 same，
        前端据此判断「唯一版本」；书名检索的结果里同名的排前面。
        """
        q = (self.query().get('q') or '').strip()
        if not q:
            return self.json({'error': '缺少 q 参数'}, 400)
        if len(q) > 120:
            return self.json({'error': '检索词太长'}, 400)
        by_isbn = bool(re.fullmatch(r'(97[89])?\d{9}[\dXx]', re.sub(r'[\s-]', '', q)))
        try:
            data = fetch_editions(q, by_isbn)
        except Exception as e:
            return self.json({'error': '查询上图版本失败：%s' % e}, 502)
        self.json(data)

    def api_geocode(self):
        q = self.query()
        cfg = load_config()
        lat, lng, msg, code = geocode_address(q.get('q', ''), cfg)
        if lat is None:
            return self.json({'error': msg or '没查到', 'code': code,
                              'needKey': code == 'needKey'}, 400)
        self.json({'lat': lat, 'lng': lng, 'label': q.get('q', '')})

    def api_cycling(self):
        q = self.query()
        o, d = q.get('from', '').strip(), q.get('to', '').strip()
        if not o or not d:
            return self.json({'error': '缺 from / to（格式 lng,lat）'}, 400)
        v, msg = bike_estimate(o, d, load_config())
        if v is None:
            return self.json({'error': msg}, 400)
        self.json(v)

    def api_start_backfill(self):
        """批量补网点坐标。

        POST 会写 data/libraries.json，所以和改配置一样只接受本机同源写请求。
        设置面板里的入口已经去掉了（427/479 早已补完，剩下 47 个本来就没有地址，
        补不了）。接口留着是因为换机器或重跑 data/libraries.json 后还得用它，
        用法：curl -X POST -H "X-Shlib-Write: 1" http://127.0.0.1:8765/api/venues/geocode
        """
        if not self.write_ok():
            return self.deny_write()
        if BACKFILL.get('running'):
            return self.json(dict(BACKFILL))
        cfg = load_config()
        if not (cfg.get('geocode') or {}).get('key'):
            return self.json({'error': '还没填地理编码 Key'}, 400)
        t = threading.Thread(target=backfill_thread, args=(cfg,), daemon=True)
        t.start()
        time.sleep(0.3)
        self.json(dict(BACKFILL))

    # ---- /vufind 转发
    def proxy(self, post=False):
        target = UPSTREAM + self.path[len('/vufind'):]
        body = None
        if post:
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                return self.json({'error': '请求体长度不合法'}, 400)
            if length < 0 or length > MAX_BODY:
                return self.json({'error': '请求体过大'}, 413)
            body = self.rfile.read(length) if length else b''

        # ---- 馆藏页面磁盘缓存
        # AjaxTab 返回的 HTML 结构（哪家馆有哪几册、索书号）一天之内不会变，
        # 变的只有每册的在架状态——但那个状态本来就在同一份 HTML 里，所以缓存到的就是
        # 抓取那一刻的实时状态。TTL 内命中省一次上图往返（1~3 秒）。
        # 带 ?refresh=1（前端「重新查询」）时**绕过读缓存但照样写**同一个文件，
        # 保证能拿到最新在架状态、下次进来读到的也是这份。
        # 缓存键必须去掉 query：refresh 那次如果连 ?refresh=1 一起算进 sha1，
        # 新数据会写进一个只有下次 refresh 才会用到的文件，等于永远刷不掉旧缓存。
        cache_target = UPSTREAM + self.path[len('/vufind'):].split('?')[0]
        cache_file = None
        is_ajax_tab = post and '/AjaxTab' in self.path
        if is_ajax_tab:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if (qs.get('refresh') or [''])[0] != '1':
                cache_file = self.holdings_cache_file(cache_target, body)
                hit = self.holdings_cache_read(cache_file)
                if hit is not None:
                    data, at = hit
                    return self.send_upstream(data, 200, 'text/html; charset=utf-8',
                                              data_at=at, source='cache')
            else:
                cache_file = self.holdings_cache_file(cache_target, body)

        headers = {
            'User-Agent': UA,
            'Accept': 'application/json,text/html,*/*',
            'Referer': UPSTREAM + '/',
            'X-Requested-With': 'XMLHttpRequest',
        }
        if post:
            headers['Content-Type'] = self.headers.get('Content-Type') or 'application/x-www-form-urlencoded'
        req = urllib.request.Request(target, data=body, headers=headers,
                                     method='POST' if post else 'GET')
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                ctype = resp.headers.get('Content-Type', 'application/json; charset=utf-8')
                code = resp.status
        except urllib.error.HTTPError as e:
            data = ('{"error":"upstream HTTP %d"}' % e.code).encode()
            ctype = 'application/json; charset=utf-8'
            code = 502
        except Exception as e:
            data = ('{"error":%s}' % ('"%s"' % str(e).replace('"', "'"))).encode('utf-8')
            ctype = 'application/json; charset=utf-8'
            code = 504

        # 只缓存成功且有内容的馆藏页：502/504 的空壳或错误 JSON 一旦落盘，
        # 接下来 12 小时都会拿着错误当结果
        data_at = None
        if cache_file and code == 200 and len(data) > 500 and b'class="branch"' in data:
            self.holdings_cache_write(cache_file, data)
            data_at = time.time()

        return self.send_upstream(data, code, ctype, data_at=data_at, source='upstream')

    def send_upstream(self, data, code, ctype, data_at=None, source=''):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        # 馆藏页带一份「这份数据是什么时候的」：前端拿它区分 12 小时缓存和刚抓的实时结果，
        # 否则缓存命中也会被显示成「刚刚抓取」。其他转发（搜索/版本列表）不带。
        if data_at:
            self.send_header('X-Data-At', str(int(data_at)))
            self.send_header('X-Data-Source', source or 'upstream')
        # 同源页面不需要 CORS；带 * 反而让任何网页都能读转发结果
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    # ---- 馆藏页磁盘缓存
    def holdings_cache_file(self, target, body):
        """缓存键 = 目标 URL + POST body 的 sha1，一个版本记录一个文件"""
        h = hashlib.sha1((target + '|' + (body or b'').decode('latin-1')).encode('utf-8'))
        return os.path.join(HOLDINGS_DIR, h.hexdigest()[:24] + '.html')

    def holdings_cache_read(self, path):
        """命中返回 (HTML 字节, 抓取时间)；过期或不存在返回 None。"""
        try:
            at = os.path.getmtime(path)
            if time.time() - at > HOLDINGS_TTL:
                return None
            with open(path, 'rb') as f:
                return f.read(), at
        except OSError:
            return None

    def holdings_cache_write(self, path, data):
        try:
            os.makedirs(HOLDINGS_DIR, exist_ok=True)
            # tmp 名带 pid + 线程号：前端并发是 5 路（app.js 的 CONC），
            # 两条线程写同一个缓存文件时如果共用一个固定 .tmp，会交错写进去，
            # replace 出一份混了两份响应的 HTML，之后 12 小时一直返回它
            tmp = '%s.%d.%d.tmp' % (path, os.getpid(), threading.get_ident())
            with open(tmp, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
            global HOLDINGS_WRITES
            HOLDINGS_WRITES += 1
            if HOLDINGS_WRITES % 50 == 0:
                holdings_cache_sweep()
        except OSError as e:
            sys.stderr.write('馆藏缓存写入失败：%s\n' % e)

    def log_message(self, fmt, *args):
        # 只报 4xx/5xx，静态请求别刷屏
        for a in args:
            s = str(a)
            if len(s) == 3 and s[0] in '45':
                sys.stderr.write('[%s] %s\n' % (self.log_date_time_string(), fmt % args))
                return


def main():
    # PWA 资源的 MIME：SimpleHTTPRequestHandler 靠系统注册表猜类型，
    # .webmanifest 在 Windows 上常被猜成 octet-stream，浏览器会拒收 manifest
    import mimetypes
    mimetypes.add_type('application/manifest+json', '.webmanifest')
    mimetypes.add_type('application/json', '.json')

    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    # 默认只监听本机；「从其他设备访问」由设置里的开关决定（写在 config.json，拨了就地生效）。
    # --local 是强制本机的逃生口：网络环境可疑、或想确认「不是局域网模式」时用。
    ap.add_argument('--local', action='store_true',
                    help='强制只监听 127.0.0.1（忽略设置里的「从其他设备访问」开关）')
    ap.add_argument('--no-open', action='store_true', help='不要自动打开浏览器')
    ap.add_argument('--lan-key', action='store_true',
                    help='局域网模式下也把地图 Key 明文发给浏览器（手机上要用地图就得开，' +
                         '代价是同 WiFi 的任何人发个请求就能读走它；完全信任网络再用）')
    args = ap.parse_args()

    global LISTEN_LOCAL, EXPOSE_KEY_ON_LAN, PORT, LAN_BOUND, HTTPD
    LISTEN_LOCAL = bool(args.local)
    EXPOSE_KEY_ON_LAN = bool(args.lan_key)
    PORT = args.port
    # 启动时清一次过期缓存：平时只写不删，目录会一直涨
    holdings_cache_sweep()
    cfg = load_config()
    lan = bool(cfg.get('lan')) and not args.local
    host = '0.0.0.0' if lan else '127.0.0.1'
    # 「重启服务」起新进程时，旧进程的端口可能还差几十毫秒才释放——重试一小会儿，
    # 别让按钮点完直接死在 EADDRINUSE 上
    for attempt in range(30):
        try:
            HTTPD = _bind(host, args.port)
            break
        except OSError as e:
            if attempt == 29:
                # 重试 3 秒仍失败：端口可能被别的进程占用，给出明确提示
                print('错误：端口 %d 被占用，无法启动。' % args.port)
                print('可能原因：1) 已有另一个服务进程在运行；2) 其他程序占用了此端口。')
                print('解决方法：关闭占用端口的进程，或用 --port 参数指定其他端口。')
                raise SystemExit(1)
            time.sleep(.1)

    url = 'http://127.0.0.1:%d/' % args.port
    # 版本号不在这里打印：页面只认设置面板底部那一处，免得两处显示不一致
    print('上图馆藏查询已启动：%s' % url)
    print('监听 %s：%s' % (host, '其他设备可访问（只读，同一网络里都能打开）' if lan else '仅本机'))
    LAN_BOUND = lan
    if lan:
        print('从其他设备打开是只读的：能查书、看结果，改设置和重启要回到这台电脑上。')
    if lan and not EXPOSE_KEY_ON_LAN:
        print('地图 Key：只发给从 127.0.0.1 打开的请求（本机浏览器照常有地图）；' +
              '从局域网 IP 打开的不给，所以手机上的地图背景不会加载。')
        print('          想让手机也有地图：加 --lan-key 启动（Key 会明文发给同网段的任何人）。')
    # 顺手把内网地址贴出来：每次查 IP 都得开一个终端敲 ipconfig，太麻烦
    try:
        print('本机内网地址：%s' % lan_ip())
    except Exception:
        pass
    if not (cfg.get('geocode') or {}).get('key'):
        print('提示：还没配地理编码 Key，距离排序会退化为按可借数排。见 README 第四节。')
    if lan:
        try:
            print('其他设备（连同一个 WiFi）可访问：http://%s:%d/' % (lan_ip(), args.port))
            print('注意：局域网 http 下浏览器不给定位权限，需要手输地址。')
        except Exception:
            pass
    print('Ctrl+C 停止。')
    if not args.no_open:
        webbrowser.open(url)
    # serve_forever 放到后台线程：主线程只负责活着，这样设置里拨「从其他设备访问」时
    # 才能把监听实例整个换掉（见 apply_lan_binding），而不是叫用户重启
    threading.Thread(target=HTTPD.serve_forever, kwargs={'poll_interval': .2},
                     daemon=True).start()
    try:
        while not STOP.wait(.5):
            pass
    except KeyboardInterrupt:
        print('\n已停止')
    try:
        HTTPD.shutdown()
    except Exception:
        pass


if __name__ == '__main__':
    main()
