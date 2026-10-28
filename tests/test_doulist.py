"""豆瓣书单的分批抓取与反爬冷却单测：不联网，只喂手写页面。

长书单以前是「一次抓 500 本、静默截断」，撞上反爬还会把空结果写进缓存。
这里钉住四件事：一批 25 本、继续加载只追加不丢、拦截保留旧缓存并冷却、
自动续期不会把更全的旧缓存覆盖成一小截。
"""
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web'))
import server  # noqa: E402

URL = 'https://www.douban.com/doulist/123456/'  # 假豆列号，@@gate-example@@


def page_html(ids):
    return ('<html><head><title>我的书单 - 豆瓣</title></head><body>' +
            ''.join('<div id="%s" class="doulist-item">'
                    '<div class="title"><a href="https://book.douban.com/subject/%s/">书 %s</a></div>'
                    '</div>' % (i, i, i) for i in ids) +
            '</body></html>')


def page_get(ids):
    """按 ?start= 返回对应的一页 25 条；越界返回空页。"""
    def get(url, timeout=20, **kw):
        m = re.search(r'[?&]start=(\d+)', url)
        start = int(m.group(1)) if m else 0
        return page_html(ids[start:start + 25])
    return get


class DoulistBatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = os.path.join(self.tmp, 'doulist-cache.json')
        p = mock.patch.object(server, 'DOULIST_CACHE', self.cache)
        p.start()
        self.addCleanup(p.stop)
        self.blocked = mock.patch.object(server, 'DOUBAN_BLOCKED_UNTIL', 0.0)
        self.blocked.start()
        self.addCleanup(self.blocked.stop)

    def read_cache(self):
        with open(self.cache, encoding='utf-8') as f:
            return json.load(f)

    def test_first_batch_stops_at_25(self):
        ids = [str(i) for i in range(300)]
        with mock.patch.object(server, 'douban_get', side_effect=page_get(ids)):
            out = server.load_doulist(URL, with_isbn=False)
        self.assertEqual(len(out['books']), 25)
        self.assertFalse(out['complete'])
        self.assertEqual(out['nextStart'], 25)
        self.assertFalse(out['truncated'])
        self.assertEqual(len(self.read_cache()[URL]['books']), 25)

    def test_more_appends_without_duplicates(self):
        ids = [str(i) for i in range(40)]
        with mock.patch.object(server, 'douban_get', side_effect=page_get(ids)):
            first = server.load_doulist(URL, with_isbn=False)
            second = server.load_doulist(URL, more=True, with_isbn=False)
        self.assertEqual(len(first['books']), 25)
        self.assertEqual(len(second['books']), 40)
        self.assertEqual(len({b['id'] for b in second['books']}), 40)
        self.assertTrue(second['complete'])
        self.assertEqual(second['nextStart'], 0)

    def test_short_list_is_complete(self):
        ids = [str(i) for i in range(10)]
        with mock.patch.object(server, 'douban_get', side_effect=page_get(ids)):
            out = server.load_doulist(URL, with_isbn=False)
        self.assertEqual(len(out['books']), 10)
        self.assertTrue(out['complete'])

    def test_blocked_keeps_old_cache(self):
        old = {'url': URL, 'name': '旧书单', 'at': time.time() - 13 * 3600,
               'books': [{'id': '1', 'title': '旧书', 'url': 'u1'}], 'complete': True}
        with open(self.cache, 'w', encoding='utf-8') as f:
            json.dump({URL: old}, f, ensure_ascii=False)
        with mock.patch.object(server, 'douban_get', side_effect=server.DoubanBlocked(600)):
            out = server.load_doulist(URL, refresh=True, with_isbn=False)
        self.assertEqual(len(out['books']), 1)
        self.assertEqual(out['books'][0]['title'], '旧书')
        self.assertGreater(out['blockedFor'], 0)
        self.assertEqual(self.read_cache()[URL]['books'], old['books'])

    def test_cooldown_does_not_call_douban(self):
        old = {'url': URL, 'name': '旧书单', 'at': time.time() - 13 * 3600,
               'books': [{'id': '1', 'title': '旧书', 'url': 'u1'}], 'complete': True}
        with open(self.cache, 'w', encoding='utf-8') as f:
            json.dump({URL: old}, f, ensure_ascii=False)
        server.DOUBAN_BLOCKED_UNTIL = time.time() + 120
        with mock.patch.object(server, 'douban_get',
                               side_effect=AssertionError('冷却期不应该请求豆瓣')):
            out = server.load_doulist(URL, refresh=True, with_isbn=False)
        self.assertEqual(len(out['books']), 1)
        self.assertGreater(out['blockedFor'], 0)

    def test_blocked_without_cache_raises(self):
        with mock.patch.object(server, 'douban_get', side_effect=server.DoubanBlocked(600)):
            with self.assertRaises(server.DoubanBlocked) as ctx:
                server.load_doulist(URL, with_isbn=False)
        self.assertEqual(ctx.exception.retry_after, 600)
        self.assertFalse(os.path.exists(self.cache))

    def test_more_blocked_keeps_loaded_books_without_persisting_cooldown(self):
        ids = [str(i) for i in range(75)]
        with mock.patch.object(server, 'douban_get', side_effect=page_get(ids)):
            first = server.load_doulist(URL, with_isbn=False)   # 25 本，nextStart=25
        with mock.patch.object(server, 'douban_get', side_effect=server.DoubanBlocked(600)):
            out = server.load_doulist(URL, more=True, with_isbn=False)
        self.assertEqual(len(out['books']), 25)
        self.assertEqual([b['id'] for b in out['books']], [b['id'] for b in first['books']])
        self.assertFalse(out['complete'])
        self.assertGreater(out['blockedFor'], 0)
        self.assertNotIn('blockedFor', self.read_cache()[URL])
        self.assertEqual(len(self.read_cache()[URL]['books']), 25)

    def test_cache_hit_starts_isbn_worker(self):
        entry = {'url': URL, 'name': '书单', 'at': time.time(),
                 'books': [{'id': '1', 'title': '书', 'url': 'u1'}], 'complete': True}
        with open(self.cache, 'w', encoding='utf-8') as f:
            json.dump({URL: entry}, f, ensure_ascii=False)
        seen = []
        with mock.patch.object(server, 'ensure_isbn_worker', lambda u: seen.append(u)), \
                mock.patch.object(server, 'douban_get',
                                  side_effect=AssertionError('命中缓存不该请求豆瓣')):
            out = server.load_doulist(URL)
        self.assertEqual(len(out['books']), 1)
        self.assertEqual(seen, [URL])

    def test_auto_refresh_never_shrinks_long_cache(self):
        ids = [str(i) for i in range(300)]
        old = {'url': URL, 'name': '旧书单', 'at': time.time() - 13 * 3600,
               'books': [{'id': i, 'title': '书 ' + i, 'url': 'u' + i} for i in ids],
               'complete': True}
        with open(self.cache, 'w', encoding='utf-8') as f:
            json.dump({URL: old}, f, ensure_ascii=False)
        with mock.patch.object(server, 'douban_get', side_effect=page_get(ids)):
            out = server.load_doulist(URL, with_isbn=False)   # refresh=False = 自动续期
        self.assertEqual(len(out['books']), 300)
        self.assertTrue(out['complete'])


class DoubanBlockTest(unittest.TestCase):
    def setUp(self):
        self.blocked = mock.patch.object(server, 'DOUBAN_BLOCKED_UNTIL', 0.0)
        self.blocked.start()
        self.addCleanup(self.blocked.stop)
        self.gap = mock.patch.object(server, 'DOUBAN_MIN_GAP', 0)
        self.gap.start()
        self.addCleanup(self.gap.stop)

    def test_http_403_marks_blocked(self):
        err = urllib.error.HTTPError(URL, 403, 'Forbidden', {}, None)
        with mock.patch.object(server, 'http_get', side_effect=err):
            with self.assertRaises(server.DoubanBlocked):
                server.douban_get(URL)
        self.assertGreater(server.douban_blocked_for(), 0)

    def test_anti_bot_page_is_not_a_runtime_error_only(self):
        with mock.patch.object(server, 'http_get', return_value='<html>有异常请求从你的 IP 发出</html>'):
            with self.assertRaises(server.DoubanBlocked):
                server.douban_get(URL)
        self.assertGreater(server.douban_blocked_for(), 0)

    def test_attribute_order_is_parsed(self):
        html = ('<div class="doulist-item" id="9">'
                '<div class="title"><a href="https://book.douban.com/subject/9/">书 9</a></div>'
                '</div>')
        books = server.parse_doulist_page(html)
        self.assertEqual(len(books), 1)
        self.assertEqual(books[0]['id'], '9')


class WorkerStartTest(unittest.TestCase):
    """两个后台补全线程必须带着书单地址启动。

    以前 Thread(target=...) 漏了 args，线程一启动就 TypeError 退出：
    ISBN 回填和封面 id 回填一直没跑，url 还永久留在 worker 集合里拦住重试。
    """

    def test_isbn_worker_gets_url(self):
        seen = []
        done = threading.Event()

        def fake(url):
            seen.append(url)
            done.set()

        server.ISBN_WORKERS.discard(URL)
        with mock.patch.object(server, '_isbn_worker', fake), \
                mock.patch.object(server, 'douban_blocked_for', lambda: 0):
            server.ensure_isbn_worker(URL)
            self.assertTrue(done.wait(2), 'ISBN 回填线程没带着 url 启动')
        server.ISBN_WORKERS.discard(URL)
        self.assertEqual(seen, [URL])

    def test_shl_worker_gets_url(self):
        seen = []
        done = threading.Event()

        def fake(url):
            seen.append(url)
            done.set()

        server.SHL_WORKERS.discard(URL)
        with mock.patch.object(server, '_shl_worker', fake):
            server.ensure_shl_worker(URL)
            self.assertTrue(done.wait(2), '封面 id 回填线程没带着 url 启动')
        server.SHL_WORKERS.discard(URL)
        self.assertEqual(seen, [URL])


if __name__ == '__main__':
    unittest.main()
