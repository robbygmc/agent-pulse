// Tests for AgentPulseTrust (v2) on a local ganache EVM.
// The REAL Agent Pulse v1 runtime code is planted at its mainnet address and a
// mock Agent ID registry is planted at the real registry address, so v2 talks
// to exactly the addresses it will use on BSC.
const assert = require('assert');
const ganache = require('ganache');
const { ethers } = require('ethers');
const AP = require('../build/AgentPulse.json');
const TR = require('../build/AgentPulseTrust.json');
const MOCK = require('../build/MockAgentID.json');

const AGENT_ID = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const PULSE_V1 = '0xF8a1b21506290693a4b7245702488dd2f885600a';
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
    if (errName && data && data !== '0x') {
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
  const start = 1795000000 - (1795000000 % DAY) + 3600; // 01:00 UTC on a fixed day
  const g = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: 'merge', chainId: 1337 },
    wallet: { totalAccounts: 30, deterministic: true },
    miner: { blockGasLimit: 30000000 },
  });
  const provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  await g.request({ method: 'evm_mine', params: [{ timestamp: start }] });
  await g.request({ method: 'evm_setAccountCode', params: [AGENT_ID, MOCK.deployedBytecode] });
  await g.request({ method: 'evm_setAccountCode', params: [PULSE_V1, AP.deployedBytecode] });

  const signers = await Promise.all([...Array(30).keys()].map((i) => provider.getSigner(i)));
  const addr = await Promise.all(signers.map((s) => s.getAddress()));
  const [A, B, C, D, S] = addr; // S = stranger without Agent ID
  const [sA, sB, sC, sD, sS] = signers;
  const mock = new ethers.Contract(AGENT_ID, MOCK.abi, sA);
  for (let i = 0; i < 30; i++) if (i !== 4) await (await mock.set(addr[i], 1)).wait();
  const pulse = new ethers.Contract(PULSE_V1, AP.abi, sA);

  const trust = await (await new ethers.ContractFactory(TR.abi, TR.bytecode, sA).deploy()).waitForDeployment();
  const iface = trust.interface;
  const T = (s) => trust.connect(s);
  const P = (s) => pulse.connect(s);

  async function advance(seconds) {
    await g.request({ method: 'evm_increaseTime', params: [seconds] });
    await g.request({ method: 'evm_mine', params: [] });
  }

  console.log('AgentPulseTrust tests');

  await t('constants point at mainnet Agent ID + v1', async () => {
    assert.equal(await trust.name(), 'Agent Pulse Trust');
    assert.equal((await trust.AGENT_ID()).toLowerCase(), AGENT_ID.toLowerCase());
    assert.equal((await trust.PULSE()).toLowerCase(), PULSE_V1.toLowerCase());
    assert.equal(await trust.ACTIVE_WINDOW_DAYS(), 3n);
    assert.equal(await trust.MAX_VOUCHES_GIVEN(), 20n);
    assert.equal(await trust.MAX_VOUCHES_RECEIVED(), 64n);
  });

  await t('no owner/admin functions, not payable, no receive', async () => {
    const names = TR.abi.filter((x) => x.type === 'function').map((x) => x.name);
    for (const bad of ['owner', 'transferOwnership', 'pause', 'upgradeTo', 'withdraw', 'setOwner']) assert.ok(!names.includes(bad), bad);
    assert.ok(!TR.abi.some((x) => x.stateMutability === 'payable' || x.type === 'receive' || x.type === 'fallback'));
    await expectRevert(sA.sendTransaction({ to: await trust.getAddress(), value: 1n }), null);
  });

  await t('reputation is 0 before any pulse', async () => {
    assert.equal(await trust.reputationOf(A), 0n);
    assert.equal(await trust.isTrusted(A, 1), false);
    assert.equal(await trust.isTrusted(A, 0), true);
  });

  await t('voucher who never pulsed reverts VoucherNotActive', async () => {
    await expectRevert(T(sA).vouch.staticCall(B), 'VoucherNotActive', iface);
  });

  // A, B, C pulse on v1 (real v1 code)
  for (const s of [sA, sB, sC]) await (await P(s).checkIn()).wait();

  await t('base score from a single v1 pulse = 10+20+5 = 35', async () => {
    const b = await trust.reputationBreakdown(A);
    assert.equal(b.base, 35n);
    assert.equal(b.vouchPoints, 0n);
    assert.equal(b.decayPct, 100n);
    assert.equal(b.score, 35n);
  });

  await t('stranger without Agent ID cannot vouch', async () => {
    await expectRevert(T(sS).vouch.staticCall(A), 'NotAgentIdHolder', iface);
  });

  await t('cannot vouch for a non-holder or the zero address', async () => {
    await expectRevert(T(sA).vouch.staticCall(S), 'TargetNotAgentIdHolder', iface);
    await expectRevert(T(sA).vouch.staticCall(ethers.ZeroAddress), 'TargetNotAgentIdHolder', iface);
  });

  await t('self-vouch reverts', async () => {
    await expectRevert(T(sA).vouch.staticCall(A), 'SelfVouch', iface);
  });

  await t('vouch works, emits event, updates lists and counts', async () => {
    const rc = await (await T(sA).vouch(B)).wait();
    const ev = rc.logs.map((l) => iface.parseLog(l)).find((x) => x && x.name === 'Vouched');
    assert.equal(ev.args.voucher, A);
    assert.equal(ev.args.agent, B);
    assert.equal(await trust.hasVouched(A, B), true);
    assert.deepEqual([...(await trust.vouchesOf(B))], [A]);
    assert.deepEqual([...(await trust.vouchesGivenBy(A))], [B]);
    const c = await trust.vouchCounts(B);
    assert.equal(c.received, 1n);
    assert.equal(await trust.totalVouches(), 1n);
  });

  await t('double vouch reverts AlreadyVouched', async () => {
    await expectRevert(T(sA).vouch.staticCall(B), 'AlreadyVouched', iface);
  });

  await t('active voucher adds 50 + its live streak (1) = 51', async () => {
    const b = await trust.reputationBreakdown(B);
    assert.equal(b.vouchPoints, 51n);
    assert.equal(b.activeVouchers, 1n);
    assert.equal(b.score, 35n + 51n);
    assert.equal(await trust.isTrusted(B, 86), true);
    assert.equal(await trust.isTrusted(B, 87), false);
  });

  await t('vouching for a holder that never pulsed is allowed but scores 0 until it pulses', async () => {
    await (await T(sA).vouch(D)).wait();
    assert.equal(await trust.reputationOf(D), 0n);
    await (await P(sD).checkIn()).wait();
    assert.equal(await trust.reputationOf(D), 35n + 51n);
  });

  await t('revoke removes the vouch (swap-pop keeps lists consistent)', async () => {
    await (await T(sC).vouch(B)).wait();
    assert.equal((await trust.vouchesOf(B)).length, 2);
    await (await T(sA).revoke(B)).wait();
    assert.deepEqual([...(await trust.vouchesOf(B))], [C]);
    assert.deepEqual([...(await trust.vouchesGivenBy(A))], [D]);
    assert.equal(await trust.hasVouched(A, B), false);
    assert.equal(await trust.totalVouches(), 2n);
    await expectRevert(T(sA).revoke.staticCall(B), 'NotVouched', iface);
    // can vouch again after revoke
    await (await T(sA).vouch(B)).wait();
    assert.deepEqual([...(await trust.vouchesOf(B))], [C, A]);
  });

  await t('streak grows base score over days', async () => {
    await advance(DAY);
    await (await P(sB).checkIn()).wait();
    const b = await trust.reputationBreakdown(B);
    // checkIns 2, streak 2, best 2 -> 20 + 40 + 10 = 70
    assert.equal(b.base, 70n);
    assert.equal(b.decayPct, 100n);
  });

  await t('voucher becomes dormant after 3 missed days -> weight 10; cannot vouch while dormant', async () => {
    // A last pulsed day0. Now day1. Move to day3 (diff 3 -> not active).
    await advance(2 * DAY);
    await (await P(sB).checkIn()).wait(); // keep B alive (streak resets: missed day2)
    const b = await trust.reputationBreakdown(B);
    // vouchers C and A both last pulsed day0 -> dormant -> 10 each
    assert.equal(b.activeVouchers, 0n);
    assert.equal(b.vouchPoints, 20n);
    await expectRevert(T(sA).vouch.staticCall(C), 'VoucherNotActive', iface);
  });

  await t('dormant voucher can still revoke', async () => {
    await (await T(sC).revoke(B)).wait();
    assert.equal(await trust.hasVouched(C, B), false);
  });

  await t('decay: 1-day grace, then -10% per missed day, 0 after 11 days', async () => {
    // D last pulsed day0; today is day3 -> since 3 -> decay 80
    let b = await trust.reputationBreakdown(D);
    assert.equal(b.decayPct, 80n);
    assert.equal(b.score, ((b.base + b.vouchPoints) * 80n) / 100n);
    await advance(8 * DAY); // day11 -> since 11 -> 0
    b = await trust.reputationBreakdown(D);
    assert.equal(b.decayPct, 0n);
    assert.equal(b.score, 0n);
    // pulsing again restores the multiplier
    await (await P(sD).checkIn()).wait();
    b = await trust.reputationBreakdown(D);
    assert.equal(b.decayPct, 100n);
    assert.ok(b.score > 0n);
  });

  await t('losing the Agent ID zeroes reputation and voucher weight', async () => {
    await (await P(sA).checkIn()).wait();
    assert.ok((await trust.reputationOf(A)) > 0n);
    await (await mock.set(A, 0)).wait();
    assert.equal(await trust.reputationOf(A), 0n);
    // A still vouches for B and D, but now counts 0
    const b = await trust.reputationBreakdown(D);
    assert.equal(b.vouchPoints, 0n);
    await (await mock.set(A, 1)).wait();
    assert.equal((await trust.reputationBreakdown(D)).vouchPoints, 51n);
  });

  await t('given cap: max 20 active vouches per voucher', async () => {
    // fresh voucher E = addr[5]
    const sE = signers[5];
    await (await P(sE).checkIn()).wait();
    for (let i = 6; i < 26; i++) await (await T(sE).vouch(addr[i])).wait();
    assert.equal((await trust.vouchCounts(addr[5])).given, 20n);
    await expectRevert(T(sE).vouch.staticCall(addr[26]), 'TooManyVouchesGiven', iface);
    await (await T(sE).revoke(addr[6])).wait();
    await (await T(sE).vouch(addr[26])).wait();
    assert.equal((await trust.vouchCounts(addr[5])).given, 20n);
  });

  await t('received cap: max 64 vouches per agent', async () => {
    // Use fresh random wallets as vouchers (Agent ID via mock, pulse on v1).
    const target = addr[27];
    const funder = signers[29];
    await (await P(signers[27]).checkIn()).wait();
    const wallets = [];
    for (let i = 0; i < 65; i++) {
      const w = ethers.Wallet.createRandom().connect(provider);
      wallets.push(w);
      await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther('1') })).wait();
      await (await mock.set(w.address, 1)).wait();
      await (await P(w).checkIn()).wait();
    }
    for (let i = 0; i < 64; i++) await (await T(wallets[i]).vouch(target)).wait();
    assert.equal((await trust.vouchCounts(target)).received, 64n);
    await expectRevert(T(wallets[64]).vouch.staticCall(target), 'TooManyVouchesReceived', iface);
    // isTrusted with 64 vouchers stays cheap enough for on-chain use
    const b = await trust.reputationBreakdown(target);
    assert.equal(b.activeVouchers, 64n);
    assert.equal(b.vouchPoints, 64n * 51n);
    const gas = await trust.isTrusted.estimateGas(target, 1);
    console.log('     isTrusted gas with 64 active vouchers:', gas.toString());
    assert.ok(gas < 1_500_000n);
  });

  await t('vouch rejects value (not payable)', async () => {
    await expectRevert(T(signers[28]).vouch(B, { value: 1n }), null);
  });

  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
