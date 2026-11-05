import type { ConsistencyReport } from "@memmy/local-api-contracts";

export type C2Task = NonNullable<ConsistencyReport['compliance']>['tasks'][number];
type Check = ConsistencyReport['checks'][number];
export const C2_TASK_LABELS = { reading: '初核中', verifying: '覆核中', completed: '已出結果', queued: '排隊', failed: '未能完成' };
export function c2TaskState(task: C2Task): keyof typeof C2_TASK_LABELS {
  return task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : task.status === 'running' ? task.completed_passes >= 1 ? 'verifying' : 'reading' : 'queued';
}
export function c2CheckTask(check: Check, report: ConsistencyReport) {
  return report.compliance?.tasks.find(task => task.check_ids?.includes(check.id));
}
export function c2Progress(report: ConsistencyReport) {
  const review = report.compliance!;
  const checks = report.checks.filter(c => c.regulatory);
  const counts = { reading: 0, verifying: 0, completed: 0, queued: 0, failed: 0 };
  let firstPass = 0;
  for (const check of checks) {
    const task = c2CheckTask(check, report);
    const reviewed = check.regulatory!.outcome !== 'not_reviewed';
    // Published outcomes remain authoritative, even if a task is retrying.
    const state = reviewed ? 'completed' : task ? c2TaskState(task) === 'completed' ? 'failed' : c2TaskState(task) : 'queued';
    counts[state]++;
    if (reviewed || task && task.completed_passes >= 1) firstPass++;
  }
  const mapped = review.tasks.some(t => t.check_ids?.length);
  const total = review.coverage.checks_total;
  const weighted = mapped ? firstPass + counts.completed : undefined;
  const percent = weighted === undefined ? Math.min(100, Math.round(review.completed_tasks / Math.max(1, review.total_tasks) * 100)) : Math.round(weighted / Math.max(1, total * 2) * 100);
  return { counts, firstPass, total, mapped, percent, weighted };
}
export function c2TaskActivity(task: C2Task) {
  const activity = task.activity;
  if (!activity) return task.completed_passes >= 1 ? '核對引用，檢查有否遺漏或誤判' : '閱讀報告，逐項核對條款';
  if (activity.stage === 'receiving') return `正在接收結果${activity.received_chars ? ` · ${activity.received_chars.toLocaleString()}字元` : ''}`;
  if (activity.stage === 'validating') return '結果已收到，正在驗證引用';
  if (activity.stage === 'retrying') return `重核未通過引用驗證的${activity.remaining_checks ?? ''}項`;
  return activity.stage === 'requesting' ? '已送交模型，等候回應' : '模型正在閱讀及分析';
}
