import type {HistoryDocument} from './native';

/** Authored renderer exercise; never entered into the real history catalog or used as provider evidence. */
export const specimen: HistoryDocument = {
  key: '@specimen', provider: 'specimen', sessionId: 'synthetic-renderer-exercise', title: 'Rendering bench · synthetic',
  source: {kind: 'synthetic', method: 'Authored locally for visual coverage', capturedAt: 'not a capture'},
  payload: {messages: [
    {uuid: 'specimen-user', type: 'user', message: {role: 'user', content: [{type: 'text', text: 'Exercise the reader: code, tables, equations, diagrams, images, tools, and unknown blocks. This is authored test content, not a provider response.'}]}},
    {uuid: 'specimen-assistant', type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: [
      '### A readable technical answer',
      'A small **Markdown** example with *emphasis*, `inline code`, a [source link](https://example.com), and an equation $E = mc^2$.',
      '| Material | What it proves |\n| --- | --- |\n| Code | Token color and exact copy |\n| Math | TeX source retained |',
      '```typescript\ninterface Reading { value: number; known: boolean }\nexport const total = (rows: Reading[]) =>\n  rows.filter(row => row.known).reduce((sum, row) => sum + row.value, 0);\n```',
      '$$\nP(x \\mid y) = \\frac{P(y \\mid x)P(x)}{P(y)}\n$$',
      '```mermaid\nflowchart LR\n  A[Native history] --> B[Read only export]\n  B --> C[Transcript]\n  B --> D[Raw record]\n```',
      '> The diagram and formula above are synthetic rendering exercises. They do not establish provider coverage.',
    ].join('\n\n')}, {type: 'image', alt: 'Synthetic raster color specimen', source: {type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNosAAAAASUVORK5CYII='}},
      {type: 'tool_use', id: 'specimen-tool', name: 'Read', input: {path: 'synthetic/example.ts'}}]}},
    {uuid: 'specimen-result', type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'specimen-tool', content: 'Synthetic output\nNothing ran. No real files were read.'}]}},
    {uuid: 'specimen-unknown', type: 'assistant', message: {role: 'assistant', content: [{type: 'future_provider_block', example: {retained: true, explanation: 'Unknown blocks keep their original value.'}}]}},
  ]},
};
