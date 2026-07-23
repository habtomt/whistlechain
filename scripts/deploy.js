const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying WhistleChain with account:", deployer.address);
  console.log("Network:", network.name);

  // 1. Token
  const Token = await ethers.getContractFactory("WhistleChainToken");
  const token = await Token.deploy(ethers.parseEther("1000000")); // 1,000,000  UZHETHs to deployer
  await token.waitForDeployment();
  console.log("WhistleChainToken deployed:", await token.getAddress());

  // 2. Reputation
  const Reputation = await ethers.getContractFactory("Reputation");
  const reputation = await Reputation.deploy(await token.getAddress());
  await reputation.waitForDeployment();
  console.log("Reputation deployed:", await reputation.getAddress());

  // 3. Governance
  const Governance = await ethers.getContractFactory("Governance");
  const governance = await Governance.deploy(await reputation.getAddress());
  await governance.waitForDeployment();
  console.log("Governance deployed:", await governance.getAddress());

  // 4. Treasury
  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(await token.getAddress());
  await treasury.waitForDeployment();
  console.log("Treasury deployed:", await treasury.getAddress());

  // 5. ReportRegistry
  const Registry = await ethers.getContractFactory("ReportRegistry");
  const registry = await Registry.deploy(await token.getAddress());
  await registry.waitForDeployment();
  console.log("ReportRegistry deployed:", await registry.getAddress());

  // 6. Wire everything together
  await (await reputation.setGovernance(await governance.getAddress())).wait();
  await (await governance.setReportRegistry(await registry.getAddress())).wait();
  await (await treasury.setReportRegistry(await registry.getAddress())).wait();
  await (await registry.setGovernance(await governance.getAddress())).wait();
  await (await registry.setTreasury(await treasury.getAddress())).wait();
  // Validator join fees (JOIN_COST, paid by anyone who self-registers via
  // Reputation.joinAsValidator) are routed to the Treasury, so they top up
  // the whistleblower reward pool rather than disappearing.
  await (await reputation.setJoinFeeRecipient(await treasury.getAddress())).wait();
  console.log("Contracts wired together.");

  // 7. Demo bootstrap: a few of the deployer's own accounts self-register as
  //    validators. Each account funds itself with JOIN_COST from the
  //    deployer's UZHETHs balance, approves the
  //    Reputation contract, and calls joinAsValidator() directly.
  const signers = await ethers.getSigners();
  const demoValidators = signers.slice(1, 4); // accounts #1-#3
  const joinCost = await reputation.JOIN_COST();
  for (const v of demoValidators) {
    if (network.name !== "hardhat" && (await v.provider.getBalance(v.address)) === 0n) {
      console.log(`  (skipping demo validator self-registration for ${v.address}: fund it with gas first)`);
      continue;
    }
    await (await token.transfer(v.address, joinCost)).wait(); // demo-only funding, not part of the protocol
    await (await token.connect(v).approve(await reputation.getAddress(), joinCost)).wait();
    await (await reputation.connect(v).joinAsValidator()).wait();
    console.log("Validator self-registered:", v.address);
  }

  // 8. Seed the treasury reward pool from the deployer's own balance (demo donation)
  const seedAmount = ethers.parseEther("50000");
  await (await token.approve(await treasury.getAddress(), seedAmount)).wait();
  await (await treasury.donate(seedAmount)).wait();
  console.log("Seeded treasury with", ethers.formatEther(seedAmount), " UZHETHs");

  const addresses = {
    network: network.name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    WhistleChainToken: await token.getAddress(),
    Reputation: await reputation.getAddress(),
    Governance: await governance.getAddress(),
    Treasury: await treasury.getAddress(),
    ReportRegistry: await registry.getAddress(),
    deployer: deployer.address,
    validators: demoValidators.map((v) => v.address),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(addresses, null, 2));
  console.log("\nDeployment addresses written to:", outFile);
  console.log(JSON.stringify(addresses, null, 2));

  // Also copy addresses + ABIs the frontend needs
  const frontendDir = path.join(__dirname, "..", "frontend", "contracts");
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.writeFileSync(path.join(frontendDir, "addresses.json"), JSON.stringify(addresses, null, 2));

  const artifactsToCopy = [
    "WhistleChainToken",
    "Reputation",
    "Governance",
    "Treasury",
    "ReportRegistry",
  ];
  for (const name of artifactsToCopy) {
    const artifact = await hre_artifacts(name);
    fs.writeFileSync(
      path.join(frontendDir, `${name}.abi.json`),
      JSON.stringify(artifact.abi, null, 2)
    );
  }
  console.log("Frontend ABIs + addresses written to:", frontendDir);
}

async function hre_artifacts(name) {
  const hre = require("hardhat");
  return hre.artifacts.readArtifact(name);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
