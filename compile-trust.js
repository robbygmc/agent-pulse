// Compile AgentPulseTrust (v2) with pinned solc 0.8.28 and write artifacts + BscScan/Sourcify standard JSON.
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

const file = 'contracts/AgentPulseTrust.sol';
const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
const main = compile({ [file]: { content: src } });
const c = main.out.contracts[file].AgentPulseTrust;

fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'build/AgentPulseTrust.json'), JSON.stringify({
  compiler: 'v' + solc.version(), settings: { optimizer: SETTINGS.optimizer, evmVersion: SETTINGS.evmVersion },
  abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object, metadata: c.metadata,
}, null, 2));

const std = JSON.parse(JSON.stringify(main.input));
std.settings.outputSelection = { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } };
fs.mkdirSync(path.join(__dirname, 'verify/trust'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'verify/trust/standard-input.json'), JSON.stringify(std, null, 2));
fs.writeFileSync(path.join(__dirname, 'verify/trust/metadata.json'), c.metadata);
console.log('solc', solc.version());
console.log('AgentPulseTrust initcode bytes', c.evm.bytecode.object.length / 2, 'runtime bytes', c.evm.deployedBytecode.object.length / 2);
