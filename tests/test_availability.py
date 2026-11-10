"""电子书有无（Z-Library / Anna's Archive）的离线单测：不联网。

钉住几条口径：
- 镜像域名兜底：第一个连不上换下一个，任一拿到合法 JSON 就用，并记住它下次优先；
- 合法的空结果算「没有」，落 7 天缓存；所有镜像都连不上不算「没有」，不落缓存、下次再试；
- 默认关闭时一个第三方请求都不发（开关在服务端兜底，不信任页面）；
- 命中才给两个官网深链，md5 不合法就不给 Anna's 链接；
- 旧缓存（v1 只有书号）自动重查一次补 md5，镜像抖动时退回 Z-Library 入口；
- 域名收拾成纯主机名，javascript:/带路径的一律拒掉；
- 配置接口按字段校验，局域网来源拿不到域名和代理。
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


def book(bid='1', md5='a' * 32, isbn='9787115428028', **kw):
    d = {'id': bid, 'md5': md5, 'isbn': isbn, 'title': 'T', 'extension': 'pdf'}
    d.update(kw)
    return d


class ProviderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shlib-avail-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = os.path.join(self.tmp, 'avail.json')
        self.cfg = {'availability': {
            'enabled': True, 'domains': ['a.example', 'b.example'], 'proxy': '',
            'zlibBase': 'https://z-library.sk', 'annaBase': 'https://annas-archive.gl'}}
        self.patchers = [
            mock.patch.object(server, 'AVAILABILITY_CACHE', self.cache),
            mock.patch.object(server, 'AVAILABILITY_LAST_GOOD', ''),
            mock.patch.object(server, 'load_config', return_value=self.cfg),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def http(self, fn):
        p = mock.patch.object(server, '_avail_http_get', side_effect=fn)
        p.start()
        self.addCleanup(p.stop)
        return p

    def test_fallback_and_last_good_first(self):
        seen = []

        def fn(url, timeout, proxy):
            seen.append(url)
            if url.startswith('https://a.example'):
                raise OSError('down')
            return json.dumps({'books': [book()]})

        self.http(fn)
        payload, code = server.availability_for_book('9787115428028')
        self.assertEqual(code, 200)
        self.assertTrue(payload['found'])
        self.assertEqual(payload['source'], 'b.example')
        self.assertEqual(server.AVAILABILITY_LAST_GOOD, 'b.example')
        # 换一本没缓存的：上次成功的 b 应该排最前
        seen.clear()
        server.availability_for_book('9787115428029')
        self.assertTrue(seen[0].startswith('https://b.example'))

    def test_cache_hit_skips_http(self):
        calls = []
        self.http(lambda u, t, p: calls.append(u) or json.dumps({'books': [book()]}))
        server.availability_for_book('9787115428028')
        again, code = server.availability_for_book('9787115428028')
        self.assertEqual(code, 200)
        self.assertTrue(again['fromCache'])
        self.assertEqual(len(calls), 1)

    def test_absent_is_cached(self):
        calls = []
        self.http(lambda u, t, p: calls.append(u) or json.dumps({'books': []}))
        payload, _ = server.availability_for_book('9787115428028')
        self.assertFalse(payload['found'])
        again, _ = server.availability_for_book('9787115428028')
        self.assertTrue(again['fromCache'])
        self.assertFalse(again['found'])
        self.assertEqual(len(calls), 1)

    def test_all_down_is_not_cached_as_absent(self):
        calls = []

        def fn(u, t, p):
            calls.append(u)
            raise OSError('down')

        self.http(fn)
        payload, _ = server.availability_for_book('9787115428028')
        self.assertFalse(payload['found'])
        self.assertTrue(payload['failed'])
        self.assertIsNone(server._cached_availability('9787115428028'))
        server.availability_for_book('9787115428028')
        self.assertEqual(len(calls), 4)   # 两次查询 × 两个域名，都真的重试了

    def test_disabled_sends_nothing(self):
        self.cfg['availability']['enabled'] = False
        calls = []
        self.http(lambda u, t, p: calls.append(u) or json.dumps({'books': [book()]}))
        payload, code = server.availability_for_book('9787115428028')
        self.assertEqual(code, 200)
        self.assertTrue(payload['disabled'])
        self.assertFalse(payload['found'])
        self.assertEqual(calls, [])

    def test_bad_isbn_is_400(self):
        payload, code = server.availability_for_book('not-an-isbn')
        self.assertEqual(code, 400)
        self.assertIn('error', payload)

    def test_normalized_isbn_and_deep_links(self):
        self.http(lambda u, t, p: json.dumps({'books': [book(bid='2293610', md5='b' * 32)]}))
        payload, _ = server.availability_for_book('978-7-115-42802-8')
        self.assertEqual(payload['isbn'], '9787115428028')
        # Z-Library 条目地址带它自己的 hash，索引书号对不上，落到 ISBN 搜索结果页
        self.assertEqual(payload['zlib_url'], 'https://z-library.sk/s/9787115428028')
        self.assertEqual(payload['anna_url'], 'https://annas-archive.gl/md5/' + 'b' * 32)
        # 书号/md5 不外发
        self.assertNotIn('book_id', payload)
        self.assertNotIn('md5', payload)

    def test_invalid_md5_drops_anna_link(self):
        self.http(lambda u, t, p: json.dumps({'books': [book(md5='zzz')]}))
        payload, _ = server.availability_for_book('9787115428028')
        self.assertTrue(payload['found'])
        self.assertEqual(payload['anna_url'], '')
        self.assertTrue(payload['zlib_url'])

    def test_empty_bases_leave_markers_without_links(self):
        self.cfg['availability']['zlibBase'] = ''
        self.cfg['availability']['annaBase'] = ''
        self.http(lambda u, t, p: json.dumps({'books': [book(bid='2293610', md5='b' * 32)]}))
        payload, _ = server.availability_for_book('9787115428028')
        self.assertTrue(payload['found'])
        self.assertEqual(payload['zlib_url'], '')
        self.assertEqual(payload['anna_url'], '')

    def test_link_follows_current_base_even_on_cache_hit(self):
        calls = []
        self.http(lambda u, t, p: calls.append(u) or
                  json.dumps({'books': [book(bid='2293610', md5='b' * 32)]}))
        server.availability_for_book('9787115428028')
        self.cfg['availability']['zlibBase'] = 'https://1lib.sk'
        payload, _ = server.availability_for_book('9787115428028')
        self.assertTrue(payload['fromCache'])
        self.assertEqual(payload['zlib_url'], 'https://1lib.sk/s/9787115428028')
        self.assertEqual(len(calls), 1)   # 只换链接，不重新联网

    def test_old_cache_entry_without_ids_still_gets_search_link(self):
        self.http(lambda u, t, p: json.dumps({'books': [book()]}))
        server.availability_for_book('9787115428028')
        # 模拟旧格式条目：只有有没有，没有 md5
        with open(self.cache, encoding='utf-8') as f:
            cache = json.load(f)
        cache['books']['9787115428028'].pop('md5', None)
        with open(self.cache, 'w', encoding='utf-8') as f:
            json.dump(cache, f)
        payload, _ = server.availability_for_book('9787115428028')
        self.assertTrue(payload['fromCache'])
        self.assertEqual(payload['zlib_url'], 'https://z-library.sk/s/9787115428028')
        self.assertEqual(payload['anna_url'], '')

    def legacy_entry(self):
        """写一条 v1 格式的缓存（只存书号、没有 md5 和版本号）。"""
        server._remember_availability('9787115428028', {
            'at': time.time(), 'found': True, 'isbn': '9787115428028',
            'title': 'T', 'extension': 'pdf', 'book_id': '1'})
        with open(self.cache, encoding='utf-8') as f:
            cache = json.load(f)
        cache['books']['9787115428028'].pop('v', None)
        with open(self.cache, 'w', encoding='utf-8') as f:
            json.dump(cache, f)

    def test_legacy_cache_is_refreshed_once_to_get_the_anna_link(self):
        calls = []
        self.http(lambda u, t, p: calls.append(u) or json.dumps({'books': [book()]}))
        self.legacy_entry()
        payload, _ = server.availability_for_book('9787115428028')
        self.assertFalse(payload.get('fromCache'))
        self.assertEqual(len(calls), 1)
        self.assertTrue(payload['anna_url'])
        with open(self.cache, encoding='utf-8') as f:
            self.assertEqual(json.load(f)['books']['9787115428028']['v'],
                             server.AVAILABILITY_CACHE_VERSION)
        # 补成 v2 后回到缓存命中，不再打镜像
        again, _ = server.availability_for_book('9787115428028')
        self.assertTrue(again['fromCache'])
        self.assertEqual(len(calls), 1)

    def test_legacy_cache_still_serves_zlib_when_mirrors_are_down(self):
        def down(u, t, p):
            raise OSError('down')

        self.http(down)
        self.legacy_entry()
        payload, _ = server.availability_for_book('9787115428028')
        self.assertTrue(payload['fromCache'])
        self.assertTrue(payload['found'])
        self.assertEqual(payload['zlib_url'], 'https://z-library.sk/s/9787115428028')
        self.assertEqual(payload['anna_url'], '')

    def test_pick_prefers_exact_isbn(self):
        books = [book(bid='wrong', isbn='9780000000002'),
                 book(bid='right', isbn='9787115428028,7115428026')]
        picked = server._pick_avail_book(books, '9787115428028')
        self.assertEqual(picked['id'], 'right')


class DomainTest(unittest.TestCase):
    def test_clean_strips_scheme_and_path(self):
        self.assertEqual(server._clean_avail_domain('https://A.example/x?y=1'), 'a.example')
        self.assertEqual(server._clean_avail_domain('b.example'), 'b.example')
        # 路径里的 ../ 被整段丢掉，只留合法主机名，拼不出穿越
        self.assertEqual(server._clean_avail_domain('a.example/../../x'), 'a.example')

    def test_clean_rejects_injection(self):
        for bad in ('javascript:alert(1)', '', '   ', 'a example', 'http://'):
            self.assertEqual(server._clean_avail_domain(bad), '', bad)

    def test_base_normalized_and_empty_allowed(self):
        self.assertEqual(server._clean_avail_base('https://1lib.sk/x'), 'https://1lib.sk')
        self.assertEqual(server._clean_avail_base('  annas-archive.org  '), 'https://annas-archive.org')
        self.assertEqual(server._clean_avail_base(''), '')
        self.assertEqual(server._clean_avail_base('javascript:alert(1)'), '')

    def test_shipped_defaults_build_links(self):
        av = server.DEFAULT_CONFIG['availability']
        z, a = server._avail_links(av, '9787115428028', 'b' * 32)
        self.assertEqual(z, 'https://z-library.sk/s/9787115428028')
        self.assertEqual(a, 'https://annas-archive.gl/md5/' + 'b' * 32)

    def test_domains_dedup_and_fallback(self):
        with mock.patch.object(server, 'AVAILABILITY_LAST_GOOD', ''):
            cfg = {'availability': {'domains': ['https://a.example/', 'a.example', 'b.example']}}
            self.assertEqual(server._avail_domains(cfg), ['a.example', 'b.example'])
            self.assertEqual(server._avail_domains({'availability': {'domains': []}}),
                             server.DEFAULT_CONFIG['availability']['domains'])

    def test_last_good_moves_to_front(self):
        with mock.patch.object(server, 'AVAILABILITY_LAST_GOOD', 'b.example'):
            cfg = {'availability': {'domains': ['a.example', 'b.example']}}
            self.assertEqual(server._avail_domains(cfg), ['b.example', 'a.example'])


class Dummy:
    def __init__(self, loopback=True, body=None):
        self.loopback = loopback
        self._body = body
        self.out = None
        self.code = 200

    def is_loopback_req(self):
        return self.loopback

    def write_ok(self):
        return True

    def body(self, json_only=False):
        return self._body

    def json(self, obj, code=200):
        self.out = obj
        self.code = code


class ConfigApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shlib-avail-cfg-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfgpath = os.path.join(self.tmp, 'config.json')
        p = mock.patch.object(server, 'CONFIG_PATH', self.cfgpath)
        p.start()
        self.addCleanup(p.stop)

    def save(self, availability):
        h = Dummy(body={'availability': availability})
        server.Handler.api_save_config(h)
        return h

    def test_save_cleans_and_dedups(self):
        h = self.save({'enabled': True,
                       'domains': ['https://A.example/x', 'b.example', 'b.example'],
                       'proxy': '  http://127.0.0.1:10808  '})
        self.assertEqual(h.code, 200)
        cfg = server.load_config()['availability']
        self.assertTrue(cfg['enabled'])
        self.assertEqual(cfg['domains'], ['a.example', 'b.example'])
        self.assertEqual(cfg['proxy'], 'http://127.0.0.1:10808')

    def test_save_rejects_bad_domain(self):
        h = self.save({'domains': ['javascript:alert(1)']})
        self.assertEqual(h.code, 400)
        self.assertEqual(h.out['field'], 'availability')

    def test_save_rejects_empty_domains(self):
        h = self.save({'domains': []})
        self.assertEqual(h.code, 400)

    def test_save_rejects_non_bool_enabled(self):
        h = self.save({'enabled': 'yes'})
        self.assertEqual(h.code, 400)

    def test_old_config_gets_default_bases(self):
        # 老配置里没有这两个键：读配置时并上出厂默认，设置面板才能预填
        with open(self.cfgpath, 'w', encoding='utf-8') as f:
            json.dump({'doulist_url': 'https://example.invalid/doulist/example/'}, f)
        local = Dummy(loopback=True)
        server.Handler.api_config(local)
        self.assertEqual(local.out['availability']['zlibBase'], 'https://z-library.sk')
        self.assertEqual(local.out['availability']['annaBase'], 'https://annas-archive.gl')

    def test_save_normalizes_bases_and_allows_empty(self):
        h = self.save({'zlibBase': 'https://1lib.sk/book?x=1', 'annaBase': '  '})
        self.assertEqual(h.code, 200)
        cfg = server.load_config()['availability']
        self.assertEqual(cfg['zlibBase'], 'https://1lib.sk')
        self.assertEqual(cfg['annaBase'], '')

    def test_save_rejects_bad_base(self):
        h = self.save({'zlibBase': 'javascript:alert(1)'})
        self.assertEqual(h.code, 400)
        # 指到具体那一格，别笼统标在镜像域名上
        self.assertEqual(h.out['field'], 'availability.zlibBase')
        h = self.save({'annaBase': 'not a host'})
        self.assertEqual(h.code, 400)
        self.assertEqual(h.out['field'], 'availability.annaBase')

    def test_api_config_exposure_and_lan_hiding(self):
        self.save({'enabled': True, 'domains': ['a.example'], 'proxy': 'http://p',
                   'zlibBase': 'https://1lib.sk', 'annaBase': 'https://annas-archive.org'})
        local = Dummy(loopback=True)
        server.Handler.api_config(local)
        self.assertTrue(local.out['features']['availability'])
        self.assertTrue(local.out['availability']['enabled'])
        self.assertEqual(local.out['availability']['domains'], ['a.example'])
        self.assertEqual(local.out['availability']['proxy'], 'http://p')
        self.assertEqual(local.out['availability']['zlibBase'], 'https://1lib.sk')
        self.assertEqual(local.out['availability']['annaBase'], 'https://annas-archive.org')
        lan = Dummy(loopback=False)
        server.Handler.api_config(lan)
        self.assertTrue(lan.out['availability']['enabled'])
        self.assertEqual(lan.out['availability']['domains'], [])
        self.assertEqual(lan.out['availability']['proxy'], '')
        self.assertEqual(lan.out['availability']['zlibBase'], '')
        self.assertEqual(lan.out['availability']['annaBase'], '')


if __name__ == '__main__':
    unittest.main()