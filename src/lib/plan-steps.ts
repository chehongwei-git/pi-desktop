/** 展示与生命周期共用扩展步骤语义；未知非空行按未完成保留。 */
export function planSteps(lines: string[]) {
  return lines
    .filter((line) => line.trim() && !line.startsWith('ℹ '))
    .map((line) => {
      const match = /^\s*([☑☐⊘])\s*(.*)$/.exec(line);
      return {
        text: match ? match[2] : line,
        completed: match?.[1] === '☑',
        skipped: match?.[1] === '⊘',
      };
    });
}

/** 受限不是完成；仅所有步骤明确勾选时才允许下一次提交隐藏。 */
export function completedPlan(lines: string[]): string {
  const steps = planSteps(lines);
  return steps.length && steps.every((step) => step.completed)
    ? JSON.stringify(steps)
    : '';
}
