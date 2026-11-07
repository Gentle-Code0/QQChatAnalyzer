import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Store } from '../server/store.js';
import { contactSchema, conversationSchema, type Message } from '../shared/schema.js';

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'chat-analyzer-test-'));
  const store = new Store(directory);
  const contact = contactSchema.parse({
    id: 'alice',
    name: 'Alice',
    qq: '12345',
    traits: {},
    createdAt: 1,
  });
  const conversation = conversationSchema.parse({
    id: 'conversation',
    contactId: contact.id,
    kind: 'private',
    peerId: contact.qq,
  });
  store.saveContact(contact);
  store.saveConversation(conversation);
  function cleanup() {
    store.close();
    const target = resolve(directory);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('chat-analyzer-test-')
    )
      throw new Error('测试目录越界');
    rmSync(target, { recursive: true, force: true });
  }
  function message(id: string, text = '周六见面好吗？'): Message {
    return {
      id,
      conversationId: conversation.id,
      senderId: contact.qq,
      senderName: 'Alice',
      text,
      time: Date.now(),
      sequence: 0,
      source: 'live',
      mentionedSelf: false,
    };
  }
  return { directory, store, contact, conversation, message, cleanup };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
