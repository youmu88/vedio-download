import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, normalizeHost, hasPrivateLiteral, assertPublicUrlLiteral } from '../src/security.js';

test('识别常见内网/回环地址', () => {
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('10.1.2.3'), true);
  assert.equal(isPrivateHost('192.168.1.1'), true);
  assert.equal(isPrivateHost('172.16.0.1'), true);
  assert.equal(isPrivateHost('172.32.0.1'), false);
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('::1'), true);
  assert.equal(isPrivateHost('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(isPrivateHost('example.com'), false);
});

test('normalizeHost 处理 IPv4-mapped IPv6', () => {
  assert.equal(normalizeHost('[::ffff:10.0.0.1]'), '10.0.0.1');
  assert.equal(normalizeHost('::ffff:192.168.0.1'), '192.168.0.1');
});

test('hasPrivateLiteral / assertPublicUrlLiteral', () => {
  assert.equal(hasPrivateLiteral('http://127.0.0.1/x.m3u8'), true);
  assert.equal(hasPrivateLiteral('https://example.com/x.m3u8'), false);
  assert.throws(() => assertPublicUrlLiteral('http://10.0.0.1/x'));
  assert.throws(() => assertPublicUrlLiteral('ftp://example.com/x'));
  assert.doesNotThrow(() => assertPublicUrlLiteral('https://example.com/x'));
});
