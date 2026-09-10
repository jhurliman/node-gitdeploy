'use strict';

const http = require('node:http');
const path = require('node:path');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { execFile, exec } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const runShell = promisify(exec);

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function verify(provider, secret, headers, raw) {
  if (provider === 'gitlab') return equal(headers['x-gitlab-token'], secret);
  if (provider === 'gitlab-signed') {
    const timestamp = headers['webhook-timestamp'];
    const id = headers['webhook-id'];
    if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || typeof id !== 'string') return false;
    const expected = 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update(`${id}.${timestamp}.`).update(raw).digest('base64');
    return typeof headers['webhook-signature'] === 'string' &&
      headers['webhook-signature'].split(' ').some(signature => equal(signature, expected));
  }
  const signature = headers[provider === 'github' ? 'x-hub-signature-256' : 'x-hub-signature'];
  return equal(signature, 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
}

function canonical(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    return parsed.origin + parsed.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  } catch { return ''; }
}

function pushDetails(provider, headers, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid payload');
  if (provider === 'bitbucket') {
    if (headers['x-event-key'] !== 'repo:push') return null;
    return { url: canonical(payload.repository?.links?.html?.href), refs:
      (Array.isArray(payload.push?.changes) ? payload.push.changes : [])
        .filter(change => !change.closed && change.new?.type === 'branch' && typeof change.new.name === 'string')
        .map(change => 'refs/heads/' + change.new.name) };
  }
  if (provider === 'github' ? headers['x-github-event'] !== 'push' : headers['x-gitlab-event'] !== 'Push Hook') return null;
  return {
    url: canonical(provider === 'github' ? payload.repository?.html_url || payload.repository?.url :
      payload.project?.web_url || payload.repository?.homepage || payload.repository?.url),
    refs: payload.deleted || /^0+$/.test(payload.after || '') ? [] : [payload.ref],
  };
}

async function deployRepository(repo, timeout) {
  const options = { cwd: repo.path, timeout, maxBuffer: 524288, windowsHide: true };
  const { stdout } = await runFile('git', ['symbolic-ref', '--quiet', 'HEAD'], options);
  if (stdout.trim() !== repo.ref) throw new Error('Checkout branch does not match configured ref');
  if (repo.reset) await runFile('git', ['reset', '--hard', 'HEAD'], options);
  await runFile('git', ['pull', '--ff-only'], options);
  if (Array.isArray(repo.deploy)) await runFile(repo.deploy[0], repo.deploy.slice(1), options);
  else if (repo.deploy) await runShell(repo.deploy, options);
}

function positive(value, fallback, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

/** Create an unbound webhook receiver. No server starts on import. */
function createServer(config, options = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('Configuration is required');
  for (const removed of ['run_as_user', 'log_path', 'log_level', 'forward_to']) {
    if (config[removed] !== undefined) throw new TypeError(`${removed} is no longer supported; see migration guide`);
  }
  const provider = config.provider || 'github';
  if (!['github', 'gitlab', 'gitlab-signed', 'bitbucket'].includes(provider)) throw new TypeError('Unsupported provider');
  const secret = config.secret ?? process.env[config.secretEnv || 'GITDEPLOY_SECRET'];
  if (typeof secret !== 'string' || !secret.length) throw new TypeError('A webhook secret is required');
  if (provider === 'gitlab-signed' && (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.slice(6), 'base64').length < 16)) {
    throw new TypeError('GitLab signing token must be a whsec_ base64 key of at least 16 bytes');
  }
  if (!Array.isArray(config.repositories) || !config.repositories.length) throw new TypeError('Configure at least one repository');
  const paths = new Set();
  const repositories = config.repositories.map(repo => {
    if (!canonical(repo.url) || typeof repo.path !== 'string' || !path.isAbsolute(repo.path) ||
        typeof repo.ref !== 'string' || !/^refs\/heads\/[^\s~^:?*\[\\]+$/.test(repo.ref)) throw new TypeError('Repository requires a web URL, absolute path, and branch ref');
    if (paths.has(path.resolve(repo.path))) throw new TypeError('Configure each checkout path only once');
    paths.add(path.resolve(repo.path));
    if (repo.reset !== undefined && typeof repo.reset !== 'boolean') throw new TypeError('reset must be boolean');
    if (repo.deploy !== undefined && !(typeof repo.deploy === 'string' ||
      Array.isArray(repo.deploy) && repo.deploy.length && repo.deploy.every(arg => typeof arg === 'string') && repo.deploy[0])) throw new TypeError('deploy must be a command string or nonempty argument array');
    return Object.freeze({ ...repo, url: canonical(repo.url), deploy: Array.isArray(repo.deploy) ? [...repo.deploy] : repo.deploy });
  });
  const maxBody = positive(config.maxBodyBytes, 1048576, 'maxBodyBytes');
  const maxQueue = positive(config.maxQueue, 100, 'maxQueue');
  const commandTimeout = positive(config.commandTimeoutMs, 1200000, 'commandTimeoutMs');
  const execute = options.deploy || deployRepository;
  const log = options.log || (() => {});
  const tails = new Map(), pending = new Set(), deliveries = new Map();
  let closing = false, closePromise;
  function record(event, repo) {
    try { log({ event, repository: repo.url }); } catch { /* Logging cannot interrupt the queue. */ }
  }
  function enqueue(repo) {
    const job = (tails.get(repo.path) || Promise.resolve()).then(() => execute(repo, commandTimeout))
      .then(() => record('deployed', repo), () => record('failed', repo));
    tails.set(repo.path, job);
    pending.add(job);
    void job.then(() => { pending.delete(job); if (tails.get(repo.path) === job) tails.delete(repo.path); });
  }
  const server = http.createServer(async (req, res) => {
    const respond = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: message })); };
    if (closing) return respond(503, 'shutting down');
    if (req.method !== 'POST' || req.url !== '/') return respond(404, 'not found');
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['application/json', 'application/x-www-form-urlencoded'].includes(contentType) || req.headers['content-encoding']) return respond(415, 'unsupported content type');
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) { respond(413, 'payload too large'); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!verify(provider, secret, req.headers, raw)) return respond(401, 'unauthorized');
      let payload;
      try {
        const text = raw.toString('utf8');
        payload = JSON.parse(contentType === 'application/json' ? text : new URLSearchParams(text).get('payload'));
      } catch { return respond(400, 'invalid JSON'); }
      const details = pushDetails(provider, req.headers, payload);
      if (!details) return respond(200, 'ignored event');
      if (!details.url) return respond(400, 'missing repository URL');
      const matching = repositories.filter(repo => repo.url === details.url && details.refs.includes(repo.ref));
      if (!matching.length) return respond(200, 'ignored repository or ref');
      if (closing) return respond(503, 'shutting down');
      const id = req.headers['webhook-id'] || req.headers['x-github-delivery'] || req.headers['x-gitlab-event-uuid'] || req.headers['x-request-uuid'];
      const now = Date.now();
      for (const [key, expires] of deliveries) if (expires <= now) deliveries.delete(key);
      const deliveryKey = typeof id === 'string' ? details.url + ':' + id : null;
      if (deliveryKey && deliveries.has(deliveryKey)) return respond(200, 'duplicate');
      if (pending.size + matching.length > maxQueue) return respond(503, 'queue full');
      if (deliveryKey) {
        if (deliveries.size >= 10000) deliveries.delete(deliveries.keys().next().value);
        deliveries.set(deliveryKey, now + 3600000);
      }
      matching.forEach(enqueue);
      respond(202, 'accepted');
    } catch { if (!res.headersSent && !res.destroyed) respond(400, 'invalid request'); }
  });
  let binding = false;
  const listen = server.listen;
  server.listen = function (...args) {
    if (closing) throw new Error('Receiver is closed');
    binding = true;
    try { return listen.apply(this, args); }
    catch (error) { binding = false; throw error; }
  };
  server.on('listening', () => { binding = false; });
  server.on('error', () => { binding = false; });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  async function drain() { while (pending.size) await Promise.all([...pending]); }
  function close() {
    if (!closePromise) {
      closing = true;
      closePromise = new Promise((resolve, reject) => {
        const shut = () => {
          server.removeListener('listening', onListening);
          server.removeListener('error', onError);
          if (!server.listening) return resolve();
          server.close(error => error ? reject(error) : resolve());
        };
        const onListening = () => shut();
        const onError = () => shut();
        if (binding) {
          server.once('listening', onListening);
          server.once('error', onError);
        } else shut();
      }).then(drain);
    }
    return closePromise;
  }
  return { server, drain, close };
}

exports.createServer = createServer;
exports.deployRepository = deployRepository;
