import type { ActivityStep, AnalysisRun } from '../shared/schema';
import { formatTime } from './api';

const statuses = {
  waiting: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
};
const kinds = { ai: 'AI', tool: '工具', storage: '保存', schedule: '调度' };
function elapsed(start: number, end = Date.now()): string {
  return `${Math.max(0, (end - start) / 1000).toFixed(1)} 秒`;
}
function Step({ step }: { step: ActivityStep }) {
  return (
    <li className={`activity-step activity-${step.status}`}>
      <span className="activity-dot" aria-hidden="true" />
      <div className="activity-step-body">
        <div className="activity-step-heading">
          <span className="activity-kind">{kinds[step.kind]}</span>
          <strong>{step.label}</strong>
          <span className="activity-state">{statuses[step.status]}</span>
          <time dateTime={new Date(step.startedAt).toISOString()}>
            {formatTime(step.startedAt)}
          </time>
          <span className="muted">{elapsed(step.startedAt, step.finishedAt)}</span>
        </div>
        {step.detail && <p>{step.detail}</p>}
      </div>
    </li>
  );
}
export function ActivityPanel({ runs, paused }: { runs: AnalysisRun[]; paused: boolean }) {
  const latest = runs.at(-1);
  const current = [...(latest?.steps ?? [])].reverse().find((step) => step.status === 'running');
  return (
    <details className="panel activity-panel">
      <summary>
        <span className="activity-title">AI 调用状态</span>
        <span
          className={`activity-badge activity-${paused ? 'cancelled' : (latest?.status ?? 'waiting')}`}
          role="status"
        >
          {paused ? '已暂停' : latest ? statuses[latest.status] : '等待分析'}
        </span>
        <span className="activity-current">
          {current?.label ?? latest?.detail ?? '下一次分析后显示执行步骤'}
        </span>
        {latest && (
          <span className="muted activity-total">
            {elapsed(latest.startedAt, latest.finishedAt)}
          </span>
        )}
        <span className="activity-expand">展开执行记录</span>
      </summary>
      <div className="activity-content">
        <p className="muted small">
          当前会话最近 5 轮任务，每轮最多显示最近 80 个步骤，约每 2
          秒刷新。记录应用执行进度，包含实际工具调用；重启后清空。
        </p>
        {runs.length === 0 && (
          <p className="muted">暂无执行记录。收到新消息或点击“重新检查”后，将在这里显示进度。</p>
        )}
        {[...runs].reverse().map((run, index) => (
          <details className="activity-run" key={run.id} open={index === 0}>
            <summary>
              <strong>{run.trigger}</strong>
              <span className={`activity-badge activity-${run.status}`}>
                {statuses[run.status]}
              </span>
              <time dateTime={new Date(run.startedAt).toISOString()}>
                {formatTime(run.startedAt)}
              </time>
              <span className="muted">{elapsed(run.startedAt, run.finishedAt)}</span>
            </summary>
            {run.detail && <p className="activity-run-detail">{run.detail}</p>}
            <ol className="activity-steps">
              {run.steps.map((step) => (
                <Step step={step} key={step.id} />
              ))}
            </ol>
          </details>
        ))}
      </div>
    </details>
  );
}
