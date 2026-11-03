"""豆瓣「这本书的其他版本」区块的离线单测：只喂手写的小段页面，不联网。

这一行的口径是「只认豆瓣区块，上图接口不参与」，所以钉住的全是豆瓣那边的约定：
区块的类名与里面的条目链接、标题里的「全部 N」指向 /works/、版本页 #info 里的 ISBN、
以及缓存的三条规矩（读到才落盘、没有也落但只留 7 天、没连上的不落）。
豆瓣改版时先在这里红，而不是让用户看到一行空位。
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web'))
import server  # noqa: E402


# 区块本身是 div.gray_ad.version_works：切到下一个 gray_ad 为止。
# 里面嵌着购书链接（link2 后面是编码过的跳转地址），它们不是版本。
SUBJECT_PAGE = '''
<html><head>
<meta property="og:url" content="https://book.douban.com/subject/11606799/"/>
</head><body>
<div id="content">
<div class="gray_ad"><h2>想买这本书</h2><div class="buyinfo">
<a href="https://book.douban.com/link2/?url=x">去购买</a></div></div>
<div class="gray_ad version_works">
  <h3>这本书的其他版本&nbsp;(<a href="https://book.douban.com/works/1142073">全部616</a>)</h3>
  <ul class="version_list">
    <li><a href="https://book.douban.com/subject/11110001/">上海译文出版社 （2011）</a></li>
    <li><a href="https://book.douban.com/subject/11110002/">人民文学出版社 2009</a></li>
    <li><a href="https://book.douban.com/subject/11110002/">人民文学出版社 2009</a></li>
    <li><a href="https://book.douban.com/subject/11110003/">广西师范大学出版社</a></li>
  </ul>
  <div class="buyinfo"><a href="https://book.douban.com/link2/?target=https%3A%2F%2Fbook.douban.com%2Fsubject%2F99999999%2F">购买</a></div>
</div>
<div class="gray_ad"><h2>喜欢读这本书的人也喜欢</h2>
  <a href="https://book.douban.com/subject/88888888/">隔壁那本 2020</a>
</div>
</div>
<div id="info"><span class="pl">出版社:</span> 上海人民出版社<br/><span class="pl">出版年:</span> 2016-5<br/></div>
</body></html>
'''

NO_BOX_PAGE = '''
<div id="content"><div class="gray_ad"><h2>喜欢读这本书的人也喜欢</h2></div></div>
<div id="info"><span class="pl">出版社:</span> 作家出版社<br/><span class="pl">出版年:</span> 2012<br/></div>
'''


def edition_page(isbn):
    return ('<html><head><meta content="https://book.douban.com/subject/11110001/"'
            ' property="og:url"/></head><body><div id="info">'
            '<span class="pl">ISBN:</span> %s<br/></div></body></html>' % isbn)


class ParseVersionBlockTest(unittest.TestCase):
    def test_labels_and_works_link(self):
        box = server.parse_version_block(SUBJECT_PAGE)
        self.assertEqual([e['publisher'] for e in box['editions']],
                         ['上海译文出版社', '人民文学出版社', '广西师范大学出版社'])
        self.assertEqual([e['year'] for e in box['editions']], ['2011', '2009', ''])
        self.assertEqual(box['editions'][0]['subjectId'], '11110001')
        self.assertEqual(box['editions'][0]['url'],
                         'https://book.douban.com/subject/11110001/')
        self.assertEqual(box['works'], {'url': 'https://book.douban.com/works/1142073',
                                        'total': 616})

    def test_repeats_and_next_section_dropped(self):
        # 同一个条目出现两次只算一条；下一节「喜欢读的人也喜欢」不在区块里
        ids = [e['subjectId'] for e in server.parse_version_block(SUBJECT_PAGE)['editions']]
        self.assertEqual(ids.count('11110002'), 1)
        self.assertNotIn('88888888', ids)
        self.assertNotIn('99999999', ids)

    def test_no_block(self):
        self.assertEqual(server.parse_version_block(NO_BOX_PAGE),
                         {'editions': [], 'works': None})
        self.assertEqual(server.parse_version_block(''), {'editions': [], 'works': None})

    def test_capped(self):
        rows = ''.join('<li><a href="https://book.douban.com/subject/%d/">出版社%d 20%02d</a></li>'
                       % (20000000 + i, i, i) for i in range(server.VERSIONS_MAX + 4))
        box = server.parse_version_block(
            '<div class="gray_ad version_works"><ul>%s</ul></div>' % rows)
        self.assertEqual(len(box['editions']), server.VERSIONS_MAX)


class ParseImprintTest(unittest.TestCase):
    def test_publisher_and_year(self):
        self.assertEqual(server.parse_imprint(SUBJECT_PAGE),
                         {'publisher': '上海人民出版社', 'year': '2016'})

    def test_missing_info_is_blank_not_guessed(self):
        self.assertEqual(server.parse_imprint('<div id="info">别的</div>'),
                         {'publisher': '', 'year': ''})


class VersionsForBookTest(unittest.TestCase):
    """整条链路的入口：条目 id / ISBN → 区块 → 逐条读 ISBN → 落盘缓存。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='shlib-ver-')
        self.cache = os.path.join(self.dir, 'versions-cache.json')
        self.calls = []
        self.editions = {'11110001': '9787532747962', '11110002': '9787020070081',
                         '11110003': '9787544775810'}
        self.patchers = [
            mock.patch.object(server, 'VERSIONS_CACHE', self.cache),
            mock.patch.object(server, 'VERSIONS_RETRY_GAP', 0),
            mock.patch.object(server, 'douban_get', side_effect=self.get),
        ]
        for p in self.patchers:
            p.start()

    def tearDown(self):
        for p in self.patchers:
            p.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def get(self, url, timeout=25):
        self.calls.append(url)
        if url.endswith('/isbn/9787020070081/'):
            # ISBN 入口：豆瓣 301 到条目页，页面里的 og:url 才是条目 id
            return SUBJECT_PAGE
        if url.startswith(server.SUBJECT_URL % '11606799'):
            return SUBJECT_PAGE
        if url.startswith(server.SUBJECT_URL % '26630588'):
            return NO_BOX_PAGE
        for sid, isbn in self.editions.items():
            if url == server.SUBJECT_URL % sid:
                if isbn == 'boom':
                    raise OSError('连不上')
                return edition_page(isbn)
        raise AssertionError('不该请求这个地址：%s' % url)

    def payload(self, ref):
        data, code = server.versions_for_book(ref)
        return code, data

    def test_subject_id(self):
        code, data = self.payload('11606799')
        self.assertEqual(code, 200)
        self.assertEqual(data['subjectId'], '11606799')
        self.assertEqual([e['isbn'] for e in data['editions']],
                         ['9787532747962', '9787020070081', '9787544775810'])
        self.assertEqual(data['works']['total'], 616)
        self.assertEqual(data['imprint']['publisher'], '上海人民出版社')
        self.assertTrue(data['sure'])
        self.assertFalse(data['fromCache'])

    def test_second_call_hits_cache_without_requests(self):
        self.payload('11606799')
        n = len(self.calls)
        code, data = self.payload('11606799')
        self.assertEqual(code, 200)
        self.assertTrue(data['fromCache'])
        self.assertEqual(len(self.calls), n)

    def test_isbn_entry_resolves_to_subject_and_shares_the_cache(self):
        code, data = self.payload('9787020070081')
        self.assertEqual(code, 200)
        self.assertEqual(data['subjectId'], '11606799')
        n = len(self.calls)
        self.payload('11606799')
        self.assertEqual(len(self.calls), n, 'ISBN 那路认出的条目 id 没写进缓存')

    def test_no_block_is_cached_as_absent(self):
        _code, data = self.payload('26630588')
        self.assertEqual(data['editions'], [])
        self.assertTrue(data['sure'])
        with open(self.cache, encoding='utf-8') as f:
            hit = json.load(f)['subjects']['26630588']
        self.assertTrue(hit['absent'])
        self.payload('26630588')
        self.assertEqual(len(self.calls), 1, '「这本书没有版本」该只查一次（7 天内）')

    def test_absent_cache_expires(self):
        self.payload('26630588')
        with open(self.cache, encoding='utf-8') as f:
            doc = json.load(f)
        doc['subjects']['26630588']['at'] = time.time() - server.VERSIONS_ABSENT_TTL - 1
        with open(self.cache, 'w', encoding='utf-8') as f:
            json.dump(doc, f)
        self.payload('26630588')
        self.assertEqual(len(self.calls), 2, '「没有版本」只该锁 7 天，到期要再看一次')

    def test_partial_result_caches_what_it_read(self):
        # 一条没连上：sure=False，那一版不写进结果。读到几条算几条——
        # 三条里的一条抖动不该让整本书不落盘，也不该把没读到的那版编出来
        self.editions['11110003'] = 'boom'
        _code, data = self.payload('11606799')
        self.assertFalse(data['sure'])
        self.assertEqual([e['isbn'] for e in data['editions']],
                         ['9787532747962', '9787020070081'])
        _code, again = self.payload('11606799')
        self.assertTrue(again['fromCache'])
        self.assertEqual([e['isbn'] for e in again['editions']],
                         ['9787532747962', '9787020070081'])

    def test_blocked_page_reports_502(self):
        with mock.patch.object(server, 'douban_get',
                               side_effect=server.DoubanBlocked(600)):
            data, code = server.versions_for_book('11606799')
        self.assertEqual(code, 502)
        self.assertEqual(data['blockedFor'], 600)
        self.assertFalse(os.path.exists(self.cache))

    def test_dead_subject_not_cached(self):
        dead = '<html><head><title>页面不存在</title></head><body></body></html>'
        with mock.patch.object(server, 'douban_get', return_value=dead):
            code, data = self.payload('27614824')
        self.assertEqual(code, 200)
        self.assertEqual(data['editions'], [])
        self.assertFalse(os.path.exists(self.cache), '条目已经没了，换个 id 还得能读到')

    def test_bad_ref(self):
        code, data = self.payload('  ')
        self.assertEqual(code, 400)
        self.assertIn('error', data)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
