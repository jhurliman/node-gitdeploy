# gitdeploy

[![CI](https://github.com/jhurliman/node-gitdeploy/actions/workflows/ci.yml/badge.svg)](https://github.com/jhurliman/node-gitdeploy/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gitdeploy.svg)](https://www.npmjs.com/package/gitdeploy)

Turn an authenticated GitHub, GitLab, or Bitbucket Cloud push into a fast-forward update of a local checkout, followed by your deployment command. Each checkout has its own queue, so overlapping webhooks cannot run two deployments in the same configured directory at once.

**Version 2 requires Node.js 22 or newer.** It uses only Node built-ins at runtime. This branch prepares 2.0; check npm for the currently published version before following the migration guide.

## Set up a receiver

1. Clone your repository into a dedicated checkout, select its deployment branch, and configure its Git upstream. Run the receiver as the unprivileged user that owns this checkout. Git credentials must already work without an interactive prompt.
2. Install `gitdeploy` and save a configuration file outside the repository being deployed:

   ```sh
   npm install --global gitdeploy
   ```

   ```json
   {
     "provider": "github",
     "secretEnv": "GITDEPLOY_SECRET",
     "host": "127.0.0.1",
     "web_port": 23200,
     "repositories": [
       {
         "url": "https://github.com/your-account/your-project",
         "path": "/srv/your-project",
         "ref": "refs/heads/main",
         "deploy": ["npm", "run", "deploy"]
       }
     ]
   }
   ```

3. Supply a randomly generated webhook secret through your process supervisor's environment, then start the receiver:

   ```sh
   gitdeploy --config /etc/gitdeploy/config.json
   ```

4. Expose `POST /` through an HTTPS reverse proxy. Configure the provider's push webhook with the same secret. The listener defaults to loopback; set `host` explicitly when your proxy needs another interface.

The configured deployment command is trusted local code. It runs with the receiver's environment and privileges. Never give an untrusted repository access to a deployment user that holds unrelated credentials.

## Supported webhooks

| `provider` | Authentication | Push selection |
| --- | --- | --- |
| `github` (default) | HMAC-SHA256, `X-Hub-Signature-256` | `X-GitHub-Event: push`, repository web URL, `ref` |
| `gitlab-signed` | GitLab `whsec_` signing token, `webhook-signature`; timestamp within five minutes | `X-Gitlab-Event: Push Hook`, project web URL, `ref` |
| `gitlab` | Exact `X-Gitlab-Token` match; use HTTPS | Same push selection; supports legacy `repository.homepage` payloads |
| `bitbucket` | HMAC-SHA256, `X-Hub-Signature` | `X-Event-Key: repo:push`, repository web URL, changed branches |

Use GitLab signing tokens for new installations. The legacy secret-token mode is explicit and does not provide body integrity without TLS. One receiver has one provider and secret; run separate instances for separate trust boundaries.

Signatures are checked against the original request bytes. Both JSON and legacy form-encoded `payload` bodies are accepted. Other events, branch deletions, and unmatched URLs or refs are ignored. HTTP and HTTPS repository URLs remain distinct; a trailing slash or `.git` suffix is normalized.

Provider references: [GitHub validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [GitLab webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/), and [Bitbucket webhook validation](https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/).

## Deployment contract

For each accepted matching push, the receiver:

1. Waits for earlier work for that configured checkout to finish.
2. Checks that the checkout is on the configured `refs/heads/...` branch.
3. Optionally runs `git reset --hard HEAD` when `reset: true` is configured. This discards tracked local changes; the default is false.
4. Runs `git pull --ff-only` using the checkout's configured upstream. Divergence fails instead of creating a merge commit.
5. Runs `deploy`, if configured. An argument array executes a program directly; a string deliberately runs through the shell for existing deployment scripts.

A webhook triggers a pull of the latest upstream state, **not a deployment pinned to its event's commit**. Use a clean, dedicated checkout with the intended upstream, and do not configure filesystem aliases to the same checkout as separate paths.

`202` means the work was queued, not that deployment succeeded. Failures produce a `failed` log record; later queued work still runs. There are no automatic command retries or rollbacks. Delivery IDs are deduplicated in memory for one hour, up to 10,000 IDs. This is not a durable queue: a crash can lose accepted work, and retries after a restart can repeat a deployment. Use idempotent deployment commands.

## Configuration and limits

| Option | Default | Meaning |
| --- | --- | --- |
| `secretEnv` | `GITDEPLOY_SECRET` | Environment variable containing the webhook secret; programmatic `secret` overrides it |
| `web_port` / `host` | `23200` / `127.0.0.1` | CLI listener address |
| `maxBodyBytes` | `1048576` | Maximum webhook body; larger requests receive 413 |
| `maxQueue` | `100` | Total running plus waiting deployments; overflow receives 503 before any matching work is queued |
| `commandTimeoutMs` | `1200000` | Timeout for each Git or deployment command; captured output is limited to 512 KiB |

The CLI writes JSON outcome records to stdout, containing only `event` and the configured repository URL. It does not log payloads, credentials, or command output. Use your deployment script's own controlled logging for diagnosis. SIGINT/SIGTERM stops accepting HTTP requests and waits for admitted work; allow enough shutdown time for your queue and commands. Node's command timeout does not guarantee termination of every descendant spawned by a shell script; manage long-running deployment processes in your service supervisor.

## Use as a library

Importing the package has no side effects. Bind the returned HTTP server yourself:

```js
const { createServer } = require('gitdeploy');
const config = require('/etc/gitdeploy/config.json');
const receiver = createServer(config, {
  log: record => console.log(JSON.stringify(record))
});
receiver.server.listen(23200, '127.0.0.1');
process.once('SIGTERM', () => {
  receiver.close().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
});
```

Named ESM imports and TypeScript declarations are included. `drain()` waits for queued work without stopping the listener; `close()` stops HTTP acceptance and drains, and is safe to call repeatedly. The optional `deploy(repository, timeoutMs)` injection replaces the deployment operation for tests or custom runners.

## Migrating from 1.x

- Require Node 22+, specify `--config`, a provider/secret, and an explicit branch `ref` for every checkout. Unsigned requests are no longer accepted.
- `node index.js` no longer starts a server. Use the `gitdeploy` executable or `createServer()`.
- Replace `run_as_user` with a service supervisor user setting. Replace `log_path`/`log_level` with stdout collection. These obsolete options now fail configuration validation.
- `forward_to` has been removed. Configure each destination as a provider webhook or use a separately managed authenticated relay.
- The default bind address is now loopback. Git updates are fast-forward only. Plain JSON GitLab payloads now work, including the legacy shape reported in issue #1.
- Deployment scripts remain opt-in, and `reset` still defaults to false. Review the queue, acknowledgement, and shutdown contracts above before upgrading.

## Development

```sh
npm ci
npm test
npm run test:types
npm pack
```

Tests cover provider authentication, JSON/form handling, branch filtering, queue saturation, failure recovery, shutdown, and a disposable local Git remote with real pulls and deployment commands. They do not contact hosting providers or deploy production repositories. Actions runs Node 22, 24, and 26.

The existing package declares a BSD license; this repository does not currently include the full license text. Confirm the intended BSD variant and add its notice before publishing 2.0.
