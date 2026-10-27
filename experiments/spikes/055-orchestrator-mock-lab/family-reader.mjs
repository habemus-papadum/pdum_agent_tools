/** Read-only selected family exports for this disposable mock, not a production storage/config API. */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const knownRuns = [
  {id:'codex-work', title:'Codex · related working sessions', provider:'codex', run:'codex-20261024T155028Z'},
  {id:'claude-nested', title:'Claude · nested agents and relationship gaps', provider:'claude', run:'claude-20261024-d2'},
  {id:'claude-gaps', title:'Claude · long parent with unlinked children', provider:'claude', run:'claude-20261024-c2'},
  {id:'rich-messages', title:'Rich messages · prompts and responses', provider:'mixed', kind:'collection', directory:'rich-messages'},
];
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);
const invalid = message => Object.assign(new Error(message), {code:'INVALID_FAMILY_EXPORT'});
const metadata = ({payload: _payload, ...entry}) => entry;

function validateSelections(rows, base) {
  if (!Array.isArray(rows)) throw invalid('Family selection must contain a families array');
  const seen = new Set();
  return rows.map(row => {
    if (!validId(row?.id) || seen.has(row.id) || !['codex','claude','mixed'].includes(row.provider) ||
      (row.provider === 'mixed' && row.kind !== 'collection') || (row.kind && !['family','collection'].includes(row.kind)) ||
      typeof row.directory !== 'string' || !row.directory || typeof row.title !== 'string')
      throw invalid('Invalid or duplicate family selection');
    seen.add(row.id);
    return {...row, directory:resolve(base, row.directory)};
  });
}

function validateDocument(document, filename, provider) {
  const nativeProvider = provider === 'mixed' ? document?.provider : provider;
  if (!['codex','claude'].includes(nativeProvider) || !validId(document?.key) || document.key !== filename.slice(0,-5) || !document.key.startsWith(`${nativeProvider}-`) ||
    document.provider !== nativeProvider || typeof document.sessionId !== 'string' || !document.sessionId ||
    !document.source?.method || !Object.hasOwn(document, 'payload'))
    throw invalid('Native document identity differs from the selected family');
  if (nativeProvider === 'codex' && document.payload?.thread?.id !== document.sessionId)
    throw invalid('Codex thread identity differs from its native envelope');
  return document;
}

function collectionFiles(collection, id) {
  if (collection?.version !== 1 || collection.id !== id || collection.kind !== 'independent-examples' ||
    !Array.isArray(collection.documents) || !collection.documents.length || !Array.isArray(collection.bookmarks))
    throw invalid('Independent collection manifest is invalid');
  const keys = new Set();
  return collection.documents.map(entry => {
    if (!validId(entry?.key) || keys.has(entry.key) ||
      ![`${entry.key}.json`,`documents/${entry.key}.json`].includes(entry.file))
      throw invalid('Collection document file or key is invalid');
    keys.add(entry.key);
    return `${entry.key}.json`;
  });
}

/** Bookmarks identify real native records; grouping never creates parent relationships. */
function collectionRoot(collection, documents) {
  const entries = new Map(documents.map(document => [document.key,document]));
  for(const entry of collection.documents){
    const document=entries.get(entry.key);
    if(!document || (entry.provider!==undefined&&entry.provider!==document.provider) ||
      (entry.sessionId!==undefined&&entry.sessionId!==document.sessionId))
      throw invalid('Collection document metadata differs from its native envelope');
  }
  const seen = new Set();
  for (const bookmark of collection.bookmarks) {
    if(!bookmark || typeof bookmark!=='object')throw invalid('Collection bookmark is invalid');
    const document = entries.get(bookmark.documentKey);
    if (!validId(bookmark?.id) || seen.has(bookmark.id) || !document || bookmark.provider !== document.provider ||
      !['user','assistant'].includes(bookmark.role) || typeof bookmark.label !== 'string' ||
      (bookmark.features !== undefined && (!Array.isArray(bookmark.features) || bookmark.features.some(value=>typeof value!=='string'))))
      throw invalid('Collection bookmark identity or provider is invalid');
    seen.add(bookmark.id);
    if(document.provider==='codex'&&!Array.isArray(document.payload?.thread?.turns) ||
      document.provider==='claude'&&!Array.isArray(document.payload?.messages))throw invalid('Bookmarked native history is malformed');
    const records = document.provider === 'codex'
      ? (document.payload?.thread?.turns??[]).flatMap(turn=>(turn.items??[]).map(item=>({
        itemId:item.id,turnId:turn.id,role:item.type==='userMessage'?'user':item.type==='agentMessage'?'assistant':'tool',phase:item.phase??null,
      })))
      : (document.payload?.messages??[]).map(wrapper=>({uuid:wrapper.uuid,itemId:wrapper.uuid,
        role:wrapper.message?.role??wrapper.type,phase:wrapper.message?.phase??wrapper.message?.channel??null}));
    const hasOrdinal = bookmark.ordinal !== undefined;
    if (hasOrdinal && (!Number.isInteger(bookmark.ordinal) || bookmark.ordinal < 0 || bookmark.ordinal >= records.length))
      throw invalid('Collection bookmark ordinal is outside its native document');
    if (!hasOrdinal && !bookmark.itemId && !bookmark.uuid) throw invalid('Collection bookmark has no native item identity');
    const matches = (hasOrdinal ? [records[bookmark.ordinal]] : records).filter(record =>
      (!bookmark.itemId || record.itemId===bookmark.itemId) && (!bookmark.turnId || record.turnId===bookmark.turnId) &&
      (!bookmark.uuid || record.uuid===bookmark.uuid));
    if (matches.length !== 1 || matches[0].role !== bookmark.role ||
      (bookmark.phase !== undefined && bookmark.phase !== matches[0].phase))
      throw invalid('Collection bookmark differs from its native record');
  }
  const initial = collection.initialBookmarkId === undefined ? collection.bookmarks[0]
    : collection.bookmarks.find(bookmark=>bookmark.id===collection.initialBookmarkId);
  if (collection.initialBookmarkId !== undefined && !initial) throw invalid('Initial collection bookmark is absent');
  return initial?.documentKey ?? documents[0].key;
}

function rootOf(provider, relationships, documents) {
  if (provider === 'claude') {
    const root = documents.find(document => document.key === relationships.rootKey);
    if (!root || root.sessionId !== relationships.rootSessionId || !Array.isArray(relationships.members))
      throw invalid('Claude family root or member metadata is invalid');
    const members = new Map();
    for (const member of relationships.members) {
      if (!validId(member.key) || members.has(member.key)) throw invalid('Duplicate or invalid Claude family member');
      members.set(member.key, member);
    }
    if (members.size !== documents.length) throw invalid('Claude family documents differ from its recorded members');
    for (const document of documents) {
      const member = members.get(document.key);
      if (!member || document.sessionId !== relationships.rootSessionId) throw invalid('Claude family member identity differs');
      if (member.kind === 'subagent' && (!member.agentId || document.source.relation?.agentId !== member.agentId ||
        document.source.relation?.rootSessionId !== relationships.rootSessionId))
        throw invalid('Claude subagent identity differs from its native metadata');
    }
    return root.key;
  }
  const roots = documents.filter(document => document.sessionId === relationships.parentThreadId);
  if (roots.length !== 1 || !Array.isArray(relationships.threads)) throw invalid('Codex family root metadata is invalid');
  const ids = relationships.threads.map(thread => thread.threadId);
  if (new Set(ids).size !== documents.length || ids.length !== documents.length ||
    documents.some(document => !ids.includes(document.sessionId))) throw invalid('Codex documents differ from recorded family threads');
  return roots[0].key;
}

/** Optional JSON selects local run directories only: {families:[{id,title,provider,directory}]}.
 * Relative directories resolve against that file. This is temporary lab input, not ingestor/launcher config.
 * Each request reads and parses its complete selected exports; there is no paging, provider call or mutation.
 */
export function createFamilyReader(historyDirectory, {configPath} = {}) {
  const selections = async () => {
    if (configPath) {
      const path = resolve(configPath);
      const config = JSON.parse(await readFile(path, 'utf8'));
      return validateSelections(config.families, dirname(path));
    }
    return validateSelections(knownRuns.map(({run,...row}) => ({...row,directory:row.directory??join('families',run)})), historyDirectory);
  };
  const read = async selection => {
    const {id,title,provider,directory} = selection;
    const groupKind = selection.kind === 'collection' ? 'collection' : 'family';
    try {
      const relationships = JSON.parse(await readFile(join(directory,groupKind==='collection'?'collection.json':'family.json'),'utf8'));
      const filenames = groupKind === 'collection' ? collectionFiles(relationships,id)
        : (await readdir(join(directory,'documents'), {withFileTypes:true}))
          .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
      let documentBytes = 0;
      const documents = await Promise.all(filenames.map(async filename => {
        const bytes = await readFile(join(directory,'documents',filename));
        documentBytes += bytes.byteLength;
        return validateDocument(JSON.parse(bytes.toString('utf8')),filename,provider);
      }));
      const keys = new Set(documents.map(document=>document.key));
      if (!documents.length || keys.size !== documents.length) throw invalid('Family has no documents or duplicate native keys');
      const rootKey = groupKind === 'collection' ? collectionRoot(relationships,documents) : rootOf(provider,relationships,documents);
      // Root first for presentation only; no native payload or relationship record is changed.
      if (groupKind === 'family') documents.sort((a,b) => a.key===rootKey ? -1 : b.key===rootKey ? 1 : a.key.localeCompare(b.key));
      const coverage = {documentCount:documents.length, documentBytes,
        scope:groupKind==='collection'?'Independent captured examples; initial document is not a parent assertion':'Every document in this explicitly selected export run; native relationship gaps remain unchanged',
        transfer:`Full selected ${groupKind} is read and returned on request; no paging or truncation`};
      const collection = groupKind==='collection'?{bookmarks:relationships.bookmarks,initialBookmarkId:relationships.initialBookmarkId??null}:{};
      if (groupKind==='collection') coverage.native=relationships.coverage??null;
      return {version:1,id,title,provider,groupKind,available:true,rootKey,documents,relationships,coverage,...collection};
    } catch (error) {
      if (error?.code === 'ENOENT') return {version:1,id,title,provider,groupKind,available:false,rootKey:null,
        code:'missing-export', reason:'This selected family export is not available locally'};
      if (error?.code === 'INVALID_FAMILY_EXPORT' || error instanceof SyntaxError)
        return {version:1,id,title,provider,groupKind,available:false,rootKey:null,code:'invalid-export',
          reason:error instanceof SyntaxError ? 'Selected family contains invalid JSON' : error.message};
      throw error;
    }
  };
  return {
    async catalog() {
      const bundles = await Promise.all((await selections()).map(read));
      return {version:1,readOnly:true,families:bundles.map(bundle => {
        if (!bundle.available) return {...bundle,members:[]};
        const {documents,relationships:_relationships,...entry} = bundle;
        return {...entry,members:documents.map(metadata)};
      })};
    },
    async family(id) {
      if (!validId(id)) return null;
      const selection = (await selections()).find(entry=>entry.id===id);
      return selection ? read(selection) : null;
    },
    /** Only hash-named raster assets explicitly listed in selected collections are HTTP-readable. */
    async asset(filename) {
      const match=typeof filename==='string'&&filename.match(/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/);
      if(!match)return null;
      for(const selection of (await selections()).filter(row=>row.kind==='collection')) {
        const bundle=await read(selection);if(!bundle.available)continue;
        const listed=[...(Array.isArray(bundle.relationships.assets)?bundle.relationships.assets:[]),
          ...bundle.documents.flatMap(document=>Array.isArray(document.source.assets)?document.source.assets:[])];
        if(!listed.some(asset=>asset.path===`assets/${filename}`))continue;
        try {return {contentType:({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'})[match[1]],
          bytes:await readFile(join(selection.directory,'assets',filename))};}
        catch(error){if(error?.code!=='ENOENT')throw error;}
      }
      return null;
    },
  };
}
