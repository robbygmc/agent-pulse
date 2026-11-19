# Agent Pulse

**A liveness and streak registry for AI agents on BNB Smart Chain.**

Every address that holds an Agent ID (the non-transferable `name.ai` identity of an Agentic Wallet) can *pulse* once per UTC day. The contract records each agent's last active day, current streak, best streak and lifetime pulses. Any service, human or contract can then ask on-chain whether an agent is alive and how reliable it has been.

The first pulse mints a free **soulbound badge** (ERC-721 + ERC-5192, non-transferable). Its artwork and metadata are generated fully on-chain from the live stats.

- Live site: https://robbygmc.github.io/agent-pulse/
- Contract (BSC, chain id 56): [`0xF8a1b21506290693a4b7245702488dd2f885600a`](https://bscscan.com/address/0xF8a1b21506290693a4b7245702488dd2f885600a)
- Agent ID registry used for gating: `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` (`balanceOf(address) > 0` = holder)

## How Agent ID is used

Agent ID is the core of the product, not an add-on:

1. **Access control:** `checkIn()` reverts with `NotAgentIdHolder` unless `AgentID.balanceOf(msg.sender) > 0`. Only real Agent ID identities can build a pulse record.
2. **Identity → reputation:** an Agent ID says *who* an agent is. Agent Pulse adds *whether it is still running*, as a public on-chain record keyed to that identity.
3. **Composable liveness:** other contracts can gate on `isActive(agent, withinDays)`, for example to serve only agents that were alive in the last 7 days.

## Pulse (for agents)

| Field | Value |
|---|---|
| Chain | BNB Smart Chain (56) |
| To | `0xF8a1b21506290693a4b7245702488dd2f885600a` |
| Function | `checkIn()` |
| Calldata | `0x183ff085` |
| Value | `0` |

It costs network gas only. There is no fee and no approval. Your wallet still shows you the transaction and you confirm it as usual. A second pulse on the same UTC day reverts with `AlreadyPulsedToday`.

## Read (for services)

```solidity
interface IAgentPulse {
    function isActive(address agent, uint256 withinDays) external view returns (bool);
    function pulseOf(address agent) external view returns (
        uint256 badgeId, uint256 lastDay, uint256 streak,
        uint256 bestStreak, uint256 checkIns, bool pulsedToday);
    function totalAgents() external view returns (uint256);
    function totalCheckIns() external view returns (uint256);
}
```

`streak` in `pulseOf` is the *live* streak: it drops to 0 once an agent misses a full UTC day.

## v2: Agent Pulse Trust (vouches + reputation)

Agent ID says an agent exists. Agent Pulse says it is alive. **Agent Pulse Trust** says other living agents stand behind it.

- Contract (BSC, chain id 56): [`0x6A78EC174ccdF16B16c823f9E5579A3994FA5395`](https://bscscan.com/address/0x6A78EC174ccdF16B16c823f9E5579A3994FA5395) — source [`contracts/AgentPulseTrust.sol`](contracts/AgentPulseTrust.sol)
- A companion contract: it only **reads** v1 (`pulseOf`, `isActive`) and the Agent ID registry (`balanceOf`). v1 is unchanged.

| Function | Selector | What it does |
|---|---|---|
| `vouch(address agent)` | `0xdd66e16b` | caller (Agent ID holder, checked in on v1 within 3 UTC days) vouches for another Agent ID holder |
| `revoke(address agent)` | `0x74a8f103` | withdraw your vouch, always allowed |
| `reputationOf(address)` | `0xdb89c044` | deterministic score |
| `reputationBreakdown(address)` | `0x41ccb809` | base, vouchPoints, activeVouchers, decayPct, score |
| `isTrusted(address,uint256)` | `0x8ea43718` | `reputationOf(agent) >= minScore` |
| `vouchesOf(address)` / `vouchesGivenBy(address)` / `vouchCounts(address)` / `hasVouched(a,b)` | | lists and counts |

### Reputation formula

```
if agent holds no Agent ID or never checked in on v1 -> 0
base  = 10*min(checkIns,365) + 20*min(liveStreak,90) + 5*min(bestStreak,365)
vouch = sum over current vouchers v of:
          0                     if v no longer holds an Agent ID
          50 + min(liveStreak_v, 50)  if v checked in on v1 within the last 3 UTC days
          10                    otherwise (dormant voucher)
decay = 100 if last check-in was today or yesterday,
        else max(0, 100 - 10*(daysSinceLastCheckIn - 1))   (percent)
score = (base + vouch) * decay / 100
```

Everything is computed live in a view: nothing is cached, nothing can be set by anyone.

Anti-farming limits: vouchers must hold an Agent ID **and** be active on v1; no self-vouch; one vouch per pair; max 20 active vouches given and max 64 carried per agent (keeps `isTrusted` around 0.7M gas even at the cap).

### v2 owner permissions disclosure

**None.** No owner, no admin, no pause, no upgrade, no payable function, no token, no withdraw, no approvals, no rewards. It never holds or moves any asset.

## Agent skill

A ready-to-use skill for any AI agent with an Agentic Wallet: [`skill/SKILL.md`](skill/SKILL.md) (also at https://robbygmc.github.io/agent-pulse/skill/SKILL.md). Daily check-in, optional vouching, reputation reads. It always keeps the wallet's preview and the user's confirmation in the loop, and never touches keys or QR logins.

## Owner permissions disclosure

**None.** The contract has no owner, no admin, no pause, no upgrade path, no mint authority, no payable function and no withdraw. It never holds, moves or approves any user asset. Badges can only be minted to the caller by the caller's own first pulse, and they cannot be transferred or approved.

## Safety

- No QR / pairing-code login and no stored sessions: you pulse from your own wallet or agent.
- No credentials are collected.
- No token, no airdrop, no rewards and no returns of any kind are offered.
- The site shows wallet addresses only. It does not resolve or look up names.

## Build and test

```bash
npm install
npm test   # v1: compiles with solc 0.8.28 and runs 16 tests on a local EVM
npm run test:trust   # v2: 21 tests; the real v1 runtime code is planted at its mainnet address
```

Compiler settings: solc `v0.8.28+commit.7893614a`, optimizer enabled, 200 runs, EVM version `paris`. The standard-JSON input used for verification is in [`verify/standard-input.json`](verify/standard-input.json).

Deployment: via the public CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` with salt `keccak256("agent-pulse/v1")` = `0xae63fb6ff3fe9304abb3b3443e5793790461208cb186810514172ae7d1541d84`. No constructor arguments.

v2 deployment: same CREATE2 deployer, salt `keccak256("agent-pulse-trust/v1")` = `0x9288bdf067deed88d01ff675d7ed4c532e20380de30771099475c4d464821d19`, no constructor arguments, same compiler settings. Standard-JSON input: [`verify/trust/standard-input.json`](verify/trust/standard-input.json).

## License

MIT, see [LICENSE](LICENSE).

Agent Pulse is an independent open-source project built for the Agent ID Hackathon. It is not affiliated with or endorsed by any exchange.
