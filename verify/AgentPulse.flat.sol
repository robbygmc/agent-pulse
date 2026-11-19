// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/*
    Agent Pulse — a liveness + streak registry for AI agents on BNB Smart Chain.

    Any address holding a Binance Agent ID (.ai name, ERC-721 at
    0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F) can "pulse" once per UTC day.
    The contract keeps each agent's last active day, current streak, best
    streak and total check-ins, so any service can ask on-chain:
    "is this agent alive, and how reliably?"

    The first pulse mints a free soulbound (non-transferable, ERC-5192)
    badge whose artwork is generated fully on-chain from the live stats.

    Owner permissions: NONE. There is no owner, no admin, no pause, no mint
    authority, no upgrade path, no payable function and no withdraw.
    The contract never holds or moves any user asset and asks for no approval.
*/

interface IAgentID {
    function balanceOf(address owner) external view returns (uint256);
}

contract AgentPulse {
    // ------------------------------------------------------------------ //
    // Constants
    // ------------------------------------------------------------------ //

    string public constant name = "Agent Pulse";
    string public constant symbol = "PULSE";

    /// Binance Agent ID registry (SPACE ID Agent ID, symbol AI) on BSC.
    IAgentID public constant AGENT_ID = IAgentID(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);

    // ------------------------------------------------------------------ //
    // Storage
    // ------------------------------------------------------------------ //

    struct Stats {
        uint32 lastDay;    // UTC day number (block.timestamp / 1 days) of the last pulse
        uint32 streak;     // consecutive days ending at lastDay
        uint32 bestStreak; // longest streak ever
        uint32 checkIns;   // lifetime pulses
        uint32 badgeId;    // soulbound badge id (0 = none yet)
    }

    mapping(address => Stats) private _stats;
    mapping(uint256 => address) private _owners;

    /// Number of distinct agents that have pulsed (= badges minted).
    uint256 public totalAgents;
    /// Lifetime pulses across all agents.
    uint256 public totalCheckIns;

    // ------------------------------------------------------------------ //
    // Events
    // ------------------------------------------------------------------ //

    event Pulsed(address indexed agent, uint256 indexed day, uint256 streak, uint256 checkIns);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId); // ERC-5192

    // ------------------------------------------------------------------ //
    // Errors
    // ------------------------------------------------------------------ //

    error NotAgentIdHolder();
    error AlreadyPulsedToday();
    error Soulbound();
    error NoSuchBadge();

    // ------------------------------------------------------------------ //
    // Pulse
    // ------------------------------------------------------------------ //

    /// @notice Record today's pulse for the calling agent. Free (gas only),
    ///         once per UTC day, Agent ID holders only.
    /// @return streak the caller's streak after this pulse
    function checkIn() external returns (uint256 streak) {
        if (AGENT_ID.balanceOf(msg.sender) == 0) revert NotAgentIdHolder();

        uint32 day = uint32(block.timestamp / 1 days);
        Stats memory s = _stats[msg.sender];

        if (s.checkIns != 0) {
            if (s.lastDay == day) revert AlreadyPulsedToday();
            s.streak = (s.lastDay + 1 == day) ? s.streak + 1 : 1;
        } else {
            s.streak = 1;
        }
        if (s.streak > s.bestStreak) s.bestStreak = s.streak;
        s.lastDay = day;
        s.checkIns += 1;

        unchecked {
            totalCheckIns += 1;
        }

        if (s.badgeId == 0) {
            uint256 id = ++totalAgents;
            s.badgeId = uint32(id);
            _owners[id] = msg.sender;
            emit Transfer(address(0), msg.sender, id);
            emit Locked(id);
        }

        _stats[msg.sender] = s;
        emit Pulsed(msg.sender, day, s.streak, s.checkIns);
        return s.streak;
    }

    // ------------------------------------------------------------------ //
    // Views
    // ------------------------------------------------------------------ //

    /// @notice Current UTC day number used by the registry.
    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice Full liveness record of `agent`.
    /// @return badgeId       soulbound badge id (0 if never pulsed)
    /// @return lastDay       UTC day number of the last pulse
    /// @return streak        LIVE streak: 0 if the agent missed yesterday and today
    /// @return bestStreak    longest streak ever
    /// @return checkIns      lifetime pulses
    /// @return pulsedToday   true if the agent already pulsed this UTC day
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
        )
    {
        Stats memory s = _stats[agent];
        return (s.badgeId, s.lastDay, _liveStreak(s), s.bestStreak, s.checkIns, s.checkIns != 0 && s.lastDay == today());
    }

    /// @notice True if `agent` pulsed within the last `withinDays` UTC days
    ///         (withinDays = 1 means "today", 2 means "today or yesterday", ...).
    function isActive(address agent, uint256 withinDays) external view returns (bool) {
        Stats memory s = _stats[agent];
        if (s.checkIns == 0) return false;
        return today() - s.lastDay < withinDays;
    }

    function _liveStreak(Stats memory s) private view returns (uint256) {
        if (s.checkIns == 0) return 0;
        return today() - s.lastDay <= 1 ? s.streak : 0;
    }

    // ------------------------------------------------------------------ //
    // Soulbound ERC-721 (read side) + ERC-5192
    // ------------------------------------------------------------------ //

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x80ac58cd // ERC-721
            || id == 0x5b5e139f // ERC-721 Metadata
            || id == 0xb45a3c0e; // ERC-5192
    }

    function totalSupply() external view returns (uint256) {
        return totalAgents;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _stats[owner].badgeId == 0 ? 0 : 1;
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _owners[tokenId];
        if (owner == address(0)) revert NoSuchBadge();
    }

    function locked(uint256 tokenId) external view returns (bool) {
        ownerOf(tokenId);
        return true;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    // ------------------------------------------------------------------ //
    // On-chain metadata
    // ------------------------------------------------------------------ //

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        address owner = ownerOf(tokenId);
        Stats memory s = _stats[owner];
        string memory id = _str(tokenId);
        string memory live = _str(_liveStreak(s));
        string memory best = _str(s.bestStreak);
        string memory total = _str(s.checkIns);

        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
            '<stop offset="0" stop-color="#0b1020"/><stop offset="1" stop-color="#1a0f2e"/></linearGradient></defs>',
            '<rect width="400" height="400" rx="28" fill="url(#g)"/>',
            '<path d="M30 210h80l20-50 30 100 30-140 30 120 20-30h130" fill="none" stroke="#ff4f8b" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
            '<text x="30" y="60" fill="#fff" font-family="monospace" font-size="26" font-weight="bold">AGENT PULSE</text>',
            '<text x="370" y="60" fill="#ff4f8b" font-family="monospace" font-size="22" text-anchor="end">#', id, '</text>',
            _row(300, "STREAK", live),
            _row(335, "BEST", best),
            _row(370, "PULSES", total),
            '</svg>'
        );

        string memory json = string.concat(
            '{"name":"Agent Pulse #', id,
            '","description":"Soulbound liveness badge for an AI agent holding an Agent ID. Free, non-transferable, no token, no rewards.",',
            '"attributes":[{"trait_type":"Streak","value":', live,
            '},{"trait_type":"Best Streak","value":', best,
            '},{"trait_type":"Pulses","value":', total,
            '}],"image":"data:image/svg+xml;base64,', _b64(bytes(svg)), '"}'
        );
        return string.concat("data:application/json;base64,", _b64(bytes(json)));
    }

    function _row(uint256 y, string memory label, string memory value) private pure returns (string memory) {
        string memory ys = _str(y);
        return string.concat(
            '<text x="30" y="', ys, '" fill="#9aa3c7" font-family="monospace" font-size="18">', label, '</text>',
            '<text x="370" y="', ys, '" fill="#fff" font-family="monospace" font-size="20" text-anchor="end">', value, '</text>'
        );
    }

    function _str(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }

    bytes private constant _TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function _b64(bytes memory data) private pure returns (string memory) {
        uint256 len = data.length;
        if (len == 0) return "";
        bytes memory out = new bytes(4 * ((len + 2) / 3));
        bytes memory table = _TABLE;
        uint256 j;
        for (uint256 i = 0; i < len; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < len ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < len ? uint8(data[i + 2]) : 0;
            uint256 n = (a << 16) | (b << 8) | c;
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = i + 1 < len ? table[(n >> 6) & 63] : bytes1("=");
            out[j++] = i + 2 < len ? table[n & 63] : bytes1("=");
        }
        return string(out);
    }
}
