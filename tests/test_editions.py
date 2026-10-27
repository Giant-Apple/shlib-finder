"""上图版本检索与 RIS 解析的离线单测：只喂手写的小段数据，不联网。

「按书名 → 列版本 → 用 ISBN 查馆藏」是整条链路的入口：
上图的检索/导出格式一改，用户看到的就是「没有这一版」或错版封面。
这里把这些约定钉住，接口变动先在这里红。
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.parse
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web'))
import server  # noqa: E402


RIS = '''TY  - BOOK
TI  - 中文计算机
AU  - [美] 墨磊宁
AU  - 张朋亮
PB  - 广西师范大学出版社
PY  - 2024.
ET  - 第1版
SN  - 978-7-5598-8794-8
SN  - 9787559887949
ER  -
'''

SEARCH = json.dumps({'records': [
    {'id': '1'},
    {'id': '2'},
    {'id': '3'},
    {'id': '4'},
    {'id': '5'},
]})

RIS_BY_ID = {
    '1': '''TY  - BOOK
TI  - 计算机绘图 中文版AutoCAD 2010
PB  - 机械工业出版社
PY  - 2010
SN  - 9787111334567
ER  -
''',
    '2': '''TY  - BOOK
TI  - 中文计算机
AU  - 墨磊宁
PB  - 广西师范大学出版社
PY  - 2024.
SN  - 978-7-5598-8794-8
ER  -
''',
    '3': '''TY  - BOOK
TI  - 中文计算机 打字机的故事
PB  - 商务印书馆
PY  - 2025
SN  - 9787521712345
ER  -
''',
    '4': '''TY  - BOOK
TI  - 中文计算机（精装）
PB  - 广西师范大学出版社
PY  - 2024
SN  - 9787559887948
ER  -
''',
    '5': '''TY  - BOOK
TI  - 中文计算机 无 ISBN 的旧记录
PB  - 某出版社
PY  - 1999
ER  -
''',
}


class FakeUpstream(object):
    """按 URL 分流的假 http_get：记下请求次数，便于验证磁盘缓存是否生效。"""

    def __init__(self):
        self.calls = []
        self.last_query = {}

    def __call__(self, url, timeout=30, headers=None, data=None):
        self.calls.append(url)
        if '/api/v1/search' in url:
            self.last_query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            return SEARCH
        if '/Export?style=RIS' in url:
            rid = url.split('/Record/')[1].split('/')[0]
            return RIS_BY_ID.get(urllib.parse.unquote(rid), '')
        raise AssertionError('unexpected url: %s' % url)


class RisTest(unittest.TestCase):
    def test_fields(self):
        p = server.parse_ris(RIS)
        self.assertEqual(p['title'], '中文计算机')
        self.assertEqual(p['author'], ['[美] 墨磊宁', '张朋亮'])
        self.assertEqual(p['publisher'], '广西师范大学出版社')
        self.assertEqual(p['year'], '2024')
        self.assertEqual(p['edition'], '第1版')
        self.assertEqual(p['isbn'], ['978-7-5598-8794-8', '9787559887949'])

    def test_first_wins_and_blank(self):
        p = server.parse_ris('TI  - 甲\nTI  - 乙\nPB  - \nPY  - 20\nER  -\n')
        self.assertEqual(p['title'], '甲')
        self.assertEqual(p['publisher'], '')
        self.assertEqual(p['year'], '')        # 「20」不是四位年份，丢掉
        self.assertEqual(server.parse_ris('')['author'], [])

    def test_bad_lines_ignored(self):
        p = server.parse_ris('this is not ris\nSN -x\n')
        self.assertEqual(p['title'], '')
        self.assertEqual(p['isbn'], [])


class NormalizeTest(unittest.TestCase):
    def test_isbn(self):
        self.assertEqual(server.normalize_isbn('978-7-5598-8794-8'), '9787559887948')
        self.assertEqual(server.normalize_isbn(' 0306406152 '), '0306406152')
        self.assertEqual(server.normalize_isbn('123'), '')
        self.assertEqual(server.normalize_isbn(None), '')

    def test_parse_isbn(self):
        html = '<span class="pl">ISBN:</span> 978-7-5598-8794-8'
        self.assertEqual(server.parse_isbn(html), '9787559887948')
        self.assertEqual(server.parse_isbn('<meta property="book:isbn" content="9787559887948" />'),
                         '9787559887948')
        self.assertEqual(server.parse_isbn('<html></html>'), '')

    def test_title_same(self):
        self.assertTrue(server.title_same('中文计算机', '中文计算机'))
        self.assertTrue(server.title_same('置身事内', '置身事内 中国政府与经济发展'))
        self.assertTrue(server.title_same('置身事内：中国政府与经济发展', '置身事内'))
        self.assertFalse(server.title_same('置身事内', '魏玛文化 置身事内的局外人'))
        self.assertFalse(server.title_same('', '中文计算机'))


class FetchEditionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.upstream = FakeUpstream()
        for target, value in (
            ('EDITIONS_CACHE', os.path.join(self.tmp, 'cache.json')),
            ('http_get', self.upstream),
        ):
            p = mock.patch.object(server, target, value)
            p.start()
            self.addCleanup(p.stop)

    def test_same_title_first_and_deduped(self):
        d = server.fetch_editions('中文计算机')
        isbns = [e['isbn'] for e in d['editions']]
        # 同名的排前面；重复 ISBN（9787559887948）只留一条；没有 ISBN 的记录丢掉
        self.assertEqual(isbns, ['9787559887948', '9787521712345', '9787111334567'])
        self.assertEqual([e['same'] for e in d['editions']], [True, True, False])
        self.assertEqual(d['total'], 3)
        self.assertEqual(d['records'], 5)
        self.assertFalse(d['byIsbn'])

        first = d['editions'][0]
        self.assertEqual(first['title'], '中文计算机')
        self.assertEqual(first['author'], '墨磊宁')
        self.assertEqual(first['publisher'], '广西师范大学出版社')
        self.assertEqual(first['year'], '2024')
        self.assertEqual(first['recId'], '2')

    def test_query_params(self):
        server.fetch_editions('  中文计算机  ')
        self.assertEqual(self.upstream.last_query['lookfor'], ['中文计算机'])
        self.assertEqual(self.upstream.last_query['type'], ['Title'])
        self.assertEqual(self.upstream.last_query['page'], ['1'])

    def test_by_isbn_all_same(self):
        d = server.fetch_editions('9787559887948', by_isbn=True)
        self.assertTrue(d['byIsbn'])
        self.assertTrue(all(e['same'] for e in d['editions']))

    def test_second_call_is_cached(self):
        server.fetch_editions('中文计算机')
        n = len(self.upstream.calls)
        server.fetch_editions('中文计算机')
        self.assertEqual(len(self.upstream.calls), n)   # 查询和记录都走磁盘缓存

    def test_empty_term(self):
        d = server.fetch_editions('   ')
        self.assertEqual(d['editions'], [])
        self.assertEqual(self.upstream.calls, [])

    def test_no_records(self):
        with mock.patch.object(server, 'http_get', return_value=json.dumps({'records': []})):
            d = server.fetch_editions('没有这本书的书名')
        self.assertEqual(d['editions'], [])
        self.assertEqual(d['records'], 0)


DOULIST_ITEM = '''
<div id="123" class="doulist-item">
  <div class="post">
    <a href="https://book.douban.com/subject/37534736/" target="_blank">
      <img src="https://img3.doubanio.com/view/subject/m/public/s1.jpg">
    </a>
  </div>
  <div class="title">
    <a href="https://book.douban.com/subject/37534736/" target="_blank">中文计算机</a>
  </div>
  <div class="rating"><span class="rating_nums">8.4</span></div>
  <div class="abstract">
    作者: [美] 墨磊宁<br>
    出版社: 广西师范大学出版社<br>
    出版年: 2024-9<br>
    页数: 456<br>
    定价: 98.00元<br>
    装帧: 平装
  </div>
</div>
'''


class DoulistTest(unittest.TestCase):
    def test_item(self):
        books = server.parse_doulist_page(DOULIST_ITEM)
        self.assertEqual(len(books), 1)
        b = books[0]
        self.assertEqual(b['id'], '37534736')
        self.assertEqual(b['title'], '中文计算机')
        self.assertEqual(b['rating'], '8.4')
        self.assertEqual(b['author'], '[美] 墨磊宁')
        self.assertEqual(b['publisher'], '广西师范大学出版社')
        # 豆瓣写的是「2024-9」这种年-月：只留 4 位年份，它紧跟出版社，
        # 留着「-9」会被读成具体出版日期（2026-10-26 用户定）
        self.assertEqual(b['year'], '2024')
        self.assertTrue(b['cover'].startswith('https://img3.doubanio.com/'))

    def test_empty(self):
        self.assertEqual(server.parse_doulist_page('<html></html>'), [])


class GeocodeShanghaiTest(unittest.TestCase):
    """位置只认上海境内：以前给所有输入硬加「上海市」前缀 + city=上海，
    高德匹配不到就退成整城记录（坐标正是市中心），于是「南京南站」被悄悄
    定位到人民广场，页面还报「位置已设为：南京南站」。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.calls = []
        p_cache = mock.patch.object(server, 'GEOCODE_CACHE', os.path.join(self.tmp, 'geo.json'))
        p_get = mock.patch.object(server, 'http_get', self.upstream)
        p_cache.start()
        p_get.start()
        self.addCleanup(p_cache.stop)
        self.addCleanup(p_get.stop)
        self.cfg = {'geocode': {'provider': 'amap', 'key': 'k'}}
        # 高德全国检索对裸地名会给别的城市的同名地点（实测「人民广场」→ 四川眉山）
        self.nationwide_far = False
        # 上海前缀那一发查不到（模拟上游配额抖动：同一地址连着两次结果不一样）
        self.shanghai_blind = False

    def _geo(self, location, province, city, adcode, level):
        return json.dumps({'status': '1', 'geocodes': [{
            'location': location, 'province': province, 'city': city,
            'adcode': adcode, 'level': level}]})

    def upstream(self, url, timeout=30, headers=None, data=None):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        addr = q['address'][0]
        self.calls.append(addr)
        # 第一发按原样全国检索：别的城市老实给出别的城市
        if addr == '南京南站':
            return self._geo('118.796786,31.970968', '江苏省', '南京市', '320114', '公交地铁站点')
        if addr == '淮海中路1555号':
            return self._geo('121.444753,31.207334', '上海市', '上海市', '310104', '门址')
        if addr == '人民广场':
            if self.nationwide_far:
                return self._geo('103.810821,30.035285', '四川省', '眉山市', '511402', '广场')
            return json.dumps({'status': '0', 'infocode': '700'}, ensure_ascii=False)
        # 第二发拼上「上海市」前缀（实测高德 v3 的 city 参数对裸地名不生效，只有前缀管用）
        if addr == '上海市南京南站':
            # 上一版就是这么把「南京南站」变成人民广场的：整城记录、level 只到「省」
            return self._geo('121.473667,31.230525', '上海市', '上海市', '310000', '省')
        if addr == '上海市人民广场':
            if self.shanghai_blind:
                return json.dumps({'status': '0', 'infocode': '700'}, ensure_ascii=False)
            return self._geo('121.477401,31.240093', '上海市', '上海市', '310101', '道路')
        return json.dumps({'status': '0', 'infocode': '700'}, ensure_ascii=False)

    def test_other_city_is_rejected_not_silently_centered(self):
        lat, lng, msg, code = server.geocode_address('南京南站', self.cfg)
        self.assertIsNone(lat)
        self.assertEqual(code, 'outOfShanghai')
        self.assertIn('南京市', msg)
        # 前缀那一发只会退回整城记录，被层级校验挡掉，不会当成命中
        self.assertEqual(self.calls, ['南京南站', '上海市南京南站'])

    def test_bare_shanghai_place_still_resolves(self):
        lat, lng, msg, code = server.geocode_address('人民广场', self.cfg)
        self.assertEqual((round(lat, 4), round(lng, 4)), (31.2401, 121.4774))
        self.assertEqual(code, '')
        self.assertEqual(self.calls, ['人民广场', '上海市人民广场'])

    def test_bare_name_matching_another_city_falls_back_to_shanghai(self):
        # 实测：裸输「人民广场」，高德全国检索给的是四川眉山那个（31.2401 才是上海）。
        # 直接照此拒掉就错了——这应用只算上海，用户指的就是上海的广场，
        # 所以撞上外地同名点要再试一次上海前缀，试得到就用上海的
        self.nationwide_far = True
        lat, lng, msg, code = server.geocode_address('人民广场', self.cfg)
        self.assertEqual(code, '')
        self.assertEqual((round(lat, 4), round(lng, 4)), (31.2401, 121.4774))
        self.assertEqual(self.calls, ['人民广场', '上海市人民广场'])

    def test_upstream_hiccup_is_not_reported_as_wrong_city(self):
        # 全国那发撞上外地同名点、上海前缀这发只是高德没答上（配额抖动实测存在）：
        # 这时候说「在昆明市，不在上海」是把上游的锅扣在用户输入上
        self.nationwide_far = True
        self.shanghai_blind = True
        lat, lng, msg, code = server.geocode_address('人民广场', self.cfg)
        self.assertIsNone(lat)
        self.assertEqual(code, '')
        self.assertIn('在上海没查到', msg)
        self.assertNotIn('不在上海', msg)

    def test_shanghai_place_needs_only_one_query(self):
        lat, _lng, _msg, code = server.geocode_address('淮海中路1555号', self.cfg)
        self.assertEqual(self.calls, ['淮海中路1555号'])
        self.assertEqual(code, '')
        self.assertTrue(lat)

    def test_city_center_fallback_is_not_accepted_as_a_match(self):
        # 只到「省」这一层的整城结果，只有用户本来就输了个行政区名时才算命中
        self.assertFalse(server.in_shanghai(31.2305, 121.4736, '320114'))
        self.assertTrue(server.in_shanghai(31.2305, 121.4736, '310000'))
        self.assertTrue(server._is_area_name('上海市', '上海市'))
        self.assertFalse(server._is_area_name('上海市南京南站', '上海市'))

    def test_second_query_for_same_address_hits_cache(self):
        server.geocode_address('人民广场', self.cfg)   # 全国那次没命中 + 上海前缀命中
        n = len(self.calls)
        lat, _lng, _msg, code = server.geocode_address('人民广场', self.cfg)
        self.assertEqual(code, '')
        self.assertTrue(lat)
        # 命中的那发进缓存了、不再打；失败的全国检索不缓存（否则一次网络抖动会
        # 让这个地址永远查不出来），所以第二次只多一次全国探测
        self.assertEqual(self.calls[n:], ['人民广场'])


class DoubanGuardTest(unittest.TestCase):
    def test_anti_bot_page_detected(self):
        with mock.patch.object(server, 'http_get', return_value='<html>有异常请求从你的 IP 发出</html>'):
            with self.assertRaises(RuntimeError):
                server.douban_get('https://book.douban.com/subject/1/')


BIKE_OK = json.dumps({'errcode': 0, 'data': {'paths': [{'distance': '3440', 'duration': '840'}]}})

CFG_KEY = {'geocode': {'provider': 'amap', 'key': 'k'}}


class BikeGateTest(unittest.TestCase):
    """高德骑行接口每秒只让发 3 次，所以 bike_gate 要给上游请求排队。

    一张结果页十几张卡片同时算骑行，不加间隔就是一片 400——看着像功能坏了。
    这里钉住三件事：间隔确实是 1/3 秒、没缓存的请求都要过闸、缓存命中的不过闸。
    """

    def setUp(self):
        self.saved = dict(server.BIKE_CACHE)
        server.BIKE_CACHE.clear()

    def tearDown(self):
        server.BIKE_CACHE.clear()
        server.BIKE_CACHE.update(self.saved)

    def test_gap_matches_the_upstream_limit(self):
        self.assertAlmostEqual(server.BIKE_MIN_GAP, 1.0 / 3)

    def test_gate_spaces_requests(self):
        # 只量「不低于」：sleep 只会让间隔变长，不会因为机器慢而假红
        server.BIKE_LAST_AT = 0.0
        t0 = time.time()
        for _ in range(3):
            server.bike_gate()
        self.assertGreaterEqual(time.time() - t0, 2 * server.BIKE_MIN_GAP * 0.9)

    def test_every_uncached_pair_goes_through_the_gate(self):
        seen = []
        with mock.patch.object(server, 'http_get', return_value=BIKE_OK) as hg:
            with mock.patch.object(server, 'bike_gate', side_effect=lambda: seen.append(1)):
                v, msg = server.bike_estimate('121.44,31.22', '121.47,31.23', CFG_KEY)
        self.assertEqual(msg, 'ok')
        self.assertEqual(v, {'minutes': 14, 'distance': 3440})
        self.assertEqual(len(seen), 1)
        self.assertEqual(len(hg.call_args_list), 1)

    def test_cache_hit_skips_the_gate(self):
        seen = []
        with mock.patch.object(server, 'http_get', return_value=BIKE_OK):
            with mock.patch.object(server, 'bike_gate', side_effect=lambda: seen.append(1)):
                server.bike_estimate('121.44,31.22', '121.50,31.26', CFG_KEY)
                v, msg = server.bike_estimate('121.44,31.22', '121.50,31.26', CFG_KEY)
        self.assertEqual(msg, 'cache')
        self.assertEqual(v, {'minutes': 14, 'distance': 3440})
        self.assertEqual(len(seen), 1)

    def test_no_key_needs_no_gate(self):
        # 没 Key 直接退出，别白等一个间隔
        with mock.patch.object(server, 'bike_gate', side_effect=AssertionError('过了闸')):
            v, msg = server.bike_estimate('121.44,31.22', '121.47,31.23', {})
        self.assertIsNone(v)
        self.assertIn('高德 Key', msg)


if __name__ == '__main__':
    unittest.main()
