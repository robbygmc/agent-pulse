// Compile AgentPulse with pinned solc and write artifacts + BscScan/Sourcify standard JSON.
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'paris',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
};

function compile(sources) {
  const input = { language: 'Solidity', sources, settings: SETTINGS };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  (out.errors || []).forEach((e) => console.error(e.formattedMessage));
  if (errs.length) process.exit(1);
  return { input, out };
}

const src = fs.readFileSync(path.join(__dirname, 'contracts/AgentPulse.sol'), 'utf8');
const mock = fs.readFileSync(path.join(__dirname, 'test/MockAgentID.sol'), 'utf8');

const main = compile({ 'contracts/AgentPulse.sol': { content: src } });
const c = main.out.contracts['contracts/AgentPulse.sol'].AgentPulse;
const m = compile({ 'test/MockAgentID.sol': { content: mock } }).out.contracts['test/MockAgentID.sol'].MockAgentID;

fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.writeFileSync('build/AgentPulse.json', JSON.stringify({
  compiler: 'v' + solc.version(), settings: { optimizer: SETTINGS.optimizer, evmVersion: SETTINGS.evmVersion },
  abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object, metadata: c.metadata,
}, null, 2));
fs.writeFileSync('build/MockAgentID.json', JSON.stringify({ abi: m.abi, bytecode: '0x' + m.evm.bytecode.object, deployedBytecode: '0x' + m.evm.deployedBytecode.object }, null, 2));
// Standard JSON input for verification (only abi/metadata output requested — explorers ignore outputSelection)
const std = JSON.parse(JSON.stringify(main.input));
std.settings.outputSelection = { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } };
fs.writeFileSync('build/standard-input.json', JSON.stringify(std, null, 2));
fs.writeFileSync('build/metadata.json', c.metadata);
console.log('solc', solc.version());
console.log('initcode bytes', c.evm.bytecode.object.length / 2, 'runtime bytes', c.evm.deployedBytecode.object.length / 2);
