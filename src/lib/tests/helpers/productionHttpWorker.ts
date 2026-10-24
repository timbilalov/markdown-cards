import { pathToFileURL } from 'node:url';
import type { ProductionWorkerMessage, ProductionResponse } from './productionHttp';

// Child process: native Request/Response and the actual generated platform entry.
// Only external I/O is substituted; no framework, auth, route or config mocks.
let effects: ProductionResponse['effects'];
let requestNumber = 0;
let dropboxSequence = 0;
let dropboxRevisions = new Map<string, string>();
function reset(remote: Record<string, string>) {
  effects = { requests: [], writes: [], remote: { ...remote }, unexpected: [], databaseOpens: 0 };
  dropboxSequence=0;dropboxRevisions=new Map(Object.keys(remote).filter(key=>key.startsWith('dropbox:')).map(key=>[key,'fixture-revision']));
}
reset({});
function dropboxMetadata(key:string){
 const path=key.slice('dropbox:'.length);
 return {'.tag':'file',name:path.slice(path.lastIndexOf('/')+1),path_lower:path.toLowerCase(),rev:dropboxRevisions.get(key),server_modified:'2026-10-19T00:00:00Z'};
}
globalThis.fetch = async (input, init) => {
  const address = input instanceof Request ? input.url : String(input);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  effects.requests.push({ url: address, method });
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    effects.unexpected.push(`${method} ${address}`);
    throw new Error('Unexpected relative HTTP in production test');
  }
  if (url.origin === 'https://api.dropboxapi.com' && method === 'POST') {
    if (url.pathname === '/oauth2/token') return Response.json({access_token:'fixture-access-token',expires_in:14400});
    if (url.pathname === '/2/users/get_current_account') return Response.json({account_id:'dbid:fixture-account',root_info:{home_namespace_id:'fixture-home',root_namespace_id:'fixture-home'}});
    const body=JSON.parse(String(init?.body));
    if(url.pathname==='/2/files/get_metadata')return Response.json({'.tag':'folder',id:`fixture-folder:${body.path}`,path_lower:body.path.toLowerCase()});
    if(url.pathname==='/2/files/list_folder'){
      const prefix=`dropbox:${body.path}/`;
      return Response.json({entries:Object.keys(effects.remote).filter(key=>key.startsWith(prefix)&&!key.slice(prefix.length).includes('/')).map(key=>dropboxMetadata(key)),cursor:'fixture-cursor',has_more:false});
    }
  }
  if(url.origin==='https://content.dropboxapi.com'&&method==='POST'){
    const argument=JSON.parse(new Headers(init?.headers).get('Dropbox-API-Arg')??'null');
    const requested=`dropbox:${argument.path}`;
    const existing=Object.keys(effects.remote).find(key=>key.toLowerCase()===requested.toLowerCase());
    if(url.pathname==='/2/files/download')return existing
      ? new Response(new TextEncoder().encode(effects.remote[existing]),{headers:{'Dropbox-API-Result':JSON.stringify(dropboxMetadata(existing))}})
      : Response.json({error:{'.tag':'path',path:{'.tag':'not_found'}}},{status:409});
    if(url.pathname==='/2/files/upload'){
      if(argument.mode==='add'&&existing || argument.mode?.['.tag']==='update'&&(!existing||dropboxRevisions.get(existing)!==argument.mode.update))return Response.json({error:{'.tag':'path',path:{reason:{'.tag':'conflict'}}}},{status:409});
      const key=existing??requested;const source=new TextDecoder('utf8',{ignoreBOM:true}).decode(await new Response(init?.body).arrayBuffer());
      effects.writes.push({path:key,source,overwrite:argument.mode!=='add'});effects.remote[key]=source;dropboxRevisions.set(key,`fixture-revision-${++dropboxSequence}`);
      return Response.json(dropboxMetadata(key));
    }
  }
  // Explicit read fixtures for the private-cache suite; all data stays in memory.
  // Existing upload handling and rejection of every other external request remain.
  const providerHeaders = { 'Cache-Control': 'public, max-age=3600', ETag: '"provider-version"' };
  if (url.origin === 'https://cloud-api.yandex.net' && method === 'GET') {
    const path = url.searchParams.get('path') ?? '';
    if(url.pathname==='/v1/disk'&&url.searchParams.get('fields')==='user.uid')return Response.json({user:{uid:'fixture-account'}});
    if(url.pathname==='/v1/disk/resources'&&url.searchParams.get('fields')==='type,path,resource_id')return Response.json({type:'dir',path,resource_id:path==='disk:/md-cards'?'fixture-folder':`fixture-folder:${path}`});
    if (url.pathname === '/v1/disk/resources/download' && path.startsWith('disk:/')) {
      const key = path.slice('disk:/'.length);
      if (!Object.hasOwn(effects.remote, key)) return new Response(null, { status: 404 });
      const href = new URL('https://downloader.disk.yandex.ru/disk/private-cache');
      href.searchParams.set('path', key);
      return Response.json({ href: href.href, method: 'GET', templated: false }, { headers: providerHeaders });
    }
    if (url.pathname === '/v1/disk/resources' && path.startsWith('disk:/')) {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const prefix=path.slice('disk:/'.length)+'/';
      const items = Object.keys(effects.remote).filter(key => key.startsWith(prefix)&&!key.slice(prefix.length).includes('/')).map(key => ({
        name: key.slice(prefix.length), path: `disk:/${key}`, type: 'file'
      }));
      return Response.json({ type: 'dir', path, _embedded: { path, offset, limit, total: items.length,
        items: items.slice(offset, offset + limit) } }, { headers: providerHeaders });
    }
  }
  if (url.origin === 'https://downloader.disk.yandex.ru' && url.pathname === '/disk/private-cache' && method === 'GET') {
    const key = url.searchParams.get('path') ?? '';
    if (Object.hasOwn(effects.remote, key)) return new Response(effects.remote[key], { headers: providerHeaders });
  }
  if (url.origin === 'https://cloud-api.yandex.net' && url.pathname === '/v1/disk/resources/upload' && method === 'GET') {
    const isAdapter = url.searchParams.get('path')?.startsWith('disk:/');
    const href = new URL(isAdapter ? 'https://uploader1d.dst.yandex.net/upload-target/write' : 'https://upload.example.invalid/write');
    href.search = url.search;
    return Response.json({ href: href.href, method: 'PUT', templated: false });
  }
  if (method === 'PUT' && ((url.origin === 'https://upload.example.invalid' && url.pathname === '/write')
    || (url.origin === 'https://uploader1d.dst.yandex.net' && url.pathname === '/upload-target/write'))) {
    const providerPath = url.searchParams.get('path') ?? '';
    const path = providerPath.startsWith('disk:/') ? providerPath.slice('disk:/'.length) : providerPath;
    const overwrite = url.searchParams.get('overwrite') === 'true';
    const source = new TextDecoder('utf8',{ignoreBOM:true}).decode(await new Response(init?.body).arrayBuffer());
    if (!overwrite && Object.hasOwn(effects.remote, path)) return new Response(null, { status: 409 });
    effects.writes.push({ path, source, overwrite });
    effects.remote[path] = source;
    return new Response(null, { status: 201 });
  }
  effects.unexpected.push(`${method} ${url.href}`);
  throw new Error('Unexpected external HTTP in production test');
};
Object.defineProperty(globalThis, 'indexedDB', { value: {
  open() { effects.databaseOpens++; throw new Error('Unexpected IndexedDB in production test'); }
}, configurable: true });

try {
  const application = (await import(pathToFileURL(process.argv[2]).href)).default as {
    fetch(request: Request): Promise<Response>;
  } | ((request: Request, context: { ip: string }) => Promise<Response>);
  let queue = Promise.resolve();
  process.on('message', (message: ProductionWorkerMessage) => {
    queue = queue.then(async () => {
      try {
        if ('reset' in message) {
          reset(message.reset);
          process.send?.({ id: message.id });
          return;
        }
        const input = message.request;
        const headers = new Headers(input.headers);
        // Keep rate limiting outside this contract; never reuse a test client IP.
        const clientNumber = ++requestNumber;
        const clientIP = `198.18.${Math.floor(clientNumber / 256)}.${clientNumber % 256}`;
        headers.set('x-forwarded-for', clientIP);
        let body: BodyInit | undefined = input.bodyBytes === undefined ? input.body : new Uint8Array(input.bodyBytes);
        if (input.form) {
          const form = new FormData();
          for (const [name, value] of Object.entries(input.form)) form.set(name, value);
          body = form;
        }
        const request = new Request(input.url, { method: input.method ?? 'GET', headers, body });
        const response = typeof application === 'function'
          ? await application(request, { ip: clientIP })
          : await application.fetch(request);
        const result: ProductionResponse = {
          status: response.status, headers: Object.fromEntries(response.headers),
          cookies: response.headers.getSetCookie(), text: new TextDecoder('utf8',{ignoreBOM:true}).decode(await response.arrayBuffer()),
          bodyUsed: request.bodyUsed, effects
        };
        process.send?.({ id: message.id, result });
      } catch (error) {
        process.send?.({ id: message.id, error: error instanceof Error ? error.stack : String(error) });
      }
    });
  });
  process.send?.({ ready: true });
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
}
