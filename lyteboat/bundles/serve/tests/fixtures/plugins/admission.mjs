// A host-scope admission function: a stock question gets a fixed reply and a
// card without a model request, everything else passes. Tests insert it the way
// `lyteboat serve --plugin <this file>` would.
export const name = 'example-admission'
export const inject = ['requestAdmission']

const CARD = { surfaceId: 'scope-card', area: 'scope', emission: 'immediate', payload: { rootComponentId: 'root' } }

export function apply(ctx) {
  ctx.requestAdmission.register({
    name,
    admit: async ({ text, context }) => /炒股|股票/u.test(text)
      ? { decision: 'reply', verdict: 'out_of_scope', text: `抱歉，${String(context.channel ?? '这里')}不提供股票买卖建议。`, cards: [CARD] }
      : { decision: 'pass' },
  })
}
