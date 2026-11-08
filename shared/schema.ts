import { z } from 'zod';

export const selfProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).default('我'),
  aliases: z.array(z.string().min(1).max(80)).max(30).default([]),
  personality: z.string().max(2000).default(''),
  style: z.string().max(2000).default(''),
});
export const traitsSchema = z.object({
  likes: z.string().max(4000).default(''),
  boundaries: z.string().max(4000).default(''),
  communication: z.string().max(4000).default(''),
});
export const genderSchema = z.enum(['未填写', '男', '女', '其他']);
export const contactInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  qq: z.string().regex(/^\d{5,15}$/),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  bio: z.string().max(4000).default(''),
  gender: genderSchema.default('未填写'),
  traits: traitsSchema.default({}),
  groupIds: z
    .array(z.string().regex(/^\d{5,15}$/))
    .max(50)
    .default([]),
});
export const contactSchema = contactInputSchema.extend({
  id: z.string(),
  paused: z.boolean().default(false),
  traitsRevision: z.number().int().default(0),
  createdAt: z.number(),
  historyStatus: z.string().default('待导入'),
  historyCount: z.number().default(0),
  historyCursor: z.number().int().default(0),
  historyDone: z.boolean().default(false),
});
export const conversationSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  kind: z.enum(['private', 'group']),
  peerId: z.string(),
  paused: z.boolean().default(false),
  summary: z.string().default(''),
  processedSequence: z.number().default(0),
  lastDecisionSequence: z.number().default(0),
  consolidatedSequence: z.number().default(0),
  lastMessageAt: z.number().default(0),
  adoptedUntil: z.number().default(0),
  status: z.string().default('等待消息'),
  error: z.string().default(''),
});
export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderId: z.string(),
  senderName: z.string(),
  text: z.string().max(20000),
  time: z.number(),
  sequence: z.number().default(0),
  source: z.enum(['live', 'history']),
  mentionedSelf: z.boolean().default(false),
});
export const memorySchema = z.object({
  id: z.string(),
  contactId: z.string(),
  kind: z.enum(['event', 'promise', 'relationship', 'emotion']),
  text: z.string().max(2000),
  time: z.number(),
  createdAt: z.number(),
  sourceIds: z.array(z.string()).max(100),
  keywords: z.array(z.string()).max(20),
});
export const observationSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  time: z.number(),
  attitude: z.number().min(-100).max(100),
  emotion: z.number().min(-100).max(100),
  mood: z.string().max(300),
  reason: z.string().max(2000),
  relevant: z.boolean(),
  significant: z.boolean(),
  sourceIds: z.array(z.string()).default([]),
});
export const decisionSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  time: z.number(),
  needed: z.boolean(),
  reason: z.string(),
  advice: z.string(),
  adopted: z.boolean().default(false),
  trigger: z.string(),
  memoryIds: z.array(z.string()).default([]),
});
export const settingsSchema = z.object({
  baseUrl: z.string().max(500).default('https://api.openai.com/v1'),
  lightModel: z.string().trim().min(1).max(100).default('gpt-4o-mini'),
  fullModel: z.string().trim().min(1).max(100).default('gpt-4o'),
  qqUrl: z.string().max(500).default(''),
  selfQq: z
    .string()
    .regex(/^$|^\d{5,15}$/)
    .default(''),
  messageThreshold: z.number().int().min(2).max(200).default(20),
  mergeWindowSeconds: z.number().min(0.1).max(60).default(3),
  idleSeconds: z.number().int().min(5).max(600).default(15),
  cooldownMinutes: z.number().int().min(1).max(1440).default(1),
  historyPages: z.number().int().min(1).max(200).default(20),
});
export type SelfProfile = z.infer<typeof selfProfileSchema>;
export type Contact = z.infer<typeof contactSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Memory = z.infer<typeof memorySchema>;
export type Observation = z.infer<typeof observationSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export interface Snapshot {
  self: SelfProfile;
  contacts: Contact[];
  conversations: Conversation[];
  settings: Settings;
  hasApiKey: boolean;
  hasQqToken: boolean;
  bridge: { connected: boolean; status: string };
}
export interface ConversationDetail {
  messages: Message[];
  memories: Memory[];
  observations: Observation[];
  decisions: Decision[];
}
