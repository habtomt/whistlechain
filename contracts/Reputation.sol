// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Reputation
/// @notice Non-transferable, per-validator reputation score used as voting
///         weight in Governance. Reputation cannot be sent, sold, or traded;
///         it can only be changed by the authorized Governance contract.
///
/// @dev VALIDATOR ADMISSION:
///      Admission is fully self-service and permissionless. Anyone can call
///      joinAsValidator() directly -- there is no admin whitelist and no
///      manual approval step. 
contract Reputation is Ownable {
    using SafeERC20 for IERC20;

    error NotAuthorized();
    error ZeroAddress();
    error AlreadyValidator();
    error FeeRecipientNotSet();

    uint256 public constant DEFAULT_INITIAL_REPUTATION = 100;
    uint256 public constant MIN_REPUTATION = 1; // validators never reach 0 weight, only deactivation removes them

    /// @dev Fixed cost (in the stake/reward ERC-20 token) to self-register as
    ///      a validator. Simplest technically sound assumption: set well
    ///      below MIN_STAKE (50  UZHETHs) in ReportRegistry so joining as a
    ///      validator is materially cheaper than submitting a report, but
    ///      still a genuine, non-trivial cost. Adjust if the course specifies
    ///      a different figure.
    uint256 public constant JOIN_COST = 20 ether; // 20  UZHETHs (18 decimals)

    address public governance; // only this contract may mutate reputation scores
    IERC20 public immutable joinFeeToken;
    address public joinFeeRecipient; // where JOIN_COST payments are forwarded (e.g. the Treasury)

    mapping(address => uint256) public reputationOf;
    mapping(address => bool) public isValidator;
    address[] public validatorList; // enumerable list, used by Governance for quorum snapshots

    event GovernanceSet(address indexed governance);
    event JoinFeeRecipientSet(address indexed recipient);
    event ValidatorJoined(address indexed validator, uint256 initialReputation, uint256 feePaid);
    event ValidatorDeactivated(address indexed validator);
    event ReputationIncreased(address indexed validator, uint256 amount, uint256 newTotal);
    event ReputationSlashed(address indexed validator, uint256 amount, uint256 newTotal);

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotAuthorized();
        _;
    }

    constructor(address _joinFeeToken) Ownable(msg.sender) {
        if (_joinFeeToken == address(0)) revert ZeroAddress();
        joinFeeToken = IERC20(_joinFeeToken);
    }

    /// @notice One-time wiring of the Governance contract address by the deployer/admin.
    ///         (Deployment wiring, not validator gating -- see contract-level NatSpec.)
    function setGovernance(address _governance) external onlyOwner {
        if (_governance == address(0)) revert ZeroAddress();
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    /// @notice Sets where JOIN_COST payments are forwarded (e.g. the Treasury,
    ///         so validator join fees top up the whistleblower reward pool).
    function setJoinFeeRecipient(address _recipient) external onlyOwner {
        if (_recipient == address(0)) revert ZeroAddress();
        joinFeeRecipient = _recipient;
        emit JoinFeeRecipientSet(_recipient);
    }

    /// @notice Self-service, permissionless validator admission. Anyone may
    ///         call this directly; there is no admin approval step. The
    ///         caller pays JOIN_COST (in  UZHETHs) as a Sybil-resistance fee and
    ///         is immediately registered with the baseline reputation.
    /// @dev Caller must have approved this contract for JOIN_COST beforehand.
    function joinAsValidator() external {
        if (isValidator[msg.sender]) revert AlreadyValidator();
        if (joinFeeRecipient == address(0)) revert FeeRecipientNotSet();

        isValidator[msg.sender] = true;
        reputationOf[msg.sender] = DEFAULT_INITIAL_REPUTATION;
        validatorList.push(msg.sender);

        joinFeeToken.safeTransferFrom(msg.sender, joinFeeRecipient, JOIN_COST);

        emit ValidatorJoined(msg.sender, DEFAULT_INITIAL_REPUTATION, JOIN_COST);
    }

    /// @notice Emergency-only deactivation (e.g. legal compliance, a
    ///         confirmed compromised key). This is NOT part of normal
    ///         admission -- admission itself is fully permissionless and
    ///         automatic (see joinAsValidator). Kept as an explicit,
    ///         documented centralization point rather than silently omitted;
    ///         see README security limitations.
    function deactivateValidator(address validator) external onlyOwner {
        isValidator[validator] = false;
        emit ValidatorDeactivated(validator);
    }

    function increaseReputation(address validator, uint256 amount) external onlyGovernance {
        reputationOf[validator] += amount;
        emit ReputationIncreased(validator, amount, reputationOf[validator]);
    }

    function slashReputation(address validator, uint256 amount) external onlyGovernance {
        uint256 current = reputationOf[validator];
        uint256 newValue = current > amount ? current - amount : MIN_REPUTATION;
        reputationOf[validator] = newValue;
        emit ReputationSlashed(validator, current - newValue, newValue);
    }

    /// @notice Raw (unramped) reputation-based voting weight. Governance
    ///         applies the probation ramp on top of this value; this
    ///         function alone does NOT reflect a validator's actual current
    ///         voting power during probation.
    function votingWeightOf(address validator) external view returns (uint256) {
        if (!isValidator[validator]) return 0;
        return reputationOf[validator];
    }

    function validatorCount() external view returns (uint256) {
        return validatorList.length;
    }
}
