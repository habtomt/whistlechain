// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title WhistleChainToken ( UZHETHs)
/// @notice Demo ERC-20 token used for whistleblower staking and rewards.
/// @dev On the UZH Ethereum test network UZHETHs token, the mint() function 
/// here simulates that faucet.
contract WhistleChainToken is ERC20, Ownable {
    uint8 private constant DECIMALS = 18;

    constructor(uint256 initialSupply) ERC20("WhistleChain Token", " UZHETHs") Ownable(msg.sender) {
        _mint(msg.sender, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Owner-controlled faucet, used only to fund demo accounts
    ///         (whistleblowers, validators, treasury donors) with test tokens.
    function faucetMint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
