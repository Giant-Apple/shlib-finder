"""单本补 ISBN 的单测：不联网。

书单列表页有的书不带 ISBN，后台线程 1 秒补一本，用户点开的那本常常还没轮到，
于是退回按书名找同名版本，繁体/简体书名对不上就误报「没有这一版」。
/api/isbn 是给单本开的快捷通道：先看书单缓存，没有再抓详情页并把结果写回。
这里钉住三件事：只认豆瓣图书条目地址、缓存命中不再抓、抓到的结果真的落盘。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web'))
import server  # noqa: E402

LIST_URL = server.doulist_url_of('123456')  # 占位豆列号，不是真实豆列
SUBJECT = 'https://book.douban.com/subject/1001/'
KNOWN_ISBN = '9787559887948'


def cache_data(with_isbn=True):
    return {LIST_URL: {'books': [
        {'id': '1001', 'title': '書 A', 'url': SUBJECT},
        {'id': '1002', 'title': '书 B', 'url': 'https://book.douban.com/subject/1002/',
         'isbn': KNOWN_ISBN if with_isbn else ''},
    ]}}


class IsbnEndpointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = os.path.join(self.tmp, 'doulist-cache.json')
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump(cache_data(), f)
        p = mock.patch.object(server, 'DOULIST_CACHE', self.path)
        p.start()
        self.addCleanup(p.stop)
        # 冷却状态只在内存里，前面用例跑过之后别让它拦住这里
        p = mock.patch.object(server, 'DOUBAN_BLOCKED_UNTIL', 0.0)
        p.start()
        self.addCleanup(p.stop)

    def saved(self):
        with open(self.path, encoding='utf-8') as f:
            return json.load(f)

    def test_subject_url_variants(self):
        for raw in (SUBJECT, SUBJECT.rstrip('/'),
                    'http://book.douban.com/subject/1001',
                    SUBJECT + '?from=tag', '  ' + SUBJECT + '  '):
            self.assertEqual(server._subject_id(raw), '1001', raw)

    def test_rejects_other_urls(self):
        bad = [
            '',
            LIST_URL,
            'https://book.douban.com/people/%s/wish' % '123',
            'https://book.douban.com/subject/',
            'https://example.com/subject/1001/',
        ]
        with mock.patch.object(server, 'fetch_isbn') as fetch:
            for raw in bad:
                body, code = server.isbn_for_subject(raw)
                self.assertEqual(code, 400, raw)
                self.assertIn('error', body)
            fetch.assert_not_called()

    def test_cache_hit_does_not_fetch(self):
        with mock.patch.object(server, 'fetch_isbn') as fetch:
            body, code = server.isbn_for_subject(
                'https://book.douban.com/subject/1002?from=tag')
        fetch.assert_not_called()
        self.assertEqual(code, 200)
        self.assertEqual(body['isbn'], KNOWN_ISBN)

    def test_fetched_isbn_is_saved_back(self):
        with mock.patch.object(server, 'fetch_isbn', return_value='9789863772415') as fetch:
            body, code = server.isbn_for_subject(SUBJECT)
        fetch.assert_called_once_with('https://book.douban.com/subject/1001/')
        self.assertEqual(code, 200)
        self.assertEqual(body['isbn'], '9789863772415')
        books = self.saved()[LIST_URL]['books']
        self.assertEqual(books[0]['isbn'], '9789863772415')
        # 已经带 ISBN 的那本不能被覆盖
        self.assertEqual(books[1]['isbn'], KNOWN_ISBN)

    def test_saved_isbn_becomes_cache_hit(self):
        with mock.patch.object(server, 'fetch_isbn', return_value='9789863772415'):
            server.isbn_for_subject(SUBJECT)
        with mock.patch.object(server, 'fetch_isbn') as fetch:
            body, _ = server.isbn_for_subject(SUBJECT)
        fetch.assert_not_called()
        self.assertEqual(body['isbn'], '9789863772415')

    def test_no_isbn_means_no_cache_change(self):
        before = self.saved()
        with mock.patch.object(server, 'fetch_isbn', return_value=''):
            body, code = server.isbn_for_subject(SUBJECT)
        self.assertEqual(code, 200)
        self.assertEqual(body['isbn'], '')
        self.assertEqual(self.saved(), before)

    def test_blocked_propagates_cooldown(self):
        with mock.patch.object(server, 'fetch_isbn',
                               side_effect=server.DoubanBlocked(600)):
            body, code = server.isbn_for_subject(SUBJECT)
        self.assertEqual(code, 502)
        self.assertEqual(body['blockedFor'], 600)
        self.assertTrue(body['error'])
        self.assertNotIn('isbn', self.saved()[LIST_URL]['books'][0])


if __name__ == '__main__':
    unittest.main()
