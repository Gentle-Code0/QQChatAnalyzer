import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ImageAnalysisCache, imageCachePolicy } from '../server/image-cache.js';
import { fixture } from './helpers.js';
import { Store } from '../server/store.js';

const analysis = {
  sha256: 'a'.repeat(64),
  description: '测试图片内容',
  limitations: '',
  scope: 'static' as const,
  model: 'invalid-test-model',
};
test('分析缓存跨重启保留并按账号隔离，同一 QQ 标识仅作为候选', () => {
  const data = fixture();
  try {
    data.store.imageCache.save('12345', analysis, 100, 'occurrence', 'qq-file');
    const reopened = new Store(data.directory);
    try {
      assert.deepEqual(reopened.imageCache.get('12345', analysis.sha256, 101), analysis);
      assert.equal(reopened.imageCache.get('other', analysis.sha256, 101), undefined);
      assert.equal(reopened.imageCache.candidate('12345', 'qq-file'), analysis.sha256);
      assert.equal(reopened.imageCache.occurrence('12345', 'occurrence'), analysis.sha256);
    } finally {
      reopened.close();
    }
  } finally {
    data.cleanup();
  }
});
test('30 天未使用的结果及全部索引自动过期，使用会刷新保留时间', () => {
  const database = new DatabaseSync(':memory:');
  const cache = new ImageAnalysisCache(database);
  try {
    cache.save('12345', analysis, 0, 'occurrence', 'qq-file');
    assert.ok(cache.get('12345', analysis.sha256, imageCachePolicy.maxIdleMs - 1));
    cache.prune(imageCachePolicy.maxIdleMs);
    assert.ok(cache.get('12345', analysis.sha256, imageCachePolicy.maxIdleMs));
    cache.prune(imageCachePolicy.maxIdleMs * 2);
    assert.equal(cache.get('12345', analysis.sha256, imageCachePolicy.maxIdleMs * 2), undefined);
    assert.equal(cache.candidate('12345', 'qq-file'), undefined);
    assert.equal(cache.occurrence('12345', 'occurrence'), undefined);
    assert.equal(cache.size(), 0);
  } finally {
    database.close();
  }
});
test('总结果和索引的 UTF-8 字节上限按最近使用时间淘汰，支持单条超过容量', () => {
  const database = new DatabaseSync(':memory:');
  const cache = new ImageAnalysisCache(database, { ...imageCachePolicy, maxBytes: 1100 });
  try {
    const second = { ...analysis, sha256: 'b'.repeat(64) };
    const third = { ...analysis, sha256: 'c'.repeat(64) };
    cache.save('12345', analysis, 1, 'one', 'one');
    cache.save('12345', second, 2, 'two', 'two');
    assert.ok(cache.get('12345', analysis.sha256, 3));
    cache.save('12345', third, 4, 'three', 'three');
    assert.ok(cache.size() <= 1100);
    assert.equal(cache.get('12345', second.sha256, 5), undefined);
    assert.ok(cache.get('12345', analysis.sha256, 5));
    cache.save('12345', { ...third, description: '测'.repeat(1000) }, 6, 'three', 'three');
    assert.ok(cache.size() <= 1100);
    assert.equal(cache.get('12345', third.sha256, 7), undefined);
  } finally {
    database.close();
  }
});
