const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MIN_STAKE = ethers.parseEther("50");
const BASE_REWARD = ethers.parseEther("100");
const QUALITY_MULTIPLIER = ethers.parseEther("1");
const JOIN_COST = ethers.parseEther("20");

async function sha256Hash(text) {
  return ethers.sha256(ethers.toUtf8Bytes(text));
}

// Builds a fake-but-valid-shaped AES-GCM ciphertext + 12-byte IV for tests.
// The registry only checks length/format on-chain; real encryption happens
// in the browser (see frontend/crypto.js), so tests just need well-formed bytes.
function fakeCiphertext(sizeBytes = 64) {
  return ethers.hexlify(ethers.randomBytes(sizeBytes));
}
function fakeIv() {
  return ethers.hexlify(ethers.randomBytes(12));
}

describe("WhistleChain", function () {
  let owner, reporter, donor, v1, v2, v3, outsider;
  let token, reputation, treasury, governance, registry;

  // Self-service validator join: fund the account with JOIN_COST, approve
  // Reputation, then call joinAsValidator(). No admin involvement.
  async function joinAsValidator(signer) {
    await token.faucetMint(signer.address, JOIN_COST);
    await token.connect(signer).approve(await reputation.getAddress(), JOIN_COST);
    await reputation.connect(signer).joinAsValidator();
  }

  beforeEach(async function () {
    [owner, reporter, donor, v1, v2, v3, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("WhistleChainToken");
    token = await Token.deploy(ethers.parseEther("1000000"));

    const Reputation = await ethers.getContractFactory("Reputation");
    reputation = await Reputation.deploy(await token.getAddress());

    const Governance = await ethers.getContractFactory("Governance");
    governance = await Governance.deploy(await reputation.getAddress());

    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(await token.getAddress());

    const Registry = await ethers.getContractFactory("ReportRegistry");
    registry = await Registry.deploy(await token.getAddress());

    // Wire contracts together
    await reputation.setGovernance(await governance.getAddress());
    await governance.setReportRegistry(await registry.getAddress());
    await treasury.setReportRegistry(await registry.getAddress());
    await registry.setGovernance(await governance.getAddress());
    await registry.setTreasury(await treasury.getAddress());
    await reputation.setJoinFeeRecipient(await treasury.getAddress());

    // Validators join themselves (self-service, no admin)
    await joinAsValidator(v1);
    await joinAsValidator(v2);
    await joinAsValidator(v3);

    // Fund treasury with donation
    await token.faucetMint(donor.address, ethers.parseEther("10000"));
    await token.connect(donor).approve(await treasury.getAddress(), ethers.parseEther("10000"));
    await treasury.connect(donor).donate(ethers.parseEther("10000"));

    // Fund reporter with stake tokens
    await token.faucetMint(reporter.address, ethers.parseEther("1000"));
  });

  async function submitSampleReport(overrides = {}) {
    const hash = overrides.hash || (await sha256Hash("Report content " + Math.random()));
    const encryptedContent = overrides.encryptedContent || fakeCiphertext();
    const encryptionIv = overrides.encryptionIv || fakeIv();
    const stake = overrides.stake || MIN_STAKE;
    const wallet = overrides.wallet || reporter.address;

    await token.connect(reporter).approve(await registry.getAddress(), stake);
    const tx = await registry
      .connect(reporter)
      .submitReport(hash, encryptedContent, encryptionIv, wallet, stake);
    const receipt = await tx.wait();
    return { hash, encryptedContent, encryptionIv, stake, wallet, receipt };
  }

  // Casts `n` votes from a validator on `n` distinct reports, to burn through
  // their probation window deterministically in tests.
  async function burnProbationVotes(validator, n) {
    for (let i = 0; i < n; i++) {
      const { hash } = await submitSampleReport({ hash: await sha256Hash("probation-burn-" + Math.random()) });
      const reportId = await registry.nextReportId(); // nextReportId already incremented past this one
      const thisReportId = Number(reportId) - 1;
      await governance.connect(validator).castVote(thisReportId, true);
    }
  }

  describe("Validator admission (self-service, permissionless)", function () {
    it("lets anyone join as a validator by paying JOIN_COST, with no admin approval", async function () {
      await token.faucetMint(outsider.address, JOIN_COST);
      await token.connect(outsider).approve(await reputation.getAddress(), JOIN_COST);
      await expect(reputation.connect(outsider).joinAsValidator()).to.not.be.reverted;
      expect(await reputation.isValidator(outsider.address)).to.equal(true);
    });

    it("assigns the same baseline reputation (100) to every new validator", async function () {
      expect(await reputation.votingWeightOf(v1.address)).to.equal(100);
      expect(await reputation.votingWeightOf(v2.address)).to.equal(100);
      expect(await reputation.votingWeightOf(v3.address)).to.equal(100);
    });

    it("charges JOIN_COST to the configured fee recipient (the Treasury)", async function () {
      const treasuryBalBefore = await token.balanceOf(await treasury.getAddress());
      await joinAsValidator(outsider);
      const treasuryBalAfter = await token.balanceOf(await treasury.getAddress());
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(JOIN_COST);
    });

    it("rejects joining twice with the same address", async function () {
      await expect(joinAsValidator(v1)).to.be.reverted; // v1 already joined in beforeEach
    });

    it("rejects joining without paying JOIN_COST (no token approval)", async function () {
      await expect(reputation.connect(outsider).joinAsValidator()).to.be.reverted;
    });

    it("prevents non-owner from mutating reputation directly", async function () {
      await expect(
        reputation.connect(outsider).increaseReputation(v1.address, 10)
      ).to.be.revertedWithCustomError(reputation, "NotAuthorized");
    });
  });

  describe("Probation voting-power ramp", function () {
    it("counts a brand-new validator's first vote at 20% of raw reputation weight", async function () {
      await submitSampleReport();
      await governance.connect(v1).castVote(1, true);
      const summary = await governance.getVoteSummary(1);
      // v1 raw weight 100 * 20% = 20
      expect(summary.approveWeight).to.equal(20n);
    });

    it("ramps voting power linearly toward 100% over PROBATION_VOTES votes", async function () {
      // Burn 5 probation votes for v1 on separate reports (reports 1-5)
      await burnProbationVotes(v1, 5);
      // v1's 6th vote (priorVotes == 5) should be at full weight (100)
      await submitSampleReport({ hash: await sha256Hash("full-weight-report") });
      const reportId = Number(await registry.nextReportId()) - 1;
      await governance.connect(v1).castVote(reportId, true);
      const summary = await governance.getVoteSummary(reportId);
      expect(summary.approveWeight).to.equal(100n);
    });

    it("exposes the current effective (ramped) weight via currentEffectiveWeight()", async function () {
      const [weight, rampBps] = await governance.currentEffectiveWeight(v1.address);
      expect(weight).to.equal(20n); // brand new validator, 0 prior votes -> 20%
      expect(rampBps).to.equal(2000n);
    });

    it("does not ramp quorum eligibility -- eligible weight snapshot uses full reputation", async function () {
      await submitSampleReport();
      const summary = await governance.getVoteSummary(1);
      expect(summary.eligibleWeight).to.equal(300n); // 3 validators x 100 raw rep, unramped
    });
  });

  describe("Report submission (on-chain content storage)", function () {
    it("submits a report, stores hash + encrypted content on-chain, and escrows the stake", async function () {
      const { stake, hash, encryptedContent, encryptionIv } = await submitSampleReport();
      expect(await token.balanceOf(await registry.getAddress())).to.equal(stake);
      const report = await registry.getReport(1);
      expect(report.reporterWallet).to.equal(reporter.address);
      expect(report.stakeAmount).to.equal(MIN_STAKE);
      expect(report.reportHash).to.equal(hash);
      expect(report.encryptedContent).to.equal(encryptedContent);
      expect(report.encryptionIv).to.equal(encryptionIv);
    });

    it("rejects stake below the minimum", async function () {
      const hash = await sha256Hash("low stake report");
      await token.connect(reporter).approve(await registry.getAddress(), ethers.parseEther("10"));
      await expect(
        registry
          .connect(reporter)
          .submitReport(hash, fakeCiphertext(), fakeIv(), reporter.address, ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(registry, "InvalidStake");
    });

    it("rejects duplicate report hashes", async function () {
      const hash = await sha256Hash("duplicate content");
      await token.connect(reporter).approve(await registry.getAddress(), MIN_STAKE * 2n);
      await registry.connect(reporter).submitReport(hash, fakeCiphertext(), fakeIv(), reporter.address, MIN_STAKE);
      await expect(
        registry.connect(reporter).submitReport(hash, fakeCiphertext(), fakeIv(), reporter.address, MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "DuplicateReportId");
    });

    it("rejects empty hash and empty encrypted content", async function () {
      await token.connect(reporter).approve(await registry.getAddress(), MIN_STAKE * 2n);
      await expect(
        registry
          .connect(reporter)
          .submitReport(ethers.ZeroHash, fakeCiphertext(), fakeIv(), reporter.address, MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "EmptyHash");

      const hash = await sha256Hash("no content");
      await expect(
        registry.connect(reporter).submitReport(hash, "0x", fakeIv(), reporter.address, MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "EmptyContent");
    });

    it("rejects encrypted content larger than MAX_ENCRYPTED_CONTENT_BYTES", async function () {
      const max = await registry.MAX_ENCRYPTED_CONTENT_BYTES();
      const hash = await sha256Hash("too large report");
      const tooBig = fakeCiphertext(Number(max) + 1);
      await token.connect(reporter).approve(await registry.getAddress(), MIN_STAKE);
      await expect(
        registry.connect(reporter).submitReport(hash, tooBig, fakeIv(), reporter.address, MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "ContentTooLarge");
    });

    it("accepts encrypted content right at the MAX_ENCRYPTED_CONTENT_BYTES boundary", async function () {
      const max = await registry.MAX_ENCRYPTED_CONTENT_BYTES();
      const hash = await sha256Hash("boundary report");
      const exact = fakeCiphertext(Number(max));
      await token.connect(reporter).approve(await registry.getAddress(), MIN_STAKE);
      await expect(
        registry.connect(reporter).submitReport(hash, exact, fakeIv(), reporter.address, MIN_STAKE)
      ).to.not.be.reverted;
    });

    it("rejects an IV that is not exactly 12 bytes", async function () {
      const hash = await sha256Hash("bad iv report");
      await token.connect(reporter).approve(await registry.getAddress(), MIN_STAKE);
      await expect(
        registry
          .connect(reporter)
          .submitReport(hash, fakeCiphertext(), ethers.hexlify(ethers.randomBytes(8)), reporter.address, MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "InvalidIvLength");
    });

    it("opens a governance vote automatically on submission", async function () {
      await submitSampleReport();
      const summary = await governance.getVoteSummary(1);
      expect(summary.state).to.equal(1); // Open
      expect(summary.eligibleWeight).to.equal(300n); // 3 validators x 100 rep
    });
  });

  describe("Voting", function () {
    it("rejects votes from non-validators", async function () {
      await submitSampleReport();
      await expect(governance.connect(outsider).castVote(1, true)).to.be.revertedWithCustomError(
        governance,
        "NotValidator"
      );
    });

    it("prevents double voting", async function () {
      await submitSampleReport();
      await governance.connect(v1).castVote(1, true);
      await expect(governance.connect(v1).castVote(1, true)).to.be.revertedWithCustomError(
        governance,
        "AlreadyVoted"
      );
    });

    it("cannot finalize before the voting period ends", async function () {
      await submitSampleReport();
      await governance.connect(v1).castVote(1, true);
      await expect(governance.finalizeVote(1)).to.be.revertedWithCustomError(governance, "VotingPeriodActive");
    });

    it("rejects a report if quorum is not reached", async function () {
      await submitSampleReport();
      // Only v1 votes; even ramped weight can't reach 40% of 300 = 120
      await governance.connect(v1).castVote(1, true);
      await time.increase(4 * 24 * 60 * 60 + 1);
      await governance.finalizeVote(1);
      const report = await registry.getReport(1);
      expect(report.status).to.equal(2); // Rejected
    });

    it("approves a report that reaches quorum and 2/3 supermajority (post-probation, full weight)", async function () {
      // Burn probation for all 3 validators so this test isolates quorum/threshold logic
      await burnProbationVotes(v1, 5);
      await burnProbationVotes(v2, 5);
      await burnProbationVotes(v3, 5);

      const { stake } = await submitSampleReport({ hash: await sha256Hash("main-approval-report") });
      const reportId = Number(await registry.nextReportId()) - 1;
      await governance.connect(v1).castVote(reportId, true);
      await governance.connect(v2).castVote(reportId, true);
      await governance.connect(v3).castVote(reportId, false);
      // approve weight 200 / participating 300 = 66.66% >= 66.6% threshold
      await time.increase(4 * 24 * 60 * 60 + 1);

      const balBefore = await token.balanceOf(reporter.address);
      await governance.finalizeVote(reportId);
      const report = await registry.getReport(reportId);
      expect(report.status).to.equal(1); // Approved

      const balAfter = await token.balanceOf(reporter.address);
      const expectedPayout = stake + BASE_REWARD + QUALITY_MULTIPLIER;
      expect(balAfter - balBefore).to.equal(expectedPayout);
    });

    it("rejects a report that fails the 2/3 supermajority (post-probation, full weight)", async function () {
      await burnProbationVotes(v1, 5);
      await burnProbationVotes(v2, 5);
      await burnProbationVotes(v3, 5);

      await submitSampleReport({ hash: await sha256Hash("fails-supermajority-report") });
      const reportId = Number(await registry.nextReportId()) - 1;
      await governance.connect(v1).castVote(reportId, true);
      await governance.connect(v2).castVote(reportId, false);
      await governance.connect(v3).castVote(reportId, false);
      // approve weight 100/300 = 33% < 66.6%
      await time.increase(4 * 24 * 60 * 60 + 1);
      await governance.finalizeVote(reportId);
      const report = await registry.getReport(reportId);
      expect(report.status).to.equal(2); // Rejected
    });

    it("updates validator reputation according to consensus alignment", async function () {
      await submitSampleReport();
      // All three validators are still on probation (20% weight, 20 each).
      // approve=40 (v1+v2), reject=20 (v3), participating=60 < 40% of 300 (120)
      // => quorum fails => report is rejected by default (fail-safe).
      await governance.connect(v1).castVote(1, true);
      await governance.connect(v2).castVote(1, true);
      await governance.connect(v3).castVote(1, false); // matches the eventual (quorum-failure) outcome
      await time.increase(4 * 24 * 60 * 60 + 1);
      await governance.finalizeVote(1);

      const report = await registry.getReport(1);
      expect(report.status).to.equal(2); // Rejected (quorum not reached)

      // Reputation earn/slash amounts are unaffected by the probation ramp
      // (the ramp only scales voting power, not reputation deltas). v1/v2
      // voted "approve" but the final outcome was "rejected" => slashed.
      // v3 voted "reject" and matches the final outcome => earns.
      expect(await reputation.votingWeightOf(v1.address)).to.equal(90); // -10 slash
      expect(await reputation.votingWeightOf(v2.address)).to.equal(90); // -10 slash
      expect(await reputation.votingWeightOf(v3.address)).to.equal(105); // +5 earn
    });

    it("prevents double finalization", async function () {
      await submitSampleReport();
      await governance.connect(v1).castVote(1, true);
      await governance.connect(v2).castVote(1, true);
      await time.increase(4 * 24 * 60 * 60 + 1);
      await governance.finalizeVote(1);
      await expect(governance.finalizeVote(1)).to.be.revertedWithCustomError(governance, "VoteNotOpen");
    });
  });

  describe("Stake settlement", function () {
    it("forfeits the stake to the treasury on rejection", async function () {
      await submitSampleReport();
      await governance.connect(v1).castVote(1, false);
      await governance.connect(v2).castVote(1, false);
      await time.increase(4 * 24 * 60 * 60 + 1);

      const treasuryBalBefore = await token.balanceOf(await treasury.getAddress());
      await governance.finalizeVote(1);
      const treasuryBalAfter = await token.balanceOf(await treasury.getAddress());
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(MIN_STAKE);
      expect(await treasury.totalForfeited()).to.equal(MIN_STAKE);
    });

    it("cannot be settled twice (reentrancy / double settlement guard)", async function () {
      await submitSampleReport();
      await governance.connect(v1).castVote(1, true);
      await governance.connect(v2).castVote(1, true);
      await time.increase(4 * 24 * 60 * 60 + 1);
      await governance.finalizeVote(1);

      await expect(registry.connect(outsider).settleReport(1, true)).to.be.revertedWithCustomError(
        registry,
        "NotAuthorized"
      );
    });

    it("reverts settleReport for a non-existent report", async function () {
      await expect(governance.finalizeVote(999)).to.be.revertedWithCustomError(governance, "VoteNotOpen");
    });
  });

  describe("Treasury", function () {
    it("accepts donations and tracks totals", async function () {
      expect(await treasury.totalDonated()).to.equal(ethers.parseEther("10000"));
      // balance() also includes the 3 x JOIN_COST (20  UZHETHs each = 60  UZHETHs)
      // validator admission fees collected in beforeEach, since those are
      // direct transfers into the Treasury rather than calls to donate().
      const expectedBalance = ethers.parseEther("10000") + JOIN_COST * 3n;
      expect(await treasury.balance()).to.equal(expectedBalance);
    });

    it("only allows the ReportRegistry to trigger payouts", async function () {
      await expect(
        treasury.connect(outsider).payReward(1, outsider.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(treasury, "NotAuthorized");
    });

    it("reverts payout if treasury balance is insufficient", async function () {
      const Token2 = await ethers.getContractFactory("WhistleChainToken");
      const token2 = await Token2.deploy(ethers.parseEther("1000"));
      const Treasury2 = await ethers.getContractFactory("Treasury");
      const treasury2 = await Treasury2.deploy(await token2.getAddress());
      await treasury2.setReportRegistry(owner.address); // test-only: owner acts as registry
      await expect(
        treasury2.payReward(1, outsider.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(treasury2, "InsufficientTreasuryBalance");
    });
  });
});
