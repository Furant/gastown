import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildNodeSetupCommand } from '../web/onboarding.mjs';

function runShell(shell, command, { cwd, env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', command], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('generated node commands run from an unrelated directory with safely quoted paths', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gastown-command-e2e-'));
  const sentinel = join(root, 'shell-injection-ran');
  const consoleDir = join(root, `Console space's $(touch ${sentinel})`);
  const configDir = join(root, "Node config's $HOME `literal`");
  const unrelatedDir = join(root, 'unrelated-cwd');
  const observationsDir = join(root, 'observations');
  await Promise.all([mkdir(consoleDir, { recursive: true }), mkdir(configDir), mkdir(unrelatedDir), mkdir(observationsDir)]);
  const configPath = join(configDir, 'node config.json');
  await writeFile(configPath, JSON.stringify({ serverUrl: 'http://127.0.0.1:8768', projects: {}, tools: { codex: { command: '/fixture/codex' } } }));
  await chmod(configPath, 0o644);

  await writeFile(join(consoleDir, 'package.json'), JSON.stringify({
    name: 'gastown-command-fixture', private: true, scripts: { node: 'node stub-node.cjs' },
  }));
  await writeFile(join(consoleDir, 'stub-node.cjs'), `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.NODE_COMMAND_OBSERVATION, JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(), input,
    tokenPresent: Boolean(process.env.GAS_TOWN_NODE_TOKEN),
  }));
  console.log('fixture node invoked');
});
`);

  const shells = ['/bin/bash'];
  if (spawnSync('/bin/zsh', ['--version'], { stdio: 'ignore' }).status === 0) shells.push('/bin/zsh');
  const token = randomBytes(32).toString('hex');
  const pairingCode = randomBytes(18).toString('hex');
  const modes = [
    ['pair', ['--pair'], `${pairingCode}\n`],
    ['sync-config', ['--sync-config'], ''],
    ['check', ['--check'], ''],
    ['start', [], ''],
  ];
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const shell of shells) {
    await writeFile(configPath, JSON.stringify({ serverUrl: 'http://127.0.0.1:8768', projects: {}, tools: { codex: { command: '/fixture/codex' } } }));
    for (const [mode, expectedModeArgs, input] of modes) {
      const observationPath = join(observationsDir, `${shell.split('/').at(-1)}-${mode}.json`);
      const command = buildNodeSetupCommand({ consoleDir, configPath, mode });
      assert.ok(command.includes('npm --prefix'), 'command should select the console package explicitly');
      assert.ok(!command.includes(token) && !command.includes(pairingCode), 'credentials must not be embedded in the command');

      const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'GAS_TOWN_NODE_TOKEN')),
        GAS_TOWN_NODE_TOKEN: token,
        NODE_COMMAND_OBSERVATION: observationPath,
      };
      await chmod(configPath, 0o644);
      const result = await runShell(shell, command, { cwd: unrelatedDir, env, input });
      assert.equal(result.code, 0, `${shell} ${mode} failed: ${result.stderr}`);
      assert.match(result.stdout, /fixture node invoked/);
      assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
      assert.ok(!result.stdout.includes(pairingCode) && !result.stderr.includes(pairingCode));

      const observed = JSON.parse(await readFile(observationPath, 'utf8'));
      assert.equal(observed.cwd, await realpath(consoleDir), 'npm must execute the package script in its own directory');
      assert.equal(observed.tokenPresent, true);
      assert.deepEqual(observed.args, ['--config', configPath, ...expectedModeArgs]);
      assert.equal(observed.input, input, 'pairing code should be delivered through stdin');
      assert.ok(!JSON.stringify(observed).includes(token));
      assert.ok(!JSON.stringify(observed.args).includes(pairingCode));
      assert.equal((await stat(configPath)).mode & 0o777, 0o600, 'setup command must restrict config permissions');
    }

    const observationPath = join(observationsDir, `${shell.split('/').at(-1)}-pair-token-prompt.json`);
    const command = buildNodeSetupCommand({ consoleDir, configPath, mode: 'pair' });
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'GAS_TOWN_NODE_TOKEN')),
      NODE_COMMAND_OBSERVATION: observationPath,
    };
    await chmod(configPath, 0o644);
    const result = await runShell(shell, command, { cwd: unrelatedDir, env, input: `${token}\n${pairingCode}\n` });
    assert.equal(result.code, 0, `${shell} pair with token prompt failed: ${result.stderr}`);
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
    assert.ok(!result.stdout.includes(pairingCode) && !result.stderr.includes(pairingCode));
    const observed = JSON.parse(await readFile(observationPath, 'utf8'));
    assert.equal(observed.tokenPresent, true);
    assert.deepEqual(observed.args, ['--config', configPath, '--pair']);
    assert.equal(observed.input, `${pairingCode}\n`, 'the setup wrapper should consume only the token line');
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    const savedToken = randomBytes(32).toString('hex');
    await writeFile(configPath, JSON.stringify({ token: savedToken }));
    const savedTokenObservation = join(observationsDir, `${shell.split('/').at(-1)}-pair-saved-token.json`);
    const savedTokenEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'GAS_TOWN_NODE_TOKEN')),
      NODE_COMMAND_OBSERVATION: savedTokenObservation,
    };
    const savedTokenCommand = buildNodeSetupCommand({ consoleDir, configPath, mode: 'pair' });
    assert.ok(!savedTokenCommand.includes(savedToken), 'saved token must not be embedded in the command');
    const savedTokenResult = await runShell(shell, savedTokenCommand, { cwd: unrelatedDir, env: savedTokenEnv, input: `${pairingCode}\n` });
    assert.equal(savedTokenResult.code, 0, `${shell} pair with saved token failed: ${savedTokenResult.stderr}`);
    assert.ok(!savedTokenResult.stdout.includes('GAS_TOWN_NODE_TOKEN:'), 'saved config token should suppress the token prompt');
    assert.ok(!savedTokenResult.stdout.includes(savedToken) && !savedTokenResult.stderr.includes(savedToken));
    const savedTokenObserved = JSON.parse(await readFile(savedTokenObservation, 'utf8'));
    assert.equal(savedTokenObserved.tokenPresent, false, 'wrapper must leave the saved token in config rather than exporting it');
    assert.deepEqual(savedTokenObserved.args, ['--config', configPath, '--pair']);
    assert.equal(savedTokenObserved.input, `${pairingCode}\n`, 'saved-token check must not consume the pairing code');
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    const missingConfig = join(configDir, 'does-not-exist.json');
    const missingCommand = buildNodeSetupCommand({ consoleDir, configPath: missingConfig, mode: 'check' });
    const missingResult = await runShell(shell, missingCommand, { cwd: unrelatedDir, env, input: '' });
    assert.notEqual(missingResult.code, 0);
    assert.match(missingResult.stderr, /node-config\.json was not found/);
    assert.ok(!missingResult.stdout.includes('GAS_TOWN_NODE_TOKEN:'), 'missing config should fail before prompting for a token');
  }

  await assert.rejects(readFile(sentinel), { code: 'ENOENT' }, 'shell metacharacters in paths must stay literal');
});
