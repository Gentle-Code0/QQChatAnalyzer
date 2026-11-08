import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityPanel } from '../web/activity.js';
import { analysisRunSchema } from '../shared/schema.js';

test('状态栏可展开，显示当前步骤、工具状态和耗时；无记录及暂停状态明确', () => {
  const run = analysisRunSchema.parse({
    id: 'run',
    trigger: '手动检查',
    status: 'running',
    detail: '',
    startedAt: 1000,
    steps: [
      {
        id: 'step',
        kind: 'tool',
        label: 'get_image · 读取图片地址',
        status: 'running',
        detail: '',
        startedAt: 1200,
      },
    ],
  });
  const html = renderToStaticMarkup(createElement(ActivityPanel, { runs: [run], paused: false }));
  assert.match(html, /<details/);
  assert.match(html, /<summary/);
  assert.match(html, /AI 调用状态/);
  assert.match(html, /get_image · 读取图片地址/);
  assert.match(html, /执行中/);
  assert.match(html, /工具/);
  assert.match(html, /秒/);
  assert.match(
    renderToStaticMarkup(createElement(ActivityPanel, { runs: [], paused: false })),
    /暂无执行记录/,
  );
  assert.match(
    renderToStaticMarkup(createElement(ActivityPanel, { runs: [run], paused: true })),
    /已暂停/,
  );
});
