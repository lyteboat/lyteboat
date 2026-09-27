/**
 * The words of a skill's checks: the agent inspector answers rule ids and the
 * tools each failed on, and the panel shows them as the original Studio did,
 * a label, what passed or broke, and a fix hint.
 * @module @lyteboat/studio-web/client/studio-skill-finding-copy
 */

import type { LyteboatSkillFinding, LyteboatSkillFindingRule } from '@lyteboat/contracts/cli'
import type { StudioSkillDiagnosticsAnswer } from '@lyteboat/contracts/studio'

/** One check as the panel shows it. */
export interface StudioWordedSkillFinding extends LyteboatSkillFinding {
  label: string
  message: string
  evidence?: string
  suggestion?: string
}

interface StudioSkillRuleCopy {
  label: string
  passed(report: StudioSkillDiagnosticsAnswer): string
  failed(finding: LyteboatSkillFinding): string
  suggestion?: string
}

const STUDIO_SKILL_RULE_COPY: Record<LyteboatSkillFindingRule, StudioSkillRuleCopy> = {
  'metadata-valid': {
    label: 'lyteboat 元数据',
    passed: () => 'metadata.lyteboat 可以解析。',
    failed: finding => finding.problem ?? 'metadata.lyteboat 不能解析。',
    suggestion: 'metadata.lyteboat 只有 requiredTools 一个键，值是工具名的列表。',
  },
  'required-tools-registered': {
    label: '要求的工具已注册',
    passed: report => `${String(report.requiredTools.length)} 个要求的工具都已注册。`,
    failed: finding => `这些工具没有任何行注册：${finding.tools.join(', ')}；激活技能时这一轮会报错。`,
    suggestion: '检查工具名的拼写，或在 agent 的代码里注册它。',
  },
  'required-tools-declared': {
    label: '要求的工具有策略声明',
    passed: () => '要求的工具都在工具策略里声明过。',
    failed: finding => `这些工具没有在工具策略里声明：${finding.tools.join(', ')}；路由只激活声明过的工具。`,
    suggestion: '在 lyteboatAgentDef 的 tools 里注册，或在它的 toolPolicy.tools 里声明。',
  },
  'required-tools-auto': {
    label: '要求的工具需要激活',
    passed: () => '要求的工具都是激活后才可见的。',
    failed: finding => `这些工具本来就一直可见，要求它们不起作用：${finding.tools.join(', ')}。`,
    suggestion: '把它们的 visibility 改成 auto，或从 requiredTools 里去掉。',
  },
  routable: {
    label: '可以被路由选中',
    passed: report => report.routing === 'off' ? '这个 agent 不加载技能（路由关闭）。' : '模型可以调用这个技能。',
    failed: () => '这个技能关掉了模型调用（disable-model-invocation），路由永远不会选它。',
  },
}

/**
 * Word every check of a report.
 * @param report - the diagnostics answer.
 */
export function studioWordedSkillFindings(report: StudioSkillDiagnosticsAnswer): StudioWordedSkillFinding[] {
  return report.findings.map((finding) => {
    const copy = STUDIO_SKILL_RULE_COPY[finding.rule]
    const evidence = finding.tools.length > 0 ? finding.tools.join(', ') : finding.problem
    return {
      ...finding,
      label: copy.label,
      message: finding.passed ? copy.passed(report) : copy.failed(finding),
      ...!finding.passed && evidence !== undefined ? { evidence } : {},
      ...!finding.passed && copy.suggestion !== undefined ? { suggestion: copy.suggestion } : {},
    }
  })
}
