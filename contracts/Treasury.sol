// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Treasury
/// @notice Transparent reward pool funded by organizations/donors and by
///         forfeited whistleblower stakes. Only the authorized ReportRegistry
///         contract may trigger payouts, so all disbursement logic (and thus
///         all payout events) is auditable on-chain.
contract Treasury is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error NotAuthorized();
    error ZeroAddress();
    error InsufficientTreasuryBalance();

    IERC20 public immutable rewardToken;
    address public reportRegistry; // only this address may call payReward / receiveForfeitedStake

    uint256 public totalDonated;
    uint256 public totalForfeited;
    uint256 public totalPaidOut;

    event ReportRegistrySet(address indexed reportRegistry);
    event Donation(address indexed donor, uint256 amount);
    event ForfeitedStakeReceived(uint256 indexed reportId, uint256 amount);
    event RewardPaid(uint256 indexed reportId, address indexed recipient, uint256 amount);

    modifier onlyReportRegistry() {
        if (msg.sender != reportRegistry) revert NotAuthorized();
        _;
    }

    constructor(address _rewardToken) Ownable(msg.sender) {
        if (_rewardToken == address(0)) revert ZeroAddress();
        rewardToken = IERC20(_rewardToken);
    }

    function setReportRegistry(address _reportRegistry) external onlyOwner {
        if (_reportRegistry == address(0)) revert ZeroAddress();
        reportRegistry = _reportRegistry;
        emit ReportRegistrySet(_reportRegistry);
    }

    /// @notice Any organization or donor can top up the transparent reward pool.
    /// @dev Caller must first approve this contract for `amount`  UZHETHs.
    function donate(uint256 amount) external nonReentrant {
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        totalDonated += amount;
        emit Donation(msg.sender, amount);
    }

    /// @notice Called by ReportRegistry when a stake is forfeited; the stake
    ///         tokens have already been transferred to this contract by
    ///         ReportRegistry, this just books the accounting.
    function recordForfeitedStake(uint256 reportId, uint256 amount) external onlyReportRegistry {
        totalForfeited += amount;
        emit ForfeitedStakeReceived(reportId, amount);
    }

    /// @notice Pays a reward (on top of the returned stake, which ReportRegistry
    ///         sends back directly) to an approved whistleblower's wallet.
    function payReward(uint256 reportId, address recipient, uint256 amount) external onlyReportRegistry nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        if (rewardToken.balanceOf(address(this)) < amount) revert InsufficientTreasuryBalance();
        totalPaidOut += amount;
        rewardToken.safeTransfer(recipient, amount);
        emit RewardPaid(reportId, recipient, amount);
    }

    function balance() external view returns (uint256) {
        return rewardToken.balanceOf(address(this));
    }
}
