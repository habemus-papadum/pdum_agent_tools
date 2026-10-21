import { createRequire } from 'node:module';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Shared, disposable note reader. Reuses the parser already installed for AIUI TextView. */
export async function createMarkdownPage(aiuiRoot) {
  const require = createRequire(resolve(aiuiRoot, 'packages/aiui-viz/package.json'));
  const { Marked } = await import(pathToFileURL(require.resolve('marked')).href);
  return (source, { pathname }) => {
    const headings = [];
    const slugs = new Map();
    const parser = new Marked({ gfm: true, renderer: {
      // Match AIUI's TextView convention: authored HTML is text, not page markup.
      html({ text }) { return escape(text); },
      heading({ tokens, depth, text }) {
        const base = text.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
        const count = slugs.get(base) ?? 0; slugs.set(base, count + 1);
        const id = count ? `${base}-${count}` : base;
        const label = this.parser.parseInline(tokens);
        headings.push({ depth, id, text, label });
        return `<h${depth} id="${escape(id)}">${label}</h${depth}>\n`;
      },
    } });
    const content = parser.parse(source, { async: false });
    const title = headings.find(h => h.depth === 1)?.text ?? basename(pathname);
    const study = pathname.match(/^\/(?:spikes\/)?(053-orchestrator-overview|054-orchestrator-session|059-historical-viewer|060-authentication-flows|history|auth)\//)?.[1];
    const back = study ? `/${study}/` : '/';
    const toc = headings.filter(h => h.depth === 2 || h.depth === 3).map(h =>
      `<li class="depth-${h.depth}"><a href="#${escape(h.id)}">${h.label}</a></li>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Design notes</title><link rel="icon" href="data:,">
<link rel="stylesheet" href="/__aiui-design/site.css"><link rel="stylesheet" href="/055-orchestrator-mock-lab/markdown-page.css"></head>
<body class="notes-page"><a class="notes-skip" href="#note-content">Skip to notes</a>
<main class="notes-shell"><header class="notes-nav"><a href="${back}">← ${study ? 'Back to study' : 'Mock lab'}</a>
<span>Interaction lab / Design notes</span><a href="${escape(pathname)}?raw=1">Raw Markdown</a></header>
<div class="notes-layout"><aside class="notes-toc"><nav aria-label="In these notes"><p>In these notes</p><ol>${toc}</ol></nav></aside>
<article id="note-content" class="notes-body">${content}</article></div>
<footer class="notes-footer">Rendered from <code>${escape(pathname)}</code>. The Markdown file remains the source.</footer>
</main></body></html>`;
  };
}
