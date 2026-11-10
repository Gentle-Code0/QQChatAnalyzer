import {
  analysisContextLimits,
  type Message,
  type Memory,
  type Observation,
  type Contact,
} from '../shared/schema.js';

/** Character budgets bound text, not tokens; images keep the existing multimodal path. */
export function compactText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit < 3) return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
  const head = Math.ceil((limit - 1) / 2);
  const prefix = text.slice(0, head).replace(/[\uD800-\uDBFF]$/u, '');
  const suffix = text.slice(-(limit - head - 1)).replace(/^[\uDC00-\uDFFF]/u, '');
  return `${prefix}…${suffix}`;
}

const commonTerms = new Set([
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '什么',
  '怎么',
  '可以',
  '就是',
  '还是',
  '一下',
  '没有',
  '不是',
  '知道',
  '觉得',
  '时候',
  '然后',
  '因为',
  '所以',
]);
function terms(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of text.toLocaleLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) ?? []) {
    if (/^[a-z0-9_]+$/.test(word)) result.add(word);
    else
      for (let index = 0; index < word.length - 1; index++) {
        const term = word.slice(index, index + 2);
        if (!commonTerms.has(term)) result.add(term);
      }
  }
  return result;
}
function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const term of left) if (right.has(term)) count++;
  return count;
}
function messageText(message: Message): string {
  return [
    message.text,
    ...(message.segments ?? []).flatMap((segment) =>
      segment.type === 'text' ? [segment.text] : [],
    ),
  ].join('\n');
}

/** Text excerpts retain original IDs, speakers, time, segment order and every selected image. */
export function excerptMessage(message: Message, limit: number): Message {
  let remaining = limit;
  return {
    ...message,
    text: compactText(message.text, limit),
    segments: message.segments?.map((segment) => {
      if (segment.type === 'image') return segment;
      const text = compactText(segment.text, remaining);
      remaining = Math.max(0, remaining - text.length);
      return { ...segment, text };
    }),
  };
}

export function selectBridgeMessages(
  previous: Message[],
  pending: Message[],
  participantIds: string[],
): Message[] {
  const first = pending[0];
  if (!first) return [];
  const opening = pending.slice(0, 2).map(messageText).join('\n');
  const openingTerms = terms(opening);
  const dependent =
    /^(可以|好的?|行|嗯|对|是的|不是|没事|那|这|它|还是|就按|不用|不行|不了|谢谢)|上次|刚才|之前/u.test(
      first.text.trim(),
    );
  const candidates = previous.filter(
    (message) => participantIds.includes(message.senderId) && message.time <= first.time,
  );
  const nearest = candidates.at(-1);
  const ranked = candidates
    .map((message) => {
      const shared = overlap(terms(messageText(message)), openingTerms);
      const adjacent = first.time - message.time <= 30 * 60000;
      const question = /[?？]|是否|要不要|好吗|几点|哪里/u.test(messageText(message));
      const score =
        shared * 2 +
        (dependent && adjacent && message === nearest ? 4 : 0) +
        (dependent && adjacent && question ? 3 : 0);
      return { message, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.message.sequence - a.message.sequence);
  return ranked
    .slice(0, analysisContextLimits.bridgeMessages)
    .map((item) => item.message)
    .sort((a, b) => a.sequence - b.sequence)
    .map((message) => excerptMessage(message, analysisContextLimits.bridgeMessageCharacters));
}

export function selectDecisionEvidence(
  messages: Message[],
  observations: Observation[],
  participantIds: string[],
): Message[] {
  const evidenceIds = new Set(
    observations
      .filter((item) => item.significant && item.relevant)
      .flatMap((item) => item.sourceIds),
  );
  return messages
    .map((message, index) => ({
      message,
      index,
      score:
        (evidenceIds.has(message.id) ? 1000 : 0) +
        (participantIds.includes(message.senderId) ? 300 : 0) +
        index,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, analysisContextLimits.decisionEvidenceMessages)
    .sort((a, b) => a.index - b.index)
    .map((item) => excerptMessage(item.message, analysisContextLimits.decisionMessageCharacters));
}

export function compactSignals(observations: Observation[]) {
  const current = observations.at(-1);
  if (!current) return undefined;
  const previous = observations.at(-2);
  return {
    time: current.time,
    attitude: current.attitude,
    emotion: current.emotion,
    attitudeChange: previous ? current.attitude - previous.attitude : null,
    emotionChange: previous ? current.emotion - previous.emotion : null,
    mood: compactText(current.mood, 80),
    reason: compactText(current.reason, 300),
    relevant: current.relevant,
    significant: current.significant,
    recent: observations.slice(-3).map(({ time, attitude, emotion, significant }) => ({
      time,
      attitude,
      emotion,
      significant,
    })),
  };
}

export function selectDuplicateMemories(
  memories: Memory[],
  messages: Message[],
  contactId: string,
): Memory[] {
  const text = messages.map(messageText).join('\n').toLocaleLowerCase();
  const batchTerms = terms(text);
  const sourceIds = new Set(messages.map((message) => message.id));
  const ranked = memories
    .filter((memory) => memory.contactId === contactId)
    .map((memory) => ({
      memory,
      score: memory.sourceIds.some((id) => sourceIds.has(id))
        ? 10000
        : overlap(terms(memory.text), batchTerms) +
          memory.keywords.filter(
            (keyword) => keyword.trim().length >= 2 && text.includes(keyword.toLocaleLowerCase()),
          ).length *
            4,
    }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score || b.memory.time - a.memory.time);
  let remaining = analysisContextLimits.duplicateMemoryCharacters;
  return ranked
    .filter(({ memory }) => {
      if (memory.text.length > remaining) return false;
      remaining -= memory.text.length;
      return true;
    })
    .slice(0, analysisContextLimits.duplicateMemories)
    .map((item) => item.memory);
}

const traitCues = {
  likes: /喜欢|爱好|偏好|讨厌|不爱|不喜欢|最爱|兴趣|爱吃/u,
  boundaries: /拒绝|边界|忌讳|不要|别再|不许|不愿|不能接受|介意|隐私/u,
  communication: /沟通|表达|回复|回应|语气|直说|直接|聊天|联系|沉默|打扰/u,
};
export function selectRelatedTraits(
  traits: Contact['traits'],
  messages: Message[],
): Partial<Contact['traits']> {
  const text = messages.map(messageText).join('\n');
  const batchTerms = terms(text);
  const result: Partial<Contact['traits']> = {};
  for (const field of ['likes', 'boundaries', 'communication'] as const) {
    // Include empty fields so genuinely new, evidenced traits can be introduced.
    if (
      !traits[field] ||
      traitCues[field].test(text) ||
      overlap(terms(traits[field]), batchTerms) >= 2
    )
      result[field] = traits[field];
  }
  return result;
}
