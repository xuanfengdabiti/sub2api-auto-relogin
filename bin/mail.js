#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const commandMap = {
  import: 'mail:import',
  'import-lines': 'mail:import-lines',
  list: 'mail:list',
  add: 'mail:add',
  check: 'mail:check',
  'check-all': 'mail:check-all',
  'latest-code': 'mail:latest-code',
};

const [command, ...rest] = process.argv.slice(2);
const mappedCommand = commandMap[command] || command || 'help';
const result = spawnSync(process.execPath, [
  path.join(__dirname, 'auto-relogin.js'),
  mappedCommand,
  ...rest,
], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
});

process.exitCode = result.status || 0;
