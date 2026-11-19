// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/*
    Agent Pulse Trust — a vouch + reputation layer for AI agents on BNB Smart Chain.

    Companion to Agent Pulse v1 (0xF8a1b21506290693a4b7245702488dd2f885600a),
    the daily liveness + streak registry for Binance Agent ID holders.

    Agent ID says an agent exists. Agent Pulse says it is alive. Agent Pulse
    Trust says other living agents stand behind it:

      * vouch(agent)   an ACTIVE Agent ID holder (pulsed on v1 within the
                       last 3 UTC days) publicly vouches for another
                       Agent ID holder. One vouch per pair, revocable.
      * reputationOf   a deterministic score built from the agent's own
                       v1 record (check-ins, live streak, best streak) plus
                       the vouches it received, each weighted by how alive
                       the voucher is right now, then decayed if the agent
                       itself stops pulsing.
      * isTrusted      one call for any dApp: reputationOf(agent) >= minScore.

    Reputation formula (all integer math, read live, nothing cached):

      if agent holds no Agent ID or never pulsed on v1      -> 0
      base   = 10 * min(checkIns, 365)
             + 20 * min(liveStreak, 90)
             +  5 * min(bestStreak, 365)
      vouch  = sum over current vouchers v of weight(v), where
               weight(v) = 0                          if v no longer holds an Agent ID
                         = 50 + min(liveStreak(v), 50) if v pulsed within the last 3 UTC days
                         = 10                          otherwise (dormant voucher)
      decay  = daysSinceLastPulse <= 1 ? 100
             : max(0, 100 - 10 * (daysSinceLastPulse - 1))   (percent)
      score  = (base + vouch) * decay / 100

    Anti-farming limits: a voucher must hold an Agent ID AND be active on v1,
    may hold at most 20 active vouches at a time, and an agent can carry at
    most 64 vouches (so on-chain isTrusted() stays cheap). No self-vouch.

    Owner permissions: NONE. No owner, no admin, no pause, no upgrade path,
    no payable function, no token, no withdraw, no approvals, no rewards.
    The contract never holds or moves any user asset.
*/

interface IAgentID {
    function balanceOf(address owner) external view returns (uint256);
}

interface IAgentPulse {
    function pulseOf(address agent)
        external
        view
        returns (
            uint256 badgeId,
            uint256 lastDay,
            uint256 streak,
            uint256 bestStreak,
            uint256 checkIns,
            bool pulsedToday
        );

    function isActive(address agent, uint256 withinDays) external view returns (bool);
}

contract AgentPulseTrust {
    // ------------------------------------------------------------------ //
    // Constants
    // ------------------------------------------------------------------ //

    string public constant name = "Agent Pulse Trust";

    /// Binance Agent ID registry (SPACE ID Agent ID) on BSC.
    IAgentID public constant AGENT_ID = IAgentID(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);

    /// Agent Pulse v1 liveness registry on BSC.
    IAgentPulse public constant PULSE = IAgentPulse(0xF8a1b21506290693a4b7245702488dd2f885600a);

    /// A voucher must have pulsed on v1 within this many UTC days.
    uint256 public constant ACTIVE_WINDOW_DAYS = 3;
    /// Max active vouches one agent can give.
    uint256 public constant MAX_VOUCHES_GIVEN = 20;
    /// Max vouches one agent can carry.
    uint256 public constant MAX_VOUCHES_RECEIVED = 64;

    // ------------------------------------------------------------------ //
    // Storage
    // ------------------------------------------------------------------ //

    mapping(address => mapping(address => bool)) public hasVouched; // voucher => agent => vouched

    mapping(address => address[]) private _vouchers; // agent => who vouches for it
    mapping(address => address[]) private _given; // voucher => whom it vouches for
    mapping(address => mapping(address => uint256)) private _vIdx; // agent => voucher => index+1 in _vouchers[agent]
    mapping(address => mapping(address => uint256)) private _gIdx; // voucher => agent => index+1 in _given[voucher]

    /// Number of currently active vouches across all agents.
    uint256 public totalVouches;

    // ------------------------------------------------------------------ //
    // Events / errors
    // ------------------------------------------------------------------ //

    event Vouched(address indexed voucher, address indexed agent);
    event Revoked(address indexed voucher, address indexed agent);

    error NotAgentIdHolder();
    error VoucherNotActive();
    error TargetNotAgentIdHolder();
    error SelfVouch();
    error AlreadyVouched();
    error NotVouched();
    error TooManyVouchesGiven();
    error TooManyVouchesReceived();

    // ------------------------------------------------------------------ //
    // Vouch / revoke
    // ------------------------------------------------------------------ //

    /// @notice Publicly vouch for `agent`. Free (gas only). The caller must hold
    ///         an Agent ID and have pulsed on Agent Pulse v1 within 3 UTC days.
    function vouch(address agent) external {
        if (agent == msg.sender) revert SelfVouch();
        if (AGENT_ID.balanceOf(msg.sender) == 0) revert NotAgentIdHolder();
        if (!PULSE.isActive(msg.sender, ACTIVE_WINDOW_DAYS)) revert VoucherNotActive();
        if (agent == address(0) || AGENT_ID.balanceOf(agent) == 0) revert TargetNotAgentIdHolder();
        if (hasVouched[msg.sender][agent]) revert AlreadyVouched();
        if (_given[msg.sender].length >= MAX_VOUCHES_GIVEN) revert TooManyVouchesGiven();
        if (_vouchers[agent].length >= MAX_VOUCHES_RECEIVED) revert TooManyVouchesReceived();

        hasVouched[msg.sender][agent] = true;
        _vouchers[agent].push(msg.sender);
        _vIdx[agent][msg.sender] = _vouchers[agent].length;
        _given[msg.sender].push(agent);
        _gIdx[msg.sender][agent] = _given[msg.sender].length;
        unchecked {
            totalVouches += 1;
        }
        emit Vouched(msg.sender, agent);
    }

    /// @notice Withdraw your vouch for `agent`. Always allowed, even if you are
    ///         no longer active or no longer hold an Agent ID.
    function revoke(address agent) external {
        if (!hasVouched[msg.sender][agent]) revert NotVouched();
        hasVouched[msg.sender][agent] = false;
        _remove(_vouchers[agent], _vIdx[agent], msg.sender);
        _remove(_given[msg.sender], _gIdx[msg.sender], agent);
        unchecked {
            totalVouches -= 1;
        }
        emit Revoked(msg.sender, agent);
    }

    function _remove(address[] storage list, mapping(address => uint256) storage idx, address who) private {
        uint256 i = idx[who] - 1;
        uint256 last = list.length - 1;
        if (i != last) {
            address moved = list[last];
            list[i] = moved;
            idx[moved] = i + 1;
        }
        list.pop();
        delete idx[who];
    }

    // ------------------------------------------------------------------ //
    // Views
    // ------------------------------------------------------------------ //

    /// @notice Agents currently vouching for `agent`.
    function vouchesOf(address agent) external view returns (address[] memory) {
        return _vouchers[agent];
    }

    /// @notice Agents that `voucher` currently vouches for.
    function vouchesGivenBy(address voucher) external view returns (address[] memory) {
        return _given[voucher];
    }

    /// @notice (vouches received, vouches given) for `agent`.
    function vouchCounts(address agent) external view returns (uint256 received, uint256 given) {
        return (_vouchers[agent].length, _given[agent].length);
    }

    /// @notice Deterministic reputation score of `agent` (see formula above).
    function reputationOf(address agent) public view returns (uint256 score) {
        (, , , , score) = reputationBreakdown(agent);
    }

    /// @notice The parts of the reputation score.
    /// @return base        points from the agent's own v1 record
    /// @return vouchPoints points from vouches received (voucher-weighted)
    /// @return activeVouchers vouchers that are currently active on v1
    /// @return decayPct    0-100, falls 10 points per missed day after a 1-day grace
    /// @return score       (base + vouchPoints) * decayPct / 100
    function reputationBreakdown(address agent)
        public
        view
        returns (uint256 base, uint256 vouchPoints, uint256 activeVouchers, uint256 decayPct, uint256 score)
    {
        if (AGENT_ID.balanceOf(agent) == 0) return (0, 0, 0, 0, 0);
        (, uint256 lastDay, uint256 streak, uint256 best, uint256 checkIns, ) = PULSE.pulseOf(agent);
        if (checkIns == 0) return (0, 0, 0, 0, 0);

        base = 10 * _min(checkIns, 365) + 20 * _min(streak, 90) + 5 * _min(best, 365);

        address[] storage vs = _vouchers[agent];
        for (uint256 i = 0; i < vs.length; i++) {
            address v = vs[i];
            if (AGENT_ID.balanceOf(v) == 0) continue;
            (, uint256 vLast, uint256 vStreak, , uint256 vChecks, ) = PULSE.pulseOf(v);
            if (vChecks != 0 && _today() - vLast < ACTIVE_WINDOW_DAYS) {
                vouchPoints += 50 + _min(vStreak, 50);
                activeVouchers++;
            } else {
                vouchPoints += 10;
            }
        }

        uint256 since = _today() - lastDay;
        if (since <= 1) decayPct = 100;
        else if (since >= 11) decayPct = 0;
        else decayPct = 100 - 10 * (since - 1);

        score = ((base + vouchPoints) * decayPct) / 100;
    }

    /// @notice True if `agent`'s reputation is at least `minScore`.
    function isTrusted(address agent, uint256 minScore) external view returns (bool) {
        return reputationOf(agent) >= minScore;
    }

    function _today() private view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
