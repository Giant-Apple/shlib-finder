"""借书单的离线单测：不联网、不碰真实 data/。

钉住几条口径：
- 只有「书名 + 分馆」是必需的，缺一条整条丢掉；
- 同一本 + 同一馆只留一条，索书号/库室去重并限长；
- 保存后原样读回；文件坏了也不能把整站拖崩；
- 分享只认「开关开着 + 真的在监听局域网」，二维码指向 #borrow；
- 局域网没开时不给地址和码。
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


def item(**kw):
    d = {
        'id': 'b1',
        'bookKey': 'i:9787302685821',
        'title': '置身事内',
        'author': '兰小欢',
        'isbn': '9787302685821',
        'branchKey': '上海图书馆',
        'branch': '上海图书馆',
        'callnos': ['F124/9099'],
        'rooms': ['综合阅览室'],
        'address': '淮海中路1555号',
        'tel': '021-64455555',
        'lat': 31.2,
        'lng': 121.44,
        'addedAt': 1700000000000,
    }
    d.update(kw)
    return d


class CleanTest(unittest.TestCase):
    def test_requires_title_and_branch(self):
        out = server.clean_borrow_items([
            item(),
            item(branch=''),
            item(title='  '),
            'not a dict',
        ])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['title'], '置身事内')

    def test_trims_and_caps(self):
        out = server.clean_borrow_items([item(
            title='  书名  ',
            callnos=[' A ', 'A', 'B', ''],
            rooms=[' R ', 'R', ''],
            author=' 作者 ',
        )])
        self.assertEqual(out[0]['title'], '书名')
        self.assertEqual(out[0]['author'], '作者')
        self.assertEqual(out[0]['callnos'], ['A', 'B'])
        self.assertEqual(out[0]['rooms'], ['R'])

    def test_caps_count_and_list_lengths(self):
        many = [item(id='b%d' % i, title='书 %d' % i, bookKey='i:%d' % i)
                for i in range(server.BORROW_MAX + 20)]
        self.assertEqual(len(server.clean_borrow_items(many)), server.BORROW_MAX)
        out = server.clean_borrow_items([item(
            callnos=['c%d' % i for i in range(30)],
            rooms=['r%d' % i for i in range(30)],
        )])
        self.assertEqual(len(out[0]['callnos']), 12)
        self.assertEqual(len(out[0]['rooms']), 12)
        self.assertLessEqual(len(server.clean_borrow_items([item(title='x' * 500)])[0]['title']), 200)

    def test_same_book_same_branch_only_once(self):
        out = server.clean_borrow_items([item(), item(id='b2'),
                                         item(branch='别的馆', branchKey='别的馆')])
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]['id'], 'b1')
        self.assertEqual(out[1]['branch'], '别的馆')

    def test_fills_missing_keys_and_id(self):
        out = server.clean_borrow_items([item(id='', bookKey='', branchKey='', isbn='9787')])
        self.assertTrue(out[0]['id'])
        self.assertEqual(out[0]['bookKey'], '9787')
        self.assertEqual(out[0]['branchKey'], '上海图书馆')

    def test_bad_coords_dropped(self):
        out = server.clean_borrow_items([item(lat='x', lng=float('nan'), addedAt='bad')])
        self.assertIsNone(out[0]['lat'])
        self.assertIsNone(out[0]['lng'])
        self.assertEqual(out[0]['addedAt'], 0)
        ok = server.clean_borrow_items([item(addedAt=1700000000000)])
        self.assertEqual(ok[0]['addedAt'], 1700000000000)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shlib-borrow-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = os.path.join(self.tmp, 'borrow.json')
        p = mock.patch.object(server, 'BORROW_PATH', self.path)
        p.start()
        self.addCleanup(p.stop)

    def test_save_load_roundtrip(self):
        data = server.save_borrow([item()])
        self.assertTrue(os.path.exists(self.path))
        self.assertGreater(data['updatedAt'], 0)
        again = server.load_borrow()
        self.assertEqual(len(again['items']), 1)
        self.assertEqual(again['items'][0]['title'], '置身事内')
        self.assertEqual(again['updatedAt'], data['updatedAt'])

    def test_broken_file_returns_empty(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('{not json')
        self.assertEqual(server.load_borrow()['items'], [])

    def test_overwrites_previous_list(self):
        server.save_borrow([item(id='a', title='A')])
        server.save_borrow([item(id='b', title='B')])
        got = server.load_borrow()['items']
        self.assertEqual([x['title'] for x in got], ['B'])


class ShareTest(unittest.TestCase):
    def setUp(self):
        self.cfg = mock.patch.object(server, 'load_config', return_value={'lan': False})
        self.cfg.start()
        self.addCleanup(self.cfg.stop)
        for name, val in (('LAN_BOUND', False), ('LISTEN_LOCAL', False),
                          ('BORROW_LAN', {'url': '', 'qr': ''})):
            p = mock.patch.object(server, name, val)
            p.start()
            self.addCleanup(p.stop)

    def test_off_when_lan_disabled(self):
        info = server.borrow_share()
        self.assertFalse(info['on'])
        self.assertFalse(info['enabled'])
        self.assertEqual(info['url'], '')

    def test_enabled_but_not_bound(self):
        with mock.patch.object(server, 'load_config', return_value={'lan': True}):
            info = server.borrow_share()
        self.assertFalse(info['on'])
        self.assertTrue(info['enabled'])

    def test_url_points_to_borrow_hash(self):
        # setUp 里 BORROW_LAN 被替换成普通 dict，qr_svg 真跑一次（vendor 里的 qrcode）
        with mock.patch.object(server, 'load_config', return_value={'lan': True}), \
                mock.patch.object(server, 'LAN_BOUND', True), \
                mock.patch.object(server, 'lan_ip', return_value='192.168.1.5'):
            info = server.borrow_share()
        self.assertTrue(info['on'])
        self.assertEqual(info['url'], 'http://192.168.1.5:%d/#borrow' % server.PORT)
        self.assertIn('<svg', info['qr'])
        # 第二次走缓存，不再重复画码
        with mock.patch.object(server, 'load_config', return_value={'lan': True}), \
                mock.patch.object(server, 'LAN_BOUND', True), \
                mock.patch.object(server, 'lan_ip', return_value='192.168.1.5'), \
                mock.patch.object(server, 'qr_svg', side_effect=AssertionError('不该重画')):
            again = server.borrow_share()
        self.assertEqual(again['url'], info['url'])
        self.assertEqual(again['qr'], info['qr'])

    def test_missing_lan_ip(self):
        with mock.patch.object(server, 'load_config', return_value={'lan': True}), \
                mock.patch.object(server, 'LAN_BOUND', True), \
                mock.patch.object(server, 'lan_ip', side_effect=OSError('no route')):
            info = server.borrow_share()
        self.assertFalse(info['on'])
        self.assertTrue(info.get('error'))


if __name__ == '__main__':
    unittest.main()
