/**
 * A tiny OpenAI-compatible server for the tests: `POST /v1/chat/completions` streams one assistant answer.
 * `reply(messages)` decides the answer: a string, or { tool: { name, arguments } } for one tool call.
 */
import { createServer } from 'node:http';

export async function fakeModel(reply = () => 'ok') {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const request = JSON.parse(body || '{}');
    calls.push(request);
    const answer = await reply(request.messages ?? [], request);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (answer && typeof answer === 'object' && answer.tool) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${calls.length}`, type: 'function', function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.arguments ?? {}) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: String(answer) });
      chunk({}, 'stop');
    }
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}
