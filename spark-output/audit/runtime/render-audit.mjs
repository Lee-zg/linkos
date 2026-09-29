import { readFile, writeFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = process.cwd();
const suite = 'C:/Users/12533/.qoder/plugins/cache/qoder-marketplace/product-design/0.5.10';
const auditPath = `${root}/spark-output/context/audit.json`;
const audit = JSON.parse(await readFile(auditPath, 'utf8'));
const evidence = JSON.parse(await readFile(`${root}/spark-output/audit/evidence/browser-results.json`, 'utf8'));
assert.ok(!evidence.failure, 'Browser audit must complete before rendering the report');
const dimensions = ['visibility', 'real-world-match', 'user-control', 'consistency', 'error-prevention', 'recognition', 'flexibility', 'aesthetic', 'error-recovery', 'help-docs', 'responsive', 'performance'];
const bySeverity = { blocker: 0, major: 0, minor: 0 };
const byHeuristic = Object.fromEntries(dimensions.map(key => [key, 0]));
const ids = new Set();
for (const finding of audit.findings) {
  assert.ok(!ids.has(finding.id));
  ids.add(finding.id);
  assert.ok(finding.severity in bySeverity && finding.heuristic in byHeuristic);
  bySeverity[finding.severity]++;
  byHeuristic[finding.heuristic]++;
}
for (const opportunity of audit.opportunities) {
  for (const id of opportunity.addresses_findings) assert.ok(ids.has(id));
}
audit.generated_at = new Date().toISOString();
audit.summary = { total_findings: audit.findings.length, by_severity: bySeverity, by_heuristic: byHeuristic, top_opportunities: audit.opportunities.filter(item => item.priority === 'high').map(item => item.title) };
await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
const reportPath = `${root}/spark-output/audit/linkos.md`;
const original = (await readFile(reportPath, 'utf8')).split('\n## 10. 自动汇总与完整 Findings')[0];
let appendix = '\n## 10. 自动汇总与完整 Findings\n\n';
appendix += `生成时间：${audit.generated_at}。计数由 audit.json 的 findings 数组程序化派生。\n\n`;
appendix += '| 严重度 | 数量 |\n| --- | ---: |\n';
for (const [key, count] of Object.entries(bySeverity)) appendix += `| ${key} | ${count} |\n`;
appendix += `| 合计 | ${audit.findings.length} |\n\n`;
appendix += '| 维度 | 发现数 |\n| --- | ---: |\n';
for (const [key, count] of Object.entries(byHeuristic)) appendix += `| ${key} | ${count} |\n`;
appendix += '\n### 改版机会矩阵\n\n| 机会点 | 优先级 | 关联发现 | 理由 |\n| --- | --- | --- | --- |\n';
for (const item of audit.opportunities) appendix += `| ${item.title} | ${item.priority} | ${item.addresses_findings.join('、')} | ${item.rationale} |\n`;
const labels = { 'browser-confirmed': '浏览器实测', 'code-confirmed': '源码确认，条件路径未全部实测', 'heuristic-observation': '启发式观察，需用户验证', 'unmeasured-risk': '未测量风险，不视为指标失败' };
appendix += '\n### 完整清单（每项只按一个主维度计数）\n';
for (const dimension of dimensions) {
  appendix += `\n#### ${dimension}\n`;
  for (const finding of audit.findings.filter(item => item.heuristic === dimension)) {
    appendix += `\n**${finding.id} · ${finding.severity} · ${finding.priority}**\n\n${finding.description}\n\n- 证据类型：${labels[finding.validation]}\n- 位置：${finding.evidence}\n- 触发条件：${finding.exposure}（不是实测发生频率）\n- 修复建议：${finding.suggestion}\n- 相对成本：${finding.effort}\n`;
  }
}
await writeFile(reportPath, `${original}\n${appendix}`);
const contextFiles = (await readdir(`${root}/spark-output/context`)).filter(name => name.endsWith('.json') && !name.startsWith('_'));
const contexts = {};
for (const name of contextFiles) {
  const item = JSON.parse(await readFile(`${root}/spark-output/context/${name}`, 'utf8'));
  contexts[item.skill || name.slice(0, -5)] = { done: true, summary: item.skill === 'audit' ? `${item.summary.total_findings}项发现，${item.opportunities.length}个机会点；改版待确认` : item.project_name, fields: item.skill === 'audit' ? { target: item.target, summary: item.summary, opportunities: item.opportunities } : item };
}
const state = { project: audit.project_name, generated_at: audit.generated_at, contexts };
let template = await readFile(`${suite}/_shared/dashboard-template.html`, 'utf8');
assert.ok(template.includes('const STATE = /*__SPARK_STATE_INJECT__*/null;'));
template = template.replace('const STATE = /*__SPARK_STATE_INJECT__*/null;', `const STATE = /*__SPARK_STATE_INJECT__*/${JSON.stringify(state).replaceAll('<', '\\u003c')};`);
template = template.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '');
await writeFile(`${root}/spark-output/dashboard.html`, template);
const graph = JSON.parse(await readFile(`${suite}/_shared/skill-graph.json`, 'utf8'));
const current = graph.skills.find(item => item.id === 'audit');
const done = new Set(Object.keys(contexts));
const preferred = current.next_hint.preferred;
const alternatives = current.next_hint.alternatives.map(item => item.id);
const fanOut = id => graph.skills.filter(item => item.reads.includes(id)).length;
const score = item => [preferred.includes(item.id) ? 0 : alternatives.includes(item.id) ? 1 : 2, preferred.includes(item.id) ? preferred.indexOf(item.id) : alternatives.includes(item.id) ? alternatives.indexOf(item.id) : 0, item.phase >= current.phase ? item.phase - current.phase : 99, item.anchor ? 0 : 1, -fanOut(item.id)];
const ready = graph.skills.filter(item => !done.has(item.id) && item.required.every(id => done.has(id))).sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.id.localeCompare(b.id); }).slice(0, 5).map(item => item.id);
await writeFile(`${root}/spark-output/context/_session-state.json`, JSON.stringify({ current_skill: 'audit', workspace_path: root, original_workspace_path: root, completed_skills: [...done], current_phase: '审计完成，等待优化方向确认', updated_at: audit.generated_at }, null, 2));
console.log(JSON.stringify({ summary: audit.summary, opportunities: audit.opportunities.length, nextSkills: ready, nextHint: { preferred: current.next_hint.preferred, alternatives: current.next_hint.alternatives, reason: current.next_hint.reason }, dashboardContexts: Object.keys(contexts) }, null, 2));
