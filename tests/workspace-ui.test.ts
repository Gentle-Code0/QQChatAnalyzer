import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workspace } from '../web/workspace.js';
import { SettingsForm } from '../web/forms.js';
import { decisionSchema, observationSchema, type Snapshot } from '../shared/schema.js';
import { fixture } from './helpers.js';

test('会话展示态度情绪及建议原因，移除内部摘要、采纳和冷却；设置提供独立节流项', () => {
  const data = fixture();
  try {
    const state: Snapshot = {
      self: data.store.self,
      contacts: [data.contact],
      conversations: [data.conversation],
      settings: data.store.settings,
      hasApiKey: false,
      hasQqToken: false,
      bridge: { connected: false, status: '未连接' },
    };
    for (const needed of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(Workspace, {
          state,
          contact: data.contact,
          conversation: { ...data.conversation, ...{ summary: '内部摘要占位内容' } },
          detail: {
            activity: [],
            messages: [],
            memories: [],
            observations: [
              observationSchema.parse({
                id: 'signal',
                conversationId: data.conversation.id,
                time: 1,
                attitude: 15,
                emotion: 10,
                mood: '平静',
                reason: '态度情绪变化的证据原因',
                relevant: true,
                significant: false,
              }),
            ],
            decisions: [
              decisionSchema.parse({
                id: 'decision',
                conversationId: data.conversation.id,
                time: 1,
                needed,
                reason: '是否生成建议的判断原因',
                advice: needed ? '确认见面安排' : '',
                trigger: '对话静默',
              }),
            ],
          },
          selectConversation: () => {},
          edit: () => {},
          action: async () => {},
        }),
      );
      assert.match(html, /态度情绪变化的证据原因/);
      assert.match(html, /是否生成建议的判断原因/);
      assert.equal(html.includes('内部摘要占位内容'), false);
      assert.equal(html.includes('当前对话摘要'), false);
      assert.equal(html.includes('已采用'), false);
      assert.equal(html.includes('冷却'), false);
      if (needed) assert.match(html, /确认见面安排/);
      else assert.match(html, /暂无需建议/);
    }
    const settings = renderToStaticMarkup(
      createElement(SettingsForm, { state, refresh: async () => {} }),
    );
    for (const label of [
      '摘要分析累计消息数',
      '摘要分析静默时间',
      '画像与记忆归纳累计消息数',
      '画像与记忆归纳静默时间',
    ])
      assert.ok(settings.includes(label));
    assert.equal(settings.includes('冷却'), false);
  } finally {
    data.cleanup();
  }
});
