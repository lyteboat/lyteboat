// Two lyteboat tools over `ctx.toolPolicy`. `lookup_assets` is always visible and
// folds its result into the session state; `rebalance` stays hidden until the
// user talks about rebalancing. The tool-policy composition test inserts it the
// way `lyteboat headless --plugin <this file>` would in the business one-shot.
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'example-tools'
// lyteboatDistro: the activation listens to the kernel extension agent-loop-pre-assemble.
export const inject = ['toolPolicy', 'lyteboatDistro']

const WANTS_REBALANCE = /调仓|rebalance/iu

function textOf(messages) {
  return messages
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    .join('\n')
}

export function apply(ctx) {
  ctx.toolPolicy.register(defineTool({
    name: 'lookup_assets',
    description: '查询当前用户的资产总览。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          currency: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `总资产 ${value.total} ${value.currency}` }],
    },
    execute: async () => ({ total: 1234, currency: 'CNY' }),
  }), {
    visibility: 'always',
    stateDelta: (_args, value) => ({ 'assets.total': value.total, 'assets.currency': value.currency }),
  })

  ctx.toolPolicy.register(defineTool({
    name: 'rebalance',
    description: '按目标组合调仓。',
    parameters: { target: { type: 'string', required: true, description: '目标组合，如“股债均衡”' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (args, _value) => [{ type: 'text', text: `已按“${args.target}”调仓` }],
    },
    execute: async () => ({ ok: true }),
  }), { visibility: 'auto' })

  ctx.on('lyteboat/pre-assemble', async (payload, next) => {
    if (WANTS_REBALANCE.test(textOf(payload.messages))) ctx.toolPolicy.activate(payload.agent, ['rebalance'])
    return next()
  })
}
