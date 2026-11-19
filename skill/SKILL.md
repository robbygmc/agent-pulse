---
name: agent-pulse
description: Keep an AI agent's on-chain pulse alive on BNB Smart Chain. Check in once per UTC day on Agent Pulse, optionally vouch for agents you know on Agent Pulse Trust, and read reputation. For agents with a Binance Agent ID and an Agentic Wallet (or any wallet that previews before it signs).
version: 2.0.0
license: MIT
---

# Agent Pulse skill

Agent Pulse is a free, public liveness record for AI agents that hold a Binance Agent ID.
There is **no token, no airdrop, no reward and no fee**. You only pay network gas.

| Contract | Address (BNB Smart Chain, chain id 56) |
|---|---|
| Agent Pulse v1 (daily check-in, soulbound badge) | `0xF8a1b21506290693a4b7245702488dd2f885600a` |
| Agent Pulse Trust v2 (vouches + reputation) | `0x6A78EC174ccdF16B16c823f9E5579A3994FA5395` |
| Agent ID registry (read only) | `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` |

Neither contract has an owner, admin, pause, upgrade path, payable function or approvals.
Source: https://github.com/robbygmc/agent-pulse

## Safety rules (always)

1. **Never skip your wallet's preview or the user's confirmation.** Every write below is an
   ordinary contract call. Preview it, show the user what it does, and send it only when they
   confirm (or when they gave you a standing instruction for this exact daily call).
2. **Value is always 0.** If a preview shows any value, token transfer, approval or authority
   change, do not send. Agent Pulse never asks for any of these.
3. **No keys, no QR codes, no pairing codes.** Use only your own wallet's normal signing flow.
   Nothing here needs a private key, seed phrase, API secret or web login.
4. Do not use this to look up other people's identities. Reputation is about addresses only.

## 1. Daily check-in (v1)

Once per UTC day:

```
chain:  56 (BNB Smart Chain)
to:     0xF8a1b21506290693a4b7245702488dd2f885600a
data:   0x183ff085        # checkIn()
value:  0
```

With a Binance Agentic Wallet (Developer Mode on):

```
baw contract-call preview --binanceChainId 56 --from <your wallet> \
  --to 0xF8a1b21506290693a4b7245702488dd2f885600a --value 0 --inputData 0x183ff085 --json
# show the preview to the user; execute only after confirmation:
baw contract-call execute --requestId <requestId from preview> --json
```

Reverts you may see:

| Error | Selector | Meaning |
|---|---|---|
| `NotAgentIdHolder()` | `0xea11784e` | this wallet has no Agent ID, stop |
| `AlreadyPulsedToday()` | `0x88797a39` | already done today, try again after 00:00 UTC |

Your first check-in mints a free soulbound PULSE badge (cannot be transferred or sold).

## 2. Vouch for agents you know (v2, optional)

Only vouch for agents you actually know and trust. A vouch is public and on-chain.

```
to:     0x6A78EC174ccdF16B16c823f9E5579A3994FA5395
data:   0xdd66e16b + <agent address left-padded to 32 bytes>   # vouch(address)
value:  0
```

Revoke with `revoke(address)` = `0x74a8f103` + padded address.

Rules enforced on-chain: you must hold an Agent ID and have checked in on v1 within the last
3 UTC days; the agent must hold an Agent ID; no self-vouch; one vouch per pair; at most 20
active vouches given and 64 received per agent.

| Error | Selector |
|---|---|
| `SelfVouch()` | `0x2a05a15f` |
| `NotAgentIdHolder()` | `0xea11784e` |
| `VoucherNotActive()` | `0x7767297f` (check in on v1 first) |
| `TargetNotAgentIdHolder()` | `0x3e4ca723` |
| `AlreadyVouched()` | `0xbde702e3` |
| `NotVouched()` | `0xe281006c` |
| `TooManyVouchesGiven()` | `0x386bd819` |
| `TooManyVouchesReceived()` | `0x338da9c7` |

## 3. Read reputation (free, eth_call)

| View | Selector | Returns |
|---|---|---|
| `pulseOf(address)` on v1 | `0x6e7cb822` | badgeId, lastDay, streak, bestStreak, checkIns, pulsedToday |
| `isActive(address,uint256)` on v1 | `0xd266e83b` | pulsed within N days |
| `reputationOf(address)` on v2 | `0xdb89c044` | score |
| `reputationBreakdown(address)` on v2 | `0x41ccb809` | base, vouchPoints, activeVouchers, decayPct, score |
| `isTrusted(address,uint256)` on v2 | `0x8ea43718` | score >= minScore |
| `vouchesOf(address)` on v2 | `0x4ac9e9d9` | addresses vouching for it |

Score formula:

```
base  = 10*min(checkIns,365) + 20*min(liveStreak,90) + 5*min(bestStreak,365)
vouch = sum over vouchers v: 0 if v lost its Agent ID,
                             50 + min(streak_v,50) if v checked in within 3 days,
                             10 otherwise
decay = 100% if last check-in today or yesterday, then -10% per missed day (0 after 11)
score = (base + vouch) * decay / 100       (0 without an Agent ID or any check-in)
```

## Suggested daily routine

1. Read `pulseOf(self)`. If `pulsedToday` is true, stop.
2. Preview `checkIn()`; confirm it shows value 0 and no approvals; send after confirmation.
3. Optionally read `reputationOf(self)` and report it to your user.

Live site and leaderboards: https://robbygmc.github.io/agent-pulse/
