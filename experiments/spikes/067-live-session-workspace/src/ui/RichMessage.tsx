import {For} from 'solid-js';
import {TextView} from '@habemus-papadum/aiui-viz/site/markdown';
import {TeX} from '@habemus-papadum/aiui-viz/site';
import {Mermaid} from '@habemus-papadum/aiui-viz/site/mermaid';
import {mermaidTheme} from '@habemus-papadum/aiui-design';
import {markdown, safeLink} from '../../../059-historical-viewer/src/model/rich';
import type {Token} from 'marked';

/** The same renderer serves live and saved text; the historical study owns the pure parser. */
function Tokens(props: {tokens: Token[]}) {
  return <For each={props.tokens}>{token => <span class="live-rich-token"><Node token={token}/></span>}</For>;
}
function Node(props: {token: Token}) {
  const t = props.token as any;
  const inline = () => <Tokens tokens={t.tokens ?? []}/>;
  switch (t.type) {
    case 'space': return null;
    case 'displayMath': return <TeX tex={t.text} display/>;
    case 'inlineMath': return <TeX tex={t.text}/>;
    case 'paragraph': return <p>{inline()}</p>;
    case 'heading': return <div class="live-rich-heading" role="heading" aria-level={t.depth}>{inline()}</div>;
    case 'text': return t.tokens ? inline() : <>{t.text}</>;
    case 'strong': return <strong>{inline()}</strong>;
    case 'em': return <em>{inline()}</em>;
    case 'del': return <del>{inline()}</del>;
    case 'codespan': return <code>{t.text}</code>;
    case 'br': return <br/>;
    case 'hr': return <hr/>;
    case 'escape': return <>{t.text}</>;
    case 'link': return safeLink(t.href) ? <a href={safeLink(t.href)} target="_blank" rel="noreferrer">{inline()}</a> : <span>{inline()} <small>(reference)</small></span>;
    case 'image': return <span class="live-image-reference">▧ {t.text || 'Image'} <code>{t.href?.startsWith('data:') ? 'embedded image reference' : t.href}</code></span>;
    case 'code': return t.lang === 'mermaid' ? <figure><Mermaid text={t.text} config={mermaidTheme()}/><details><summary>Diagram source</summary><pre>{t.text}</pre></details></figure> : <div class="live-code"><small>{t.lang || 'text'}</small><pre><code>{t.text}</code></pre></div>;
    case 'blockquote': return <blockquote><Tokens tokens={t.tokens}/></blockquote>;
    case 'list': return t.ordered ? <ol start={t.start}><For each={t.items}>{item => <li><Tokens tokens={(item as any).tokens}/></li>}</For></ol> : <ul><For each={t.items}>{item => <li><Tokens tokens={(item as any).tokens}/></li>}</For></ul>;
    case 'table': return <div class="live-table-scroll"><table><thead><tr><For each={t.header}>{cell => <th><Tokens tokens={(cell as any).tokens}/></th>}</For></tr></thead><tbody><For each={t.rows}>{row => <tr><For each={row as any[]}>{cell => <td><Tokens tokens={cell.tokens}/></td>}</For></tr>}</For></tbody></table></div>;
    case 'html': return <code>{t.raw}</code>;
    default: return <TextView text={t.raw ?? t.text ?? ''}/>;
  }
}
export function RichMessage(props: {text: string}) {
  return <div class="live-rich"><Tokens tokens={markdown.lexer(props.text)}/></div>;
}
