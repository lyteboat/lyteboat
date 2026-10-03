// A plugin file that writes one line to stderr when applied and registers one tool:
// serve.e2e inserts it with --plugin, looks for the line (the row ran, not only
// loaded), and has the model call the tool, since the business base leaves no coding
// tool to call; args.spec needs a second existing file.
export const name = 'fixture-announce'
export const inject = ['tools']

export function apply(ctx) {
  process.stderr.write('fixture-announce: applied\n')
  ctx.effect(() => ctx.tools.register({
    name: 'announce_status',
    description: 'Report the fixture status.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'fixture-announce: status ok',
  }), 'fixture-announce: tool')
}
