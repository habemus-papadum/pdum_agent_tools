import {Marked} from 'marked';

/** Rich content parsing is presentation-only. HTML is rendered as text and links keep safe schemes. */
export const markdown = new Marked({gfm: true, extensions: [
  {name: 'displayMath', level: 'block', start: source => source.indexOf('$$'), tokenizer(source) {
    const match = /^\$\$\s*\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(source);
    if (match) return {type: 'displayMath', raw: match[0], text: match[1]};
  }},
  {name: 'inlineMath', level: 'inline', start: source => source.indexOf('$'), tokenizer(source) {
    const match = /^\$(?!\$)([^$\n]+?)\$(?!\d)/.exec(source);
    if (match) return {type: 'inlineMath', raw: match[0], text: match[1]};
  }},
]});
export function safeLink(href: string): string | undefined {
  return /^(https?:|mailto:|#)/i.test(href) ? href : undefined;
}
