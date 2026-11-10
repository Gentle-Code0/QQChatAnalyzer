import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import {
  contactSchema,
  conversationSchema,
  messageSchema,
  memorySchema,
  observationSchema,
  decisionSchema,
  selfProfileSchema,
  settingsSchema,
  type Contact,
  type Conversation,
  type Message,
  type Memory,
  type Observation,
  type Decision,
} from '../shared/schema.js';

/** Single process owns SQLite and the encryption key; WAL makes backups/readers practical. */
export class Store {
  private readonly database: DatabaseSync;
  private readonly encryptionKey: Buffer;
  private closed = false;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'master.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.encryptionKey = readFileSync(keyPath);
    if (this.encryptionKey.length !== 32) throw new Error('加密主密钥长度无效');
    this.database = new DatabaseSync(join(directory, 'chat.sqlite'));
    this.database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL, time REAL NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS messages_time ON messages(conversation_id,time);
      CREATE INDEX IF NOT EXISTS records_conversation ON records(kind,json_extract(data,'$.conversationId'));
      CREATE INDEX IF NOT EXISTS records_contact ON records(kind,json_extract(data,'$.contactId'));`);
  }

  private read<T, Input>(
    kind: string,
    id: string,
    schema: z.ZodType<T, z.ZodTypeDef, Input>,
  ): T | undefined {
    const row = this.database
      .prepare('SELECT data FROM records WHERE kind=? AND id=?')
      .get(kind, id);
    return row ? schema.parse(JSON.parse(String(row.data))) : undefined;
  }
  private list<T, Input>(kind: string, schema: z.ZodType<T, z.ZodTypeDef, Input>): T[] {
    return this.database
      .prepare('SELECT data FROM records WHERE kind=?')
      .all(kind)
      .map((row) => schema.parse(JSON.parse(String(row.data))));
  }
  private write(kind: string, id: string, value: unknown): void {
    this.database
      .prepare(
        'INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(kind, id, JSON.stringify(value));
  }
  get self() {
    return this.read('config', 'self', selfProfileSchema) ?? selfProfileSchema.parse({});
  }
  set self(value) {
    this.write('config', 'self', selfProfileSchema.parse(value));
  }
  get settings() {
    return this.read('config', 'settings', settingsSchema) ?? settingsSchema.parse({});
  }
  set settings(value) {
    this.write('config', 'settings', settingsSchema.parse(value));
  }
  contacts(): Contact[] {
    return this.list('contact', contactSchema);
  }
  contact(id: string): Contact | undefined {
    return this.read('contact', id, contactSchema);
  }
  saveContact(value: Contact): void {
    this.write('contact', value.id, contactSchema.parse(value));
  }
  conversations(): Conversation[] {
    return this.list('conversation', conversationSchema);
  }
  conversation(id: string): Conversation | undefined {
    return this.read('conversation', id, conversationSchema);
  }
  saveConversation(value: Conversation): void {
    this.write('conversation', value.id, conversationSchema.parse(value));
  }
  memories(contactId: string): Memory[] {
    return this.database
      .prepare(
        "SELECT data FROM records WHERE kind='memory' AND json_extract(data,'$.contactId')=?",
      )
      .all(contactId)
      .map((row) => memorySchema.parse(JSON.parse(String(row.data))));
  }
  saveMemory(value: Memory): void {
    this.write('memory', value.id, memorySchema.parse(value));
  }
  observations(conversationId: string): Observation[] {
    return this.database
      .prepare(
        "SELECT data FROM records WHERE kind='observation' AND json_extract(data,'$.conversationId')=? ORDER BY rowid DESC LIMIT 200",
      )
      .all(conversationId)
      .reverse()
      .map((row) => observationSchema.parse(JSON.parse(String(row.data))));
  }
  saveObservation(value: Observation): void {
    this.write('observation', value.id, observationSchema.parse(value));
  }
  decisions(conversationId: string): Decision[] {
    return this.database
      .prepare(
        "SELECT data FROM records WHERE kind='decision' AND json_extract(data,'$.conversationId')=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(conversationId)
      .reverse()
      .map((row) => decisionSchema.parse(JSON.parse(String(row.data))));
  }
  saveDecision(value: Decision): void {
    this.write('decision', value.id, decisionSchema.parse(value));
  }

  /** A provider message can legitimately belong to multiple object dossiers (group context). */
  addMessage(value: Message): boolean {
    const result = this.database
      .prepare('INSERT OR IGNORE INTO messages(id,conversation_id,time,data) VALUES(?,?,?,?)')
      .run(
        `${value.conversationId}:${value.id}`,
        value.conversationId,
        value.time,
        JSON.stringify(value),
      );
    return result.changes > 0;
  }
  messages(
    conversationId: string,
    afterSequence = 0,
    limit = 200,
    chronological = false,
  ): Message[] {
    const rows = chronological
      ? this.database
          .prepare(
            'SELECT sequence,data FROM messages WHERE conversation_id=? AND sequence>? ORDER BY time,sequence LIMIT ?',
          )
          .all(conversationId, afterSequence, limit)
      : this.database
          .prepare(
            'SELECT sequence,data FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence DESC LIMIT ?',
          )
          .all(conversationId, afterSequence, limit)
          .reverse();
    return rows.map((row) =>
      messageSchema.parse({ ...JSON.parse(String(row.data)), sequence: Number(row.sequence) }),
    );
  }
  /** Display the newest messages by send time; ingestion sequence remains an analysis checkpoint. */
  recentMessages(conversationId: string, limit = 200): Message[] {
    return this.database
      .prepare(
        'SELECT sequence,data FROM messages WHERE conversation_id=? ORDER BY time DESC,sequence DESC LIMIT ?',
      )
      .all(conversationId, limit)
      .reverse()
      .map((row) =>
        messageSchema.parse({ ...JSON.parse(String(row.data)), sequence: Number(row.sequence) }),
      );
  }
  pendingMessages(conversationId: string, afterSequence: number): Message[] {
    return this.database
      .prepare(
        'SELECT sequence,data FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 60',
      )
      .all(conversationId, afterSequence)
      .map((row) =>
        messageSchema.parse({ ...JSON.parse(String(row.data)), sequence: Number(row.sequence) }),
      );
  }
  pendingMessageCount(conversationId: string, afterSequence: number, liveOnly = false): number {
    const row = this.database
      .prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND sequence>?' +
          (liveOnly ? " AND json_extract(data, '$.source')='live'" : ''),
      )
      .get(conversationId, afterSequence);
    return Number(row?.count ?? 0);
  }
  messageCount(conversationId: string): number {
    return Number(
      this.database
        .prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?')
        .get(conversationId)?.count ?? 0,
    );
  }
  setSecret(name: 'apiKey' | 'qqToken', plainText: string): void {
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, initializationVector);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    this.write(
      'secret',
      name,
      Buffer.concat([initializationVector, cipher.getAuthTag(), encrypted]).toString('base64'),
    );
  }
  secret(name: 'apiKey' | 'qqToken'): string {
    const encoded = this.read('secret', name, z.string());
    if (!encoded) return '';
    const encrypted = Buffer.from(encoded, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(12, 28));
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
