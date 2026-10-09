// Fails the step that claimed a message reading "fail before logging", in
// lyteboat/pre-assemble: after the loop took the message from the inbox and
// before it is logged, where a skill naming a tool no policy declares fails.
// Tests insert it the way `lyteboat serve --plugin <this file>` would.
export const name = 'example-failing-pre-assemble'
export const inject = ['lyteboatDistro']

export function apply(ctx) {
  ctx.on('lyteboat/pre-assemble', async (payload, next) => {
    const asked = payload.messages.some(message => message.content.some(block => block.type === 'text' && block.text === 'fail before logging'))
    if (asked) throw new Error('example-failing-pre-assemble: refused the step')
    return next()
  })
}
