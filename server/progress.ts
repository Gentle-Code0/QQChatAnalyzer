import { randomUUID } from 'node:crypto';

export interface ProgressEvent {
  id: string;
  kind: 'ai' | 'tool';
  label: string;
  status: 'running' | 'completed';
  detail: string;
}
export type ProgressReporter = (event: ProgressEvent) => void;

/** Callers provide only application-owned labels/counts, never prompts, URLs or model text. */
export function beginProgress(
  report: ProgressReporter | undefined,
  kind: ProgressEvent['kind'],
  label: string,
  detail = '',
): (detail?: string) => void {
  const id = randomUUID();
  report?.({ id, kind, label, status: 'running', detail });
  return (result = detail) => report?.({ id, kind, label, status: 'completed', detail: result });
}
