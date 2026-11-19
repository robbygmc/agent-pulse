// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Test-only stand-in for the Agent ID registry (balanceOf only).
contract MockAgentID {
    mapping(address => uint256) public balanceOf;

    function set(address who, uint256 n) external {
        balanceOf[who] = n;
    }
}
