#!/usr/bin/env node
'use strict';
const { readFile } = require('node:fs/promises');
const { parseArgs } = require('node:util');
const { createServer } = require('../index.js');
async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string', short: 'f' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('Usage: gitdeploy --config /path/to/config.json'); return; }
  if (!values.config) throw new Error('--config is required');
  const config = JSON.parse(await readFile(values.config, 'utf8'));
  const port = config.web_port ?? 23200;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid web_port');
  const receiver = createServer(config, { log: entry => console.log(JSON.stringify(entry)) });
  receiver.server.on('error', () => { console.error('gitdeploy: server failed'); process.exitCode = 1; });
  receiver.server.listen(port, config.host || '127.0.0.1', () => console.log('gitdeploy: listening'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void receiver.close().catch(() => { console.error('gitdeploy: shutdown failed'); process.exitCode = 1; });
  });
}
main().catch(() => { console.error('gitdeploy: invalid configuration or startup failure; see README'); process.exitCode = 1; });
