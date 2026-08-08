import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u8 } from '../src/js-downloader.js';

test('解析 master playlist 的 variant 列表', () => {
  const content = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360',
    '360/index.m3u8',
  ].join('\n');
  const parsed = parseM3u8(content, 'https://cdn.example.com/live/main.m3u8');
  assert.equal(parsed.isMaster, true);
  assert.equal(parsed.variants.length, 2);
  assert.equal(parsed.variants[0].bandwidth, 3000000);
  assert.equal(parsed.variants[0].resolution, '1280x720');
  assert.equal(parsed.variants[0].url, 'https://cdn.example.com/live/720/index.m3u8');
  assert.equal(parsed.segments.length, 0);
});

test('解析普通 playlist 的分片与相对路径', () => {
  const content = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:10,',
    'seg1.ts',
    '#EXTINF:10,',
    'https://other.example.com/seg2.ts',
  ].join('\n');
  const parsed = parseM3u8(content, 'https://cdn.example.com/live/720/index.m3u8');
  assert.equal(parsed.isMaster, false);
  assert.deepEqual(parsed.segments, [
    'https://cdn.example.com/live/720/seg1.ts',
    'https://other.example.com/seg2.ts',
  ]);
});

test('解析 AES-128 加密信息与 fMP4 init segment', () => {
  const content = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'frag1.m4s',
  ].join('\n');
  const parsed = parseM3u8(content, 'https://cdn.example.com/video/master.m3u8');
  assert.equal(parsed.encKeys.length, 1);
  assert.equal(parsed.encKeys[0].method, 'AES-128');
  assert.equal(parsed.encKeys[0].keyUri, 'https://cdn.example.com/video/key.bin');
  assert.equal(parsed.encKeys[0].ivHex, '00000000000000000000000000000001');
  assert.equal(parsed.mapUri, 'https://cdn.example.com/video/init.mp4');
  assert.equal(parsed.segments.length, 1);
});
