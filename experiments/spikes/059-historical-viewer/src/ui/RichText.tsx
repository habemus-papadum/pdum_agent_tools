import {createSignal, For, Show} from 'solid-js';
import {TextView} from '@habemus-papadum/aiui-viz/site/markdown';
import {TeX} from '@habemus-papadum/aiui-viz/site';
import {Mermaid} from '@habemus-papadum/aiui-viz/site/mermaid';
import {mermaidTheme} from '@habemus-papadum/aiui-design';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import diff from 'highlight.js/lib/languages/diff';
import {markdown, safeLink} from '../model/rich';
import {imageURL} from '../model/native';
import {ImageLens} from './ImageLens';
import type {Token} from 'marked';

for (const [name, language] of Object.entries({typescript, javascript, python, bash, json, diff})) hljs.registerLanguage(name, language);
/** Highlighting escapes unknown syntax and retains the exact string in a native code element. */
export function Code(props: {text: string; language?: string; label?: string}) {
  const language = () => props.language?.split(/\s/)[0] || 'text';
  const html = () => hljs.getLanguage(language()) ? hljs.highlight(props.text, {language: language()}).value :
    props.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return <div class="history-code"><div class="history-code-caption">{props.label || language()}</div><pre><code class={`language-${language()}`} innerHTML={html()}/></pre></div>;
}

// Marked's extensible token union intentionally permits custom math tokens.
function Tokens(props: {tokens: Token[]}) {
  return <For each={props.tokens}>{token => <span class="history-token"><TokenNode token={token}/></span>}</For>;
}
function TokenNode(props: {token: Token}) {
  const t = props.token as any;
  const inline = () => <Tokens tokens={t.tokens ?? []}/>;
  switch (t.type) {
    case 'space': return null;
    case 'displayMath': return <TeX tex={t.text} display/>;
    case 'inlineMath': return <TeX tex={t.text}/>;
    case 'paragraph': return <p>{inline()}</p>;
    case 'heading': return <div class={`history-md-heading history-md-h${t.depth}`} role="heading" aria-level={t.depth}>{inline()}</div>;
    case 'text': return t.tokens ? inline() : <>{t.text}</>;
    case 'strong': return <strong>{inline()}</strong>;
    case 'em': return <em>{inline()}</em>;
    case 'del': return <del>{inline()}</del>;
    case 'codespan': return <code>{t.text}</code>;
    case 'br': return <br/>;
    case 'hr': return <hr/>;
    case 'escape': return <>{t.text}</>;
    case 'link': return safeLink(t.href) ? <a href={safeLink(t.href)} target="_blank" rel="noreferrer">{inline()}</a> : <span>{inline()} <small>(link retained in source)</small></span>;
    case 'image': return <ImageLens image={{url: imageURL(t.href), reference: t.href?.startsWith('data:') ? undefined : t.href, label: t.text, origin: 'Markdown image'}}/>;
    case 'code': return t.lang === 'mermaid' ? <figure class="history-diagram"><Mermaid text={t.text} config={mermaidTheme()}/><details><summary>Diagram source</summary><Code text={t.text} language="text"/></details></figure> : <Code text={t.text} language={t.lang}/>;
    case 'blockquote': return <blockquote><Tokens tokens={t.tokens}/></blockquote>;
    case 'list': return t.ordered ? <ol start={t.start}><For each={t.items}>{item => <li><Tokens tokens={(item as any).tokens}/></li>}</For></ol> : <ul><For each={t.items}>{item => <li><Tokens tokens={(item as any).tokens}/></li>}</For></ul>;
    case 'table': return <div class="history-table-scroll"><table><thead><tr><For each={t.header}>{cell => <th><Tokens tokens={(cell as any).tokens}/></th>}</For></tr></thead><tbody><For each={t.rows}>{row => <tr><For each={row as any[]}>{cell => <td><Tokens tokens={cell.tokens}/></td>}</For></tr>}</For></tbody></table></div>;
    case 'html': return <code>{t.raw}</code>;
    default: return <TextView text={t.raw ?? t.text ?? ''}/>;
  }
}

export function RichText(props: {text: string}) {
  const [source, setSource] = createSignal(false);
  return <div class="history-rich"><button class="history-text-source" aria-pressed={source() ? 'true' : 'false'} onClick={() => setSource(!source())}>{source() ? 'Rendered' : 'Text source'}</button>
    <Show when={!source()} fallback={<TextView text={props.text} markdown={false}/>}><div class="history-markdown"><Tokens tokens={markdown.lexer(props.text)}/></div></Show>
  </div>;
}
