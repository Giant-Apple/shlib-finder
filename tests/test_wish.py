"""豆瓣「想读」列表的解析、翻页与错误分类：不联网，只喂手写页面。

想读页和豆列页结构完全不同（li.subject-item / div.pub / rel="next"），
拿豆列解析器读只会得到 0 本，然后被当成「已经到底了」。这里钉住：
一页 15 本、按 rel="next" 翻页、私密/不存在/改版各自报错且不进反爬冷却。
"""
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web'))
import server  # noqa: E402

WISH = 'https://book.douban.com/people/YOUR_DOUBAN_ID/wish'  # 占位账号，不是真实地址
# 影视「想看」的同形地址，用来验证它会被拒绝而不是被当成图书想读
MOVIE_WISH = WISH.replace('book.', 'movie.')


def wish_item(i):
    return ('<li class="subject-item">'
            '<div class="pic"><a href="https://book.douban.com/subject/%s/">'
            '<img src="https://img.example/%s.jpg"></a></div>'
            '<div class="info"><h2><a href="https://book.douban.com/subject/%s/">书 %s</a></h2>'
            '<div class="pub">作者%s / 出版社%s / 2020-1 / 59.00元</div>'
            '</div></li>' % (i, i, i, i, i, i))


def wish_page(ids, next_start=None):
    nxt = ''
    if next_start is not None:
        nxt = '<link rel="next" href="%s?start=%d&amp;sort=time">' % (WISH, next_start)
    return ('<html><head><title>我想读的书(161)</title>%s</head><body>'
            '<div class="interest-list">%s</div></body></html>'
            % (nxt, ''.join(wish_item(i) for i in ids)))


def wish_get(total):
    """按 ?start= 返回一页 15 条；没有下一页时不带 rel="next"。"""
    def get(url, timeout=20, **kw):
        start = 0
        if 'start=' in url:
            start = int(url.split('start=')[1].split('&')[0])
        ids = [str(i) for i in range(start, min(total, start + 15))]
        nxt = start + 15 if start + 15 < total else None
        return wish_page(ids, nxt)
    return get


class WishParseTest(unittest.TestCase):
    def test_parses_15_and_fields(self):
        books = server.parse_wish_page(wish_page([str(i) for i in range(15)], 15))
        self.assertEqual(len(books), 15)
        b = books[0]
        self.assertEqual(b['id'], '0')
        self.assertEqual(b['title'], '书 0')
        self.assertEqual(b['author'], '作者0')
        self.assertEqual(b['publisher'], '出版社0')
        self.assertEqual(b['year'], '2020')
        self.assertEqual(b['url'], 'https://book.douban.com/subject/0/')
        self.assertTrue(b['cover'])

    def test_next_link_becomes_absolute(self):
        html = wish_page(['1'], 15)
        self.assertEqual(server.parse_wish_next(html, WISH),
                         WISH + '?start=15&sort=time')
        self.assertEqual(server.parse_wish_next(wish_page(['1']), WISH), '')

    def test_movie_wish_url_is_rejected(self):
        with self.assertRaises(ValueError):
            server.wish_url_of(MOVIE_WISH)
        self.assertEqual(server.wish_url_of(WISH + '?start=30&sort=time'), WISH)

    def test_private_and_gone_and_format_are_distinct(self):
        with self.assertRaises(server.DoubanPrivate):
            server.check_wish_page('<html><body>请登录后查看</body></html>')
        with self.assertRaises(server.DoubanGone):
            server.check_wish_page('<html><body>你要访问的页面不存在</body></html>')
        with self.assertRaises(server.DoubanFormat):
            server.check_wish_page('<html><body>完全陌生的页面</body></html>')
        self.assertIsNone(server.check_wish_page(wish_page(['1'])))


class WishBatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = os.path.join(self.tmp, 'doulist-cache.json')
        for name, value in (('DOULIST_CACHE', self.cache), ('DOUBAN_BLOCKED_UNTIL', 0.0)):
            p = mock.patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)

    def read_cache(self):
        with open(self.cache, encoding='utf-8') as f:
            return json.load(f)

    def test_one_page_per_batch_and_resume(self):
        with mock.patch.object(server, 'douban_get', side_effect=wish_get(20)):
            first = server.load_doulist(WISH, with_isbn=False)
            self.assertEqual(len(first['books']), 15)
            self.assertFalse(first['complete'])
            self.assertTrue(first['nextUrl'].endswith('start=15&sort=time'))
            second = server.load_doulist(WISH, more=True, with_isbn=False)
        self.assertEqual(len(second['books']), 20)
        self.assertTrue(second['complete'])
        self.assertEqual(second['nextUrl'], '')
        self.assertEqual(second['kind'], 'wish')
        self.assertEqual(self.read_cache()[WISH]['kind'], 'wish')

    def test_private_page_does_not_enter_cooldown_or_write_cache(self):
        private = '<html><body>请登录后查看</body></html>'
        with mock.patch.object(server, 'douban_get', return_value=private):
            with self.assertRaises(server.DoubanPrivate):
                server.load_doulist(WISH, with_isbn=False)
        self.assertEqual(server.douban_blocked_for(), 0)
        self.assertFalse(os.path.exists(self.cache))

    def test_changed_layout_with_next_page_is_format_error(self):
        html = '<html><head><link rel="next" href="%s?start=15"></head>' \
               '<body><div class="interest-list">改版了</div></body></html>' % WISH
        with mock.patch.object(server, 'douban_get', return_value=html):
            with self.assertRaises(server.DoubanFormat):
                server.load_doulist(WISH, with_isbn=False)

    def test_403_private_body_is_not_anti_bot(self):
        err = urllib.error.HTTPError(WISH, 403, 'Forbidden', {},
                                     io.BytesIO('仅自己可见，请登录'.encode('utf-8')))
        with mock.patch.object(server, 'http_get', side_effect=err):
            with self.assertRaises(server.DoubanPrivate):
                server.douban_get(WISH, private_hint=True)
        self.assertEqual(server.douban_blocked_for(), 0)

    def test_403_anti_bot_body_still_blocks(self):
        err = urllib.error.HTTPError(WISH, 403, 'Forbidden', {},
                                     io.BytesIO('有异常请求从你的 IP 发出'.encode('utf-8')))
        with mock.patch.object(server, 'http_get', side_effect=err):
            with self.assertRaises(server.DoubanBlocked):
                server.douban_get(WISH, private_hint=True)
        self.assertGreater(server.douban_blocked_for(), 0)


if __name__ == '__main__':
    unittest.main()
