// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Reputation.sol";

interface IReportSettlement {
    function settleReport(uint256 reportId, bool approved) external;
}

/// @title Governance
/// @notice DAO-lite, reputation-weighted voting 
///
/// @dev PROBATION RAMP:
///      Validator *admission* is fully open and automatic
contract Governance is Ownable {
    error NotAuthorized();
    error NotValidator();
    error VoteAlreadyOpen();
    error VoteNotOpen();
    error VotingPeriodActive();
    error VotingPeriodOver();
    error AlreadyVoted();
    error ZeroAddress();

    // Governance parameters (initial configuration from spec) 
    uint256 public constant QUORUM_BPS = 4000;      // 40% of total eligible reputation weight
    uint256 public constant APPROVAL_THRESHOLD_BPS = 6660; // 66.6% (2/3 supermajority) of participating weight
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public votingPeriod = 4 days;           // within the 3-5 day range specified

    // Reputation delta rules (Section F of spec)
    uint256 public constant REPUTATION_EARN = 5;
    uint256 public constant REPUTATION_SLASH = 10;

    // Probation ramp parameters 
    /// @dev Number of a validator's own lifetime votes (across all reports)
    ///      during which their voting weight is ramped rather than full.
    uint256 public constant PROBATION_VOTES = 5;
    /// @dev Starting voting-power percentage (in basis points) for a
    ///      validator's very first vote; ramps linearly to 10000 (100%) by
    ///      the time they reach PROBATION_VOTES completed votes.
    uint256 public constant PROBATION_START_BPS = 2000; // 20%

    Reputation public reputation;
    address public reportRegistry;

    /// @dev Lifetime count of votes cast by each validator, across all
    ///      reports. Used only to compute the probation ramp; unrelated to
    ///      per-report double-voting checks (see Vote.hasVoted below).
    mapping(address => uint256) public lifetimeVotesCast;

    enum VoteState { None, Open, Finalized }

    struct Vote {
        VoteState state;
        uint64 startTime;
        uint64 endTime;
        uint256 totalEligibleWeightSnapshot; // sum of FULL (unramped) reputation of all validators at open time
        uint256 approveWeight; // sum of ramped weights
        uint256 rejectWeight;  // sum of ramped weights
        bool approved;
        mapping(address => bool) hasVoted;
    }

    mapping(uint256 => Vote) private votes; // reportId => Vote
    mapping(uint256 => mapping(address => bool)) private _voteChoice; // per-validator recorded choice, for reputation scoring

    event ReportRegistrySet(address indexed reportRegistry);
    event VoteOpened(uint256 indexed reportId, uint256 startTime, uint256 endTime, uint256 eligibleWeight);
    event VoteCast(uint256 indexed reportId, address indexed validator, bool approve, uint256 rampedWeight, uint256 rawWeight, uint256 rampBps);
    event VoteFinalized(uint256 indexed reportId, bool approved, uint256 approveWeight, uint256 rejectWeight, uint256 totalEligibleWeight);

    modifier onlyReportRegistry() {
        if (msg.sender != reportRegistry) revert NotAuthorized();
        _;
    }

    constructor(address _reputation) Ownable(msg.sender) {
        if (_reputation == address(0)) revert ZeroAddress();
        reputation = Reputation(_reputation);
    }

    function setReportRegistry(address _reportRegistry) external onlyOwner {
        if (_reportRegistry == address(0)) revert ZeroAddress();
        reportRegistry = _reportRegistry;
        emit ReportRegistrySet(_reportRegistry);
    }

    function validatorCount() external view returns (uint256) {
        return reputation.validatorCount();
    }

    function validatorList(uint256 index) external view returns (address) {
        return reputation.validatorList(index);
    }

    /// @notice Opens voting for a newly submitted report. Called by ReportRegistry.
    function openVote(uint256 reportId) external onlyReportRegistry {
        Vote storage v = votes[reportId];
        if (v.state != VoteState.None) revert VoteAlreadyOpen();

        uint256 eligible = _totalEligibleWeight();
        v.state = VoteState.Open;
        v.startTime = uint64(block.timestamp);
        v.endTime = uint64(block.timestamp + votingPeriod);
        v.totalEligibleWeightSnapshot = eligible;

        emit VoteOpened(reportId, v.startTime, v.endTime, eligible);
    }

    function _totalEligibleWeight() internal view returns (uint256 total) {
        uint256 len = reputation.validatorCount();
        for (uint256 i = 0; i < len; i++) {
            total += reputation.votingWeightOf(reputation.validatorList(i));
        }
    }

    /// @notice Computes a validator's CURRENT effective voting weight,
    ///         applying the probation ramp on top of their raw reputation.
    ///         `priorVotes` is the number of lifetime votes already cast by
    ///         this validator BEFORE the vote being computed.
    function _rampedWeight(uint256 rawWeight, uint256 priorVotes)
        internal
        pure
        returns (uint256 weight, uint256 rampBps)
    {
        if (priorVotes >= PROBATION_VOTES) {
            return (rawWeight, BPS_DENOMINATOR);
        }
        // Linear ramp: 20% at priorVotes == 0, reaching 100% once
        // priorVotes == PROBATION_VOTES (i.e. after PROBATION_VOTES prior
        // votes, meaning this is at least their (PROBATION_VOTES+1)-th vote).
        rampBps = PROBATION_START_BPS +
            ((BPS_DENOMINATOR - PROBATION_START_BPS) * priorVotes) / PROBATION_VOTES;
        weight = (rawWeight * rampBps) / BPS_DENOMINATOR;
    }

    /// @notice Returns a validator's current effective voting weight (with
    ///         probation ramp already applied), for frontend display.
    function currentEffectiveWeight(address validator) external view returns (uint256 weight, uint256 rampBps) {
        uint256 raw = reputation.votingWeightOf(validator);
        if (raw == 0) return (0, 0);
        return _rampedWeight(raw, lifetimeVotesCast[validator]);
    }

    /// @notice Reputation-weighted vote cast by a registered, active validator.
    function castVote(uint256 reportId, bool approve) external {
        Vote storage v = votes[reportId];
        if (v.state != VoteState.Open) revert VoteNotOpen();
        if (block.timestamp > v.endTime) revert VotingPeriodOver();

        uint256 rawWeight = reputation.votingWeightOf(msg.sender);
        if (rawWeight == 0) revert NotValidator();
        if (v.hasVoted[msg.sender]) revert AlreadyVoted();

        (uint256 rampedWeight, uint256 rampBps) = _rampedWeight(rawWeight, lifetimeVotesCast[msg.sender]);

        v.hasVoted[msg.sender] = true;
        _voteChoice[reportId][msg.sender] = approve;
        lifetimeVotesCast[msg.sender] += 1;

        if (approve) {
            v.approveWeight += rampedWeight;
        } else {
            v.rejectWeight += rampedWeight;
        }

        emit VoteCast(reportId, msg.sender, approve, rampedWeight, rawWeight, rampBps);
    }

    function hasVoted(uint256 reportId, address validator) external view returns (bool) {
        return votes[reportId].hasVoted[validator];
    }

    /// @notice Finalizes a report's vote once the voting period has elapsed,
    ///         applies quorum + supermajority rules, updates validator
    ///         reputation, and instructs ReportRegistry to settle stake/reward.
    function finalizeVote(uint256 reportId) external {
        Vote storage v = votes[reportId];
        if (v.state != VoteState.Open) revert VoteNotOpen();
        if (block.timestamp <= v.endTime) revert VotingPeriodActive();

        uint256 participatingWeight = v.approveWeight + v.rejectWeight;
        bool quorumReached = v.totalEligibleWeightSnapshot > 0 &&
            (participatingWeight * BPS_DENOMINATOR) / v.totalEligibleWeightSnapshot >= QUORUM_BPS;

        bool approved = false;
        if (quorumReached && participatingWeight > 0) {
            approved = (v.approveWeight * BPS_DENOMINATOR) / participatingWeight >= APPROVAL_THRESHOLD_BPS;
        }
        // If quorum is not reached, the report is rejected by default (fails safe).

        v.approved = approved;
        v.state = VoteState.Finalized;

        _applyReputationUpdates(reportId, approved);

        emit VoteFinalized(reportId, approved, v.approveWeight, v.rejectWeight, v.totalEligibleWeightSnapshot);

        IReportSettlement(reportRegistry).settleReport(reportId, approved);
    }

    function _applyReputationUpdates(uint256 reportId, bool approved) internal {
        Vote storage v = votes[reportId];
        uint256 len = reputation.validatorCount();
        for (uint256 i = 0; i < len; i++) {
            address validator = reputation.validatorList(i);
            if (!v.hasVoted[validator]) continue;
            bool votedApprove = _voteChoice[reportId][validator];
            if (votedApprove == approved) {
                reputation.increaseReputation(validator, REPUTATION_EARN);
            } else {
                reputation.slashReputation(validator, REPUTATION_SLASH);
            }
        }
    }

    function getVoteSummary(uint256 reportId)
        external
        view
        returns (
            VoteState state,
            uint64 startTime,
            uint64 endTime,
            uint256 eligibleWeight,
            uint256 approveWeight,
            uint256 rejectWeight,
            bool approved
        )
    {
        Vote storage v = votes[reportId];
        return (v.state, v.startTime, v.endTime, v.totalEligibleWeightSnapshot, v.approveWeight, v.rejectWeight, v.approved);
    }
}
