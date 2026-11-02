/**
 * hub.js against a fake MCP hub: initialize with a session, the two meta tools, headers passed through, a forgotten
 * session started again, errors as text; config takes the hub from the environment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HubClient, hubTools, readAnswer, resultText } from '../src/hub.js';
import { loadConfig } from '../src/index.js';

function fakeHub({ forgetOnce = false } = {}) {
  const seen = [];
  let forgotten = !forgetOnce;
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, headers: init.headers, body });
    const reply = (obj, extra = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: obj }), {
      status: 200, headers: { 'content-type': 'application/json', ...extra },
    });
    if (body.method === 'initialize') return reply({ serverInfo: { name: 'FYOS-Hub' } }, { 'mcp-session-id': 's-1' });
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (body.method === 'tools/call') {
      if (!forgotten) {
        forgotten = true;
        return new Response('', { status: 404 });
      }
      assert.equal(init.headers['mcp-session-id'], 's-1');
      const { name, arguments: args } = body.params;
      if (name === 'hub__search_tools') {
        // an event stream answer, as the hub sends it
        const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `web.lesen  for ${args.query}` }] } });
        return new Response(`event: message\ndata: ${msg}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (name === 'hub__call_tool') {
        if (args.tool === 'kaputt.x') return reply({ isError: true, content: [{ type: 'text', text: 'geht nicht' }] });
        return reply({ content: [{ type: 'text', text: `called ${args.tool} with ${JSON.stringify(args.arguments)}` }] });
      }
    }
    return new Response('', { status: 400 });
  };
  return { seen, fetchFn };
}

const run = (tool, p) => tool.execute(p, {}, {}).then((r) => r.output[0].text);

test('no hub configured: no tools', () => {
  assert.deepEqual(hubTools({ url: '' }), []);
});

test('search and call through the meta tools, headers passed through, session kept', async () => {
  const hub = fakeHub();
  const [search, call] = hubTools({ url: 'http://hub.test/mcp', headers: { authorization: 'Bearer hub', 'x-github-token': 'gh' } }, { fetchFn: hub.fetchFn });
  assert.equal(search.name, 'hub_search');
  assert.match(await run(search, { query: 'read a web page' }), /web\.lesen\s+for read a web page/);
  assert.match(await run(call, { tool: 'web.lesen', arguments: { url: 'https://example.com' } }), /called web\.lesen with \{"url":"https:\/\/example\.com"\}/);
  assert.match(await run(call, { tool: 'kaputt.x' }), /The tool failed: geht nicht/);
  const inits = hub.seen.filter((s) => s.body.method === 'initialize');
  assert.equal(inits.length, 1, 'one initialize for all calls');
  assert.ok(hub.seen.every((s) => s.headers.authorization === 'Bearer hub' && s.headers['x-github-token'] === 'gh'));
});

test('a forgotten session is started again once', async () => {
  const hub = fakeHub({ forgetOnce: true });
  const c = new HubClient({ url: 'http://hub.test/mcp', fetchFn: hub.fetchFn });
  const r = await c.call('hub__call_tool', { tool: 'a.b', arguments: {} });
  assert.match(resultText(r), /called a\.b/);
  assert.equal(hub.seen.filter((s) => s.body.method === 'initialize').length, 2);
});

test('an unreachable hub is a sentence, not a crash', async () => {
  const [search] = hubTools({ url: 'http://hub.test/mcp' }, { fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  assert.match(await run(search, { query: 'x' }), /Hub not reachable: ECONNREFUSED/);
});

test('answers as JSON or event stream', () => {
  assert.deepEqual(readAnswer('{"result":{"a":1}}'), { result: { a: 1 } });
  assert.deepEqual(readAnswer('event: message\ndata: {"result":{"b":2}}\n\n', 'text/event-stream'), { result: { b: 2 } });
});

test('config: the hub from the environment, headers only as an object of strings', () => {
  const cfg = loadConfig({}, { FLE_DURABLE_TOKEN: 'x'.repeat(32), FLE_DURABLE_HUB_URL: 'http://hub.test/mcp', FLE_DURABLE_HUB_HEADERS: '{"Authorization":"Bearer t","bad key":"x","n":1}' });
  assert.equal(cfg.hub.url, 'http://hub.test/mcp');
  assert.deepEqual(cfg.hub.headers, { Authorization: 'Bearer t' });
  const none = loadConfig({}, { FLE_DURABLE_TOKEN: 'x'.repeat(32), FLE_DURABLE_HUB_HEADERS: 'not json' });
  assert.equal(none.hub.url, '');
  assert.deepEqual(none.hub.headers, {});
});
