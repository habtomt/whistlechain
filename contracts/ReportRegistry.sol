// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./Treasury.sol";

interface IGovernanceOpen {
    function openVote(uint256 reportId) external;
}

/// @title ReportRegistry
/// @notice Records immutable commitments to whistleblower reports, escrows
///         the required token stake, and settles the outcome (stake refund
///         + reward, or stake forfeiture) once Governance finalizes a vote.
///
/// @dev ON-CHAIN STORAGE DESIGN:
///      Both the SHA-256 commitment hash AND the AES-256-GCM encrypted
///      report content are stored directly in contract storage 
///      GAS / SIZE IMPLICATIONS (read before raising MAX_ENCRYPTED_CONTENT_BYTES):
///        - Solidity packs `bytes` storage into 32-byte (256-bit) words.
///        - A cold SSTORE (first write to a storage slot) costs ~20,000 gas
///          per 32-byte word on standard EVM gas schedules.
///        - MAX_ENCRYPTED_CONTENT_BYTES is capped at 4096 bytes (4 KB) of
///          ciphertext, i.e. 128 words => roughly 128 * 20,000 = ~2,560,000
///          gas just for the ciphertext SSTOREs, plus further gas for the
///          hash, IV, struct metadata, and calldata (~16 gas per non-zero
///          calldata byte, ~4 gas per zero byte).
///        - A full submitReport() call near the size cap therefore costs on
///          the order of 2.6-3.0 million gas. This is comfortably under a
///          typical 30,000,000 block gas limit, but is roughly 100-500x more
///          expensive than storing just a 32-byte hash + a short locator
///          string. Raising the cap further scales this cost linearly and
///          risks exceeding the target network's per-block gas limit or
///          per-transaction gas limit.
///        - Event logs are cheaper per byte than storage (no 20,000 gas/word
///          SSTORE cost) but log data is write-only from the contract's
///          perspective -- it cannot be read back by other contract calls,
///          only by off-chain log queries. Because the frontend needs
///          `getReport()` to return the ciphertext directly for the
///          validator review UI, this implementation uses contract storage,
///          not only an event, and the event below re-emits the content as
///          well purely for indexing convenience.
contract ReportRegistry is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidStake();
    error DuplicateReportId();
    error ReportNotFound();
    error NotAuthorized();
    error AlreadySettled();
    error EmptyHash();
    error EmptyContent();
    error ContentTooLarge();
    error InvalidIvLength();
    error ZeroAddress();

    enum ReportStatus { Submitted, Approved, Rejected }

    /// @dev Maximum ciphertext size accepted on-chain, in bytes. See the gas
    ///      cost discussion in the contract-level NatSpec above.
    uint256 public constant MAX_ENCRYPTED_CONTENT_BYTES = 4096;
    /// @dev AES-GCM standard nonce/IV length.
    uint256 public constant REQUIRED_IV_LENGTH = 12;

    struct Report {
        bytes32 reportHash;      // SHA-256 commitment computed client-side over the plaintext
        bytes encryptedContent;  // AES-256-GCM ciphertext of the report, stored fully on-chain
        bytes encryptionIv;      // AES-GCM 12-byte IV/nonce used for the ciphertext above
        address reporterWallet;  // pseudonymous wallet, not linked on-chain to real identity
        uint256 stakeAmount;
        uint256 submittedAt;      // block timestamp
        uint256 submittedAtBlock; // block number
        ReportStatus status;
        bool settled;
    }

    IERC20 public immutable stakeToken;
    Treasury public treasury;
    address public governance;

    uint256 public constant MIN_STAKE = 50 ether; // 50 test tokens (18 decimals)
    uint256 public constant BASE_REWARD = 100 ether;      // fixed base reward component
    uint256 public constant QUALITY_MULTIPLIER = 1 ether; // scales with validator consensus score

    uint256 public nextReportId = 1;
    mapping(uint256 => Report) public reports;
    mapping(bytes32 => bool) public hashUsed; // prevents duplicate report commitments

    event GovernanceSet(address indexed governance);
    event TreasurySet(address indexed treasury);
    event ReportSubmitted(
        uint256 indexed reportId,
        address indexed reporterWallet,
        bytes32 reportHash,
        bytes encryptedContent,
        bytes encryptionIv,
        uint256 stakeAmount,
        uint256 timestamp
    );
    event ReportSettled(uint256 indexed reportId, bool approved, uint256 rewardPaid, uint256 stakeReturned);

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotAuthorized();
        _;
    }

    constructor(address _stakeToken) Ownable(msg.sender) {
        if (_stakeToken == address(0)) revert ZeroAddress();
        stakeToken = IERC20(_stakeToken);
    }

    function setGovernance(address _governance) external onlyOwner {
        if (_governance == address(0)) revert ZeroAddress();
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = Treasury(_treasury);
        emit TreasurySet(_treasury);
    }

    /// @notice Submits a new whistleblower report commitment, stores the
    ///         encrypted report content fully on-chain, and escrows the stake.
    /// @param reportHash SHA-256 hash of the canonicalized plaintext report (computed client-side).
    /// @param encryptedContent AES-256-GCM ciphertext of the canonicalized report, stored on-chain.
    /// @param encryptionIv The 12-byte AES-GCM IV/nonce used to produce `encryptedContent`.
    /// @param reporterWallet Pseudonymous wallet address that will receive stake refund + reward.
    /// @param stakeAmount Amount of stake token to escrow (must be >= MIN_STAKE).
    /// @dev Caller must have approved this contract for `stakeAmount` beforehand.
    function submitReport(
        bytes32 reportHash,
        bytes calldata encryptedContent,
        bytes calldata encryptionIv,
        address reporterWallet,
        uint256 stakeAmount
    ) external nonReentrant returns (uint256 reportId) {
        if (reportHash == bytes32(0)) revert EmptyHash();
        if (encryptedContent.length == 0) revert EmptyContent();
        if (encryptedContent.length > MAX_ENCRYPTED_CONTENT_BYTES) revert ContentTooLarge();
        if (encryptionIv.length != REQUIRED_IV_LENGTH) revert InvalidIvLength();
        if (reporterWallet == address(0)) revert ZeroAddress();
        if (stakeAmount < MIN_STAKE) revert InvalidStake();
        if (hashUsed[reportHash]) revert DuplicateReportId();

        hashUsed[reportHash] = true;

        reportId = nextReportId++;
        reports[reportId] = Report({
            reportHash: reportHash,
            encryptedContent: encryptedContent,
            encryptionIv: encryptionIv,
            reporterWallet: reporterWallet,
            stakeAmount: stakeAmount,
            submittedAt: block.timestamp,
            submittedAtBlock: block.number,
            status: ReportStatus.Submitted,
            settled: false
        });

        stakeToken.safeTransferFrom(msg.sender, address(this), stakeAmount);

        emit ReportSubmitted(reportId, reporterWallet, reportHash, encryptedContent, encryptionIv, stakeAmount, block.timestamp);

        IGovernanceOpen(governance).openVote(reportId);
    }

    /// @notice Called exclusively by Governance once a vote is finalized.
    ///         Approved => stake refunded + reward paid from Treasury.
    ///         Rejected => stake forfeited to Treasury.
    function settleReport(uint256 reportId, bool approved) external onlyGovernance nonReentrant {
        Report storage r = reports[reportId];
        if (r.reporterWallet == address(0)) revert ReportNotFound();
        if (r.settled) revert AlreadySettled();

        r.settled = true;
        r.status = approved ? ReportStatus.Approved : ReportStatus.Rejected;

        if (approved) {
            // Refund stake directly to reporter wallet
            stakeToken.safeTransfer(r.reporterWallet, r.stakeAmount);
            // Reward = Base Reward + Quality Multiplier (demo: fixed multiplier factor of 1,
            // consensus-score-scaled rewards are a documented extension point).
            uint256 reward = BASE_REWARD + QUALITY_MULTIPLIER;
            treasury.payReward(reportId, r.reporterWallet, reward);
            emit ReportSettled(reportId, true, reward, r.stakeAmount);
        } else {
            // Forfeit stake to Treasury
            stakeToken.safeTransfer(address(treasury), r.stakeAmount);
            treasury.recordForfeitedStake(reportId, r.stakeAmount);
            emit ReportSettled(reportId, false, 0, 0);
        }
    }

    function getReport(uint256 reportId) external view returns (Report memory) {
        return reports[reportId];
    }
}
