'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, rm, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createServer, deployRepository } = require('..');
const git = promisify(execFile);
const secret = 'test secret with spaces';
const repo = { url: 'https://example.com/owner/project', path: path.resolve('fixture'), ref: 'refs/heads/main' };
const payload = { repository: { html_url: repo.url }, ref: repo.ref, after: '1234' };
async function receiver(t, config = {}, options = {}) {
  const instance = createServer({ secret, repositories: [repo], ...config }, { deploy: async () => {}, ...options });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  t.after(() => instance.close());
  instance.send = async (data = payload, headers = {}, form = false) => {
    const body = typeof data === 'string' ? data : form ? new URLSearchParams({ payload: JSON.stringify(data) }).toString() : JSON.stringify(data);
    const response = await fetch(`http://127.0.0.1:${instance.server.address().port}/`, {
      method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'), ...headers }, body,
    });
    return { status: response.status, body: await response.json() };
  };
  return instance;
}

test('JSON and legacy form pushes authenticate and deploy', async t => {
  const seen = [];
  const r = await receiver(t, {}, { deploy: async x => seen.push(x) });
  assert.equal((await r.send()).status, 202);
  assert.equal((await r.send(payload, {}, true)).status, 202);
  await r.drain();
  assert.equal(seen.length, 2);
});
test('rejects tampered signatures, malformed JSON, and oversized bodies', async t => {
  const r = await receiver(t, { maxBodyBytes: 300 });
  assert.equal((await r.send(payload, { 'x-hub-signature-256': 'sha256=bad' })).status, 401);
  assert.equal((await r.send('{')).status, 400);
  assert.equal((await r.send('x'.repeat(400))).status, 413);
});
test('ignores other events, repositories, branches, and branch deletion', async t => {
  let count = 0;
  const r = await receiver(t, {}, { deploy: async () => count++ });
  for (const data of [{ ...payload, ref: 'refs/heads/dev' }, { ...payload, deleted: true }, { ...payload, after: '0'.repeat(40) },
    { ...payload, repository: { html_url: 'https://example.com/other' } }]) assert.equal((await r.send(data)).status, 200);
  assert.equal((await r.send(payload, { 'x-github-event': 'pull_request' })).status, 200);
  await r.drain(); assert.equal(count, 0);
});
test('GitLab JSON payload from issue #1 and token authentication', async t => {
  let count = 0;
  const r = await receiver(t, { provider: 'gitlab' }, { deploy: async () => count++ });
  const data = { repository: { url: 'ssh://git@example.com/owner/project.git', homepage: repo.url }, ref: repo.ref, after: 'abcd' };
  assert.equal((await r.send(data, { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': secret })).status, 202);
  assert.equal((await r.send(data, { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'wrong' })).status, 401);
  await r.drain(); assert.equal(count, 1);
});
test('GitLab signed webhooks verify raw bytes and reject stale timestamps', async t => {
  const key = Buffer.alloc(32, 0x73), signingSecret = 'whsec_' + key.toString('base64');
  const r = await receiver(t, { provider: 'gitlab-signed', secret: signingSecret });
  const data = { project: { web_url: repo.url }, ref: repo.ref, after: 'abcd' }, body = JSON.stringify(data);
  async function send(timestamp, valid = true) {
    return r.send(body, { 'x-gitlab-event': 'Push Hook', 'webhook-id': 'delivery', 'webhook-timestamp': String(timestamp),
      'webhook-signature': 'v1,' + createHmac('sha256', key).update(`delivery.${timestamp}.`).update(valid ? body : 'wrong').digest('base64') });
  }
  assert.equal((await send(Math.floor(Date.now() / 1000))).status, 202);
  assert.equal((await send(Math.floor(Date.now() / 1000), false)).status, 401);
  assert.equal((await send(Math.floor(Date.now() / 1000) - 400)).status, 401);
});
test('Bitbucket signed branch changes are supported', async t => {
  const r = await receiver(t, { provider: 'bitbucket' });
  const body = JSON.stringify({ repository: { links: { html: { href: repo.url } } }, push: { changes: [{ new: { type: 'branch', name: 'main' } }] } });
  assert.equal((await r.send(body, { 'x-event-key': 'repo:push', 'x-hub-signature': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') })).status, 202);
});
test('per-checkout queue survives failures and bounds admitted work', async t => {
  let release;
  const gate = new Promise(resolve => release = resolve);
  let active = 0, maximum = 0, calls = 0;
  const logs = [];
  const r = await receiver(t, { maxQueue: 2 }, { deploy: async () => {
    active++; maximum = Math.max(maximum, active); calls++;
    try { await gate; if (calls === 1) throw new Error('sensitive command output'); } finally { active--; }
  }, log: entry => logs.push(entry) });
  try {
    assert.equal((await r.send(payload, { 'x-github-delivery': 'one' })).status, 202);
    assert.equal((await r.send(payload, { 'x-github-delivery': 'one' })).body.status, 'duplicate');
    assert.equal((await r.send(payload, { 'x-github-delivery': 'two' })).status, 202);
    assert.equal((await r.send(payload, { 'x-github-delivery': 'three' })).status, 503);
  } finally { release(); }
  await r.drain();
  assert.equal(maximum, 1); assert.equal(calls, 2);
  assert.deepEqual(logs.map(x => x.event), ['failed', 'deployed']);
  assert.doesNotMatch(JSON.stringify(logs), /sensitive/);
  assert.equal((await r.send(payload, { 'x-github-delivery': 'three' })).status, 202);
});
test('different checkout paths run independently and shutdown drains', async t => {
  let release;
  const gate = new Promise(resolve => release = resolve);
  let calls = 0;
  const r = await receiver(t, { repositories: [repo, { ...repo, path: path.resolve('other') }] }, { deploy: async () => { calls++; await gate; } });
  await r.send(); assert.equal(calls, 2);
  let closed = false; const closing = r.close().then(() => closed = true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await closing; assert.equal(closed, true);
});
test('validates dangerous or obsolete configuration before listening', () => {
  const valid = { secret, repositories: [repo] };
  for (const config of [{ ...valid, secret: '' }, { ...valid, forward_to: [] }, { ...valid, maxQueue: 0 },
    { ...valid, repositories: [{ ...repo, path: 'relative' }] }, { ...valid, repositories: [repo, repo] },
    { ...valid, repositories: [{ ...repo, ref: 'main' }] }, { ...valid, repositories: [{ ...repo, deploy: [] }] }]) assert.throws(() => createServer(config));
});
test('real git checkout fast-forwards, executes configured argv, refuses wrong branch and divergence', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitdeploy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'), source = path.join(dir, 'source'), checkout = path.join(dir, 'checkout');
  async function run(cwd, ...args) { return git('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }); }
  await run(dir, 'init', '--bare', '--initial-branch=main', remote);
  await run(dir, 'clone', remote, source);
  await writeFile(path.join(source, 'value'), 'one'); await run(source, 'add', '.'); await run(source, 'commit', '-m', 'initial'); await run(source, 'push', 'origin', 'main');
  await run(dir, 'clone', remote, checkout);
  await writeFile(path.join(source, 'value'), 'two'); await run(source, 'commit', '-am', 'second'); await run(source, 'push');
  const config = { ...repo, path: checkout, deploy: [process.execPath, '-e', "require('node:fs').writeFileSync('deployed','yes')"] };
  await deployRepository(config, 10000);
  assert.equal(await readFile(path.join(checkout, 'value'), 'utf8'), 'two');
  assert.equal(await readFile(path.join(checkout, 'deployed'), 'utf8'), 'yes');
  await assert.rejects(deployRepository({ ...config, ref: 'refs/heads/other' }, 10000), /branch/);
  await writeFile(path.join(checkout, 'local'), 'local'); await run(checkout, 'add', 'local'); await run(checkout, 'commit', '-m', 'local');
  await writeFile(path.join(source, 'value'), 'three'); await run(source, 'commit', '-am', 'third'); await run(source, 'push');
  await assert.rejects(deployRepository(config, 10000));
});

test('close waits for an in-flight hostname bind and prevents later reopening', async () => {
  const r = createServer({ secret, repositories: [repo] });
  r.server.listen(0, 'localhost');
  await r.close();
  assert.equal(r.server.listening, false);
  assert.equal(r.server.address(), null);
  await r.close();
  assert.throws(() => r.server.listen(0), /closed/);
});
