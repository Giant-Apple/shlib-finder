"""版本更新检测：语义化版本比较、GitHub API 与静态 version.json 的降级、缓存语义。

本地服务是唯一会往外看的地方：页面点「检查更新」→ POST /api/update-check。
这里钉住三件事：版本号按数字比较（0.10 > 0.9）、API 不通时退到静态文件、
查不到时如实报失败而不是说「已是最新」。
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web'))
import server  # noqa: E402


class SemverTest(unittest.TestCase):
    def test_compare_is_numeric(self):
        self.assertTrue(server._newer('0.10.0', '0.9.0'))
        self.assertTrue(server._newer('v1.2.3', '1.2.2'))
        self.assertFalse(server._newer('1.0.0', '1.0.0'))
        self.assertFalse(server._newer('0.9.0', '0.10.0'))

    def test_bad_tags_are_not_newer(self):
        for bad in ('', 'latest', '2.0', 'x.y.z'):
            self.assertIsNone(server.parse_semver(bad))
            self.assertFalse(server._newer(bad, '1.0.0'))


class UpdateCheckTest(unittest.TestCase):
    def setUp(self):
        state = {'at': 0.0, 'result': None}
        self.state = mock.patch.object(server, 'UPDATE_STATE', state)
        self.state.start()
        self.addCleanup(self.state.stop)

    def test_peek_never_calls_network(self):
        with mock.patch.object(server, 'http_get', side_effect=AssertionError('不该联网')):
            out = server.update_peek()
        self.assertTrue(out['never'])
        self.assertEqual(out['current'], server.VERSION)

    def test_release_api_wins(self):
        body = '{"tag_name": "v9.9.9", "html_url": "https://example/r"}'
        with mock.patch.object(server, 'http_get', return_value=body):
            out = server.update_check()
        self.assertEqual(out['latest'], '9.9.9')
        self.assertTrue(out['newer'])
        self.assertEqual(out['url'], 'https://example/r')
        self.assertFalse(out['failed'])

    def test_falls_back_to_static_version_json(self):
        def get(url, timeout=20, headers=None):
            if url == server.UPDATE_API:
                raise OSError('api blocked')
            return '{"version": "9.9.9"}'
        with mock.patch.object(server, 'http_get', side_effect=get):
            out = server.update_check()
        self.assertEqual(out['latest'], '9.9.9')
        self.assertTrue(out['newer'])

    def test_failure_is_not_reported_as_up_to_date(self):
        with mock.patch.object(server, 'http_get', side_effect=OSError('offline')):
            out = server.update_check()
        self.assertTrue(out['failed'])
        self.assertEqual(out['latest'], '')
        self.assertFalse(out['newer'])

    def test_failed_check_keeps_previous_cache(self):
        good = {'current': '0.0.1', 'latest': '9.9.9', 'url': 'u',
                'newer': True, 'failed': False, 'checkedAt': '2026-01-01 00:00'}
        server.UPDATE_STATE['result'] = good
        with mock.patch.object(server, 'http_get', side_effect=OSError('offline')):
            server.update_check()
        self.assertEqual(server.UPDATE_STATE['result'], good)
        self.assertEqual(server.update_peek()['latest'], '9.9.9')


if __name__ == '__main__':
    unittest.main()
