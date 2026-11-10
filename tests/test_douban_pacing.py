"""豆瓣节流、冷却落盘与封面落盘的单测：不联网。

2026-11 豆瓣开始按 IP 发登录墙，连续快速请求是主要诱因。这里钉住几条刹车：
- 10 分钟内最多 30 次（本地配额，不冒充豆瓣封禁、不写封禁文件）；
- 被挡后冷却落盘，连续被挡按 10 分钟 / 1 小时 / 6 小时递增；
- 登录墙单独报错、不进冷却（等再久也不会好，也不存在登录态可填）；
- ISBN 后台补全每个来源每次启动最多 10 本；
- 封面缓存落盘后，重启（清内存）也能直接从磁盘取。
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


class DummyHandler:
    """只实现 api_config / api_cover 用到的那几个钩子。"""

    def __init__(self, loopback=True, query=None):
        self.loopback = loopback
        self.q = query or {}
        self.out = None
        self.image = None
        self.image_type = None
        self.image_cache = None

    def is_loopback_req(self):
        return self.loopback

    def query(self):
        return self.q

    def json(self, obj, code=200):
        self.out = obj
        self.code = code

    def send_image(self, data, ctype=None, cache=True):
        self.image = data
        self.image_type = ctype
        self.image_cache = cache


class DoubanStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shlib-douban-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.block_path = os.path.join(self.tmp, 'douban-block.json')
        self.covers = os.path.join(self.tmp, 'covers')
        self.patchers = [
            mock.patch.object(server, 'DOUBAN_BLOCK_PATH', self.block_path),
            mock.patch.object(server, 'COVERS_DIR', self.covers),
            mock.patch.object(server, 'DOUBAN_MIN_GAP', 0),
            mock.patch.object(server, 'DOUBAN_GAP_JITTER', 0),
            mock.patch.object(server, 'DOUBAN_BUDGET', []),
            mock.patch.object(server, 'DOUBAN_BLOCKED_UNTIL', 0.0),
            mock.patch.object(server, 'DOUBAN_BLOCK_STATE', {'strikes': 0, 'lastAt': 0.0}),
            mock.patch.object(server, 'DOUBAN_BLOCK_LOADED', False),
            mock.patch.object(server, 'COVER_MEM', {}),
            mock.patch.object(server, 'COVER_MEM_BYTES', 0),
            mock.patch.object(server, 'ISBN_ATTEMPTS', {}),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def restart(self):
        """模拟重启：内存清空，下次访问时从磁盘读回。"""
        server.DOUBAN_BLOCKED_UNTIL = 0.0
        server.DOUBAN_BLOCK_STATE = {'strikes': 0, 'lastAt': 0.0}
        server.DOUBAN_BLOCK_LOADED = False


class BudgetTest(DoubanStateTest):
    def test_budget_stops_before_network_and_does_not_fake_a_block(self):
        calls = []

        def fake_get(url, timeout=20, headers=None, data=None):
            calls.append(url)
            return '<html>ok</html>'

        with mock.patch.object(server, 'http_get', side_effect=fake_get):
            for _ in range(server.DOUBAN_BUDGET_MAX):
                server.douban_get('https://book.douban.com/subject/1/')
            with self.assertRaises(server.DoubanBudget) as ctx:
                server.douban_get('https://book.douban.com/subject/1/')
        self.assertEqual(len(calls), server.DOUBAN_BUDGET_MAX)
        self.assertGreater(ctx.exception.retry_after, 0)
        # 本地配额不是豆瓣封禁：不落封禁文件，冷却仍是 0
        self.assertFalse(os.path.exists(self.block_path))
        self.assertEqual(server.douban_blocked_for(), 0)


class BlockPersistenceTest(DoubanStateTest):
    def read_state(self):
        with open(self.block_path, encoding='utf-8') as f:
            return json.load(f)

    def test_first_block_is_ten_minutes_and_survives_restart(self):
        e = server._mark_douban_blocked()
        self.assertLessEqual(abs(e.retry_after - 10 * 60), 5)
        state = self.read_state()
        self.assertEqual(state['strikes'], 1)
        self.restart()
        self.assertGreater(server.douban_blocked_for(), 500)

    def test_consecutive_blocks_escalate(self):
        server._mark_douban_blocked()
        self.restart()
        e2 = server._mark_douban_blocked()
        self.assertLessEqual(abs(e2.retry_after - 3600), 5)
        self.assertEqual(self.read_state()['strikes'], 2)
        self.restart()
        e3 = server._mark_douban_blocked()
        self.assertLessEqual(abs(e3.retry_after - 6 * 3600), 5)
        self.assertEqual(self.read_state()['strikes'], 3)

    def test_quiet_day_resets_to_first_step(self):
        server._mark_douban_blocked()
        state = self.read_state()
        state['lastAt'] = time.time() - 25 * 3600
        with open(self.block_path, 'w', encoding='utf-8') as f:
            json.dump(state, f)
        self.restart()
        e = server._mark_douban_blocked()
        self.assertLessEqual(abs(e.retry_after - 10 * 60), 5)
        self.assertEqual(self.read_state()['strikes'], 1)


class LoginWallTest(DoubanStateTest):
    def test_login_wall_is_reported_and_does_not_start_cooldown(self):
        err = urllib.error.HTTPError(
            'https://book.douban.com/', 403, 'Forbidden', {},
            io.BytesIO('请登录使用豆瓣'.encode('utf-8')))
        with mock.patch.object(server, 'http_get', side_effect=err):
            with self.assertRaises(server.DoubanLoginRequired):
                server.douban_get('https://book.douban.com/subject/1/')
        self.assertFalse(os.path.exists(self.block_path))
        self.assertEqual(server.douban_blocked_for(), 0)

    def test_success_sends_only_referer(self):
        seen = {}

        def fake_get(url, timeout=20, headers=None, data=None):
            seen.update(headers or {})
            return '<html>ok</html>'

        with mock.patch.object(server, 'http_get', side_effect=fake_get):
            server.douban_get('https://book.douban.com/subject/1/')
        self.assertNotIn('Cookie', seen)
        self.assertEqual(seen.get('Referer'), 'https://www.douban.com/')


class IsbnCapTest(DoubanStateTest):
    def test_each_source_backfills_at_most_ten_per_start(self):
        books = [{'url': 'https://book.douban.com/subject/%d/' % i}
                 for i in range(15)]
        entry = {'url': server.doulist_url_of('1'), 'books': books}
        cache = {entry['url']: entry}
        calls = []

        def fake_isbn(url):
            calls.append(url)
            return '9780000000001'

        with mock.patch.object(server, '_read_doulist_cache', return_value=cache), \
                mock.patch.object(server, 'DOULIST_CACHE',
                                  os.path.join(self.tmp, 'doulist-cache.json')), \
                mock.patch.object(server, 'fetch_isbn', side_effect=fake_isbn):
            server._isbn_worker(entry['url'])
            self.assertEqual(len(calls), server.ISBN_BACKFILL_MAX)
            self.assertEqual(server.ISBN_ATTEMPTS[entry['url']], server.ISBN_BACKFILL_MAX)
            # 同一个进程里再跑一次：配额已经用完，不再打豆瓣
            server._isbn_worker(entry['url'])
        self.assertEqual(len(calls), server.ISBN_BACKFILL_MAX)


JPEG = b'\xff\xd8\xff\xe0' + b'x' * 400


class CoverDiskTest(DoubanStateTest):
    def test_second_request_serves_from_disk_after_memory_is_cleared(self):
        url = 'https://img9.doubanio.com/view/subject/s/public/s123.jpg'
        handler = DummyHandler(query={'u': url})

        class Resp:
            headers = {'Content-Type': 'image/jpeg'}

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return JPEG

        with mock.patch.object(server.urllib.request, 'urlopen', return_value=Resp()):
            server.Handler.api_cover(handler)
        self.assertEqual(handler.image, JPEG)
        path = server._cover_path(url)
        self.assertTrue(os.path.exists(path))

        server.COVER_MEM.clear()
        server.COVER_MEM_BYTES = 0
        handler2 = DummyHandler(query={'u': url})
        with mock.patch.object(server.urllib.request, 'urlopen',
                               side_effect=AssertionError('不该再打豆瓣')):
            server.Handler.api_cover(handler2)
        self.assertEqual(handler2.image, JPEG)
        self.assertEqual(handler2.image_type, 'image/jpeg')


if __name__ == '__main__':
    unittest.main()
