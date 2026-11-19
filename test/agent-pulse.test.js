// Tests for AgentPulse on a local ganache EVM with a mock Agent ID registry
// planted at the real registry address.
const assert = require('assert');
const ganache = require('ganache');
const { ethers } = require('ethers');
const AP = require('../build/AgentPulse.json');
const MOCK = require('../build/MockAgentID.json');

const AGENT_ID = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const DAY = 86400;

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log('  ok -', name);
}

async function expectRevert(p, errName, iface) {
  try {
    const tx = await p;
    if (tx && tx.wait) await tx.wait();
  } catch (e) {
    let data = e.data || (e.info && e.info.error && e.info.error.data) || (e.error && e.error.data);
    if (data && typeof data === 'object') data = data.data || data.result;
    if (errName && data) {
      const parsed = iface.parseError(data);
      assert.equal(parsed && parsed.name, errName, 'wrong revert: ' + (parsed && parsed.name));
    } else if (errName) {
      assert.ok(String(e.message).includes(errName) || e.revert?.name === errName, 'revert reason not ' + errName + ': ' + e.message);
    }
    return;
  }
  throw new Error('expected revert ' + errName);
}

(async () => {
  const start = 1795000000; // fixed genesis time
  const g = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: 'merge', chainId: 1337 },
    wallet: { totalAccounts: 4, deterministic: true },
    miner: { blockGasLimit: 30000000 },
  });
  const provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  await g.request({ method: 'evm_mine', params: [{ timestamp: start }] });

  // Plant mock registry code at the real Agent ID address
  await g.request({ method: 'evm_setAccountCode', params: [AGENT_ID, MOCK.deployedBytecode] });
  const [agentA, agentB, stranger, other] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const mock = new ethers.Contract(AGENT_ID, MOCK.abi, agentA);
  await (await mock.set(await agentA.getAddress(), 1)).wait();
  await (await mock.set(await agentB.getAddress(), 1)).wait();

  const f = new ethers.ContractFactory(AP.abi, AP.bytecode, agentA);
  const pulse = await f.deploy();
  await pulse.waitForDeployment();
  const iface = pulse.interface;
  const A = await agentA.getAddress();
  const B = await agentB.getAddress();
  const S = await stranger.getAddress();

  async function advance(seconds) {
    await g.request({ method: 'evm_increaseTime', params: [seconds] });
    await g.request({ method: 'evm_mine', params: [] });
  }

  console.log('AgentPulse tests');

  await t('constants', async () => {
    assert.equal(await pulse.name(), 'Agent Pulse');
    assert.equal(await pulse.symbol(), 'PULSE');
    assert.equal((await pulse.AGENT_ID()).toLowerCase(), AGENT_ID.toLowerCase());
  });

  await t('non-holder reverts NotAgentIdHolder', async () => {
    await expectRevert(pulse.connect(stranger).checkIn(), 'NotAgentIdHolder', iface);
    const p = await pulse.pulseOf(S);
    assert.equal(p.checkIns, 0n);
  });

  await t('first check-in: streak 1, badge #1 minted, events', async () => {
    const rc = await (await pulse.connect(agentA).checkIn()).wait();
    const names = rc.logs.map((l) => iface.parseLog(l).name);
    assert.deepEqual(names, ['Transfer', 'Locked', 'Pulsed']);
    const p = await pulse.pulseOf(A);
    assert.equal(p.badgeId, 1n);
    assert.equal(p.streak, 1n);
    assert.equal(p.bestStreak, 1n);
    assert.equal(p.checkIns, 1n);
    assert.equal(p.pulsedToday, true);
    assert.equal(await pulse.ownerOf(1), A);
    assert.equal(await pulse.balanceOf(A), 1n);
    assert.equal(await pulse.totalAgents(), 1n);
    assert.equal(await pulse.totalCheckIns(), 1n);
    assert.equal(await pulse.locked(1), true);
    console.log('     first checkIn gas', rc.gasUsed.toString());
  });

  await t('second check-in same UTC day reverts AlreadyPulsedToday', async () => {
    await expectRevert(pulse.connect(agentA).checkIn(), 'AlreadyPulsedToday', iface);
  });

  await t('next day continues streak, badge not re-minted', async () => {
    await advance(DAY);
    const rc = await (await pulse.connect(agentA).checkIn()).wait();
    const names = rc.logs.map((l) => iface.parseLog(l).name);
    assert.deepEqual(names, ['Pulsed']);
    const p = await pulse.pulseOf(A);
    assert.equal(p.streak, 2n);
    assert.equal(p.bestStreak, 2n);
    assert.equal(p.checkIns, 2n);
    assert.equal(p.badgeId, 1n);
    assert.equal(await pulse.totalAgents(), 1n);
    console.log('     repeat checkIn gas', rc.gasUsed.toString());
  });

  await t('day 3 -> streak 3', async () => {
    await advance(DAY);
    await (await pulse.connect(agentA).checkIn()).wait();
    assert.equal((await pulse.pulseOf(A)).streak, 3n);
  });

  await t('second agent gets badge #2', async () => {
    await (await pulse.connect(agentB).checkIn()).wait();
    assert.equal(await pulse.ownerOf(2), B);
    assert.equal(await pulse.totalAgents(), 2n);
    assert.equal(await pulse.totalSupply(), 2n);
    assert.equal(await pulse.totalCheckIns(), 4n);
  });

  await t('isActive window', async () => {
    assert.equal(await pulse.isActive(A, 1), true);
    assert.equal(await pulse.isActive(S, 30), false);
    await advance(DAY * 2); // A missed one day
    assert.equal(await pulse.isActive(A, 1), false);
    assert.equal(await pulse.isActive(A, 2), false);
    assert.equal(await pulse.isActive(A, 3), true);
    const p = await pulse.pulseOf(A);
    assert.equal(p.streak, 0n, 'live streak drops to 0 after a missed day');
    assert.equal(p.bestStreak, 3n);
    assert.equal(p.pulsedToday, false);
  });

  await t('missed day resets streak to 1, best kept', async () => {
    await (await pulse.connect(agentA).checkIn()).wait();
    const p = await pulse.pulseOf(A);
    assert.equal(p.streak, 1n);
    assert.equal(p.bestStreak, 3n);
    assert.equal(p.checkIns, 4n);
  });

  await t('UTC day boundary, not 24h: 23:59:30 then 00:00:05 are consecutive days', async () => {
    const now = parseInt((await g.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp, 16);
    const nextMidnight = (Math.floor(now / DAY) + 1) * DAY;
    await g.request({ method: 'evm_mine', params: [{ timestamp: nextMidnight + DAY - 30 }] });
    await (await pulse.connect(agentA).checkIn()).wait();
    assert.equal((await pulse.pulseOf(A)).streak, 2n);
    await g.request({ method: 'evm_mine', params: [{ timestamp: nextMidnight + DAY + 5 }] });
    await (await pulse.connect(agentA).checkIn()).wait();
    assert.equal((await pulse.pulseOf(A)).streak, 3n);
  });

  await t('transfers and approvals revert Soulbound', async () => {
    await expectRevert(pulse.connect(agentA).transferFrom(A, B, 1), 'Soulbound', iface);
    await expectRevert(pulse.connect(agentA)['safeTransferFrom(address,address,uint256)'](A, B, 1), 'Soulbound', iface);
    await expectRevert(pulse.connect(agentA)['safeTransferFrom(address,address,uint256,bytes)'](A, B, 1, '0x'), 'Soulbound', iface);
    await expectRevert(pulse.connect(agentA).approve(B, 1), 'Soulbound', iface);
    await expectRevert(pulse.connect(agentA).setApprovalForAll(B, true), 'Soulbound', iface);
    assert.equal(await pulse.ownerOf(1), A);
    assert.equal(await pulse.getApproved(1), ethers.ZeroAddress);
    assert.equal(await pulse.isApprovedForAll(A, B), false);
  });

  await t('unknown badge reverts NoSuchBadge', async () => {
    await expectRevert(pulse.ownerOf(99), 'NoSuchBadge', iface);
    await expectRevert(pulse.tokenURI(99), 'NoSuchBadge', iface);
  });

  await t('supportsInterface', async () => {
    for (const id of ['0x01ffc9a7', '0x80ac58cd', '0x5b5e139f', '0xb45a3c0e']) assert.equal(await pulse.supportsInterface(id), true, id);
    assert.equal(await pulse.supportsInterface('0xffffffff'), false);
  });

  await t('tokenURI decodes to JSON with on-chain SVG reflecting stats', async () => {
    const uri = await pulse.tokenURI(1);
    assert.ok(uri.startsWith('data:application/json;base64,'));
    const json = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
    assert.equal(json.name, 'Agent Pulse #1');
    const attr = Object.fromEntries(json.attributes.map((a) => [a.trait_type, a.value]));
    assert.deepEqual(attr, { Streak: 3, 'Best Streak': 3, Pulses: 6 });
    assert.ok(json.image.startsWith('data:image/svg+xml;base64,'));
    const svg = Buffer.from(json.image.split(',')[1], 'base64').toString('utf8');
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
    assert.ok(svg.includes('#1') && svg.includes('STREAK') && svg.includes('>6<'));
    require('fs').writeFileSync(require('path').join(__dirname, '../build/sample-badge.svg'), svg);
  });

  await t('losing Agent ID blocks further pulses', async () => {
    await mock.set(B, 0).then((x) => x.wait());
    await advance(DAY);
    await expectRevert(pulse.connect(agentB).checkIn(), 'NotAgentIdHolder', iface);
  });

  await t('contract rejects value (no payable path)', async () => {
    await expectRevert(agentA.sendTransaction({ to: await pulse.getAddress(), value: 1 }), null, iface);
    await expectRevert(agentA.sendTransaction({ to: await pulse.getAddress(), data: iface.encodeFunctionData('checkIn'), value: 1 }), null, iface);
    assert.equal(await provider.getBalance(await pulse.getAddress()), 0n);
  });

  console.log(`\n${passed} tests passed`);
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
