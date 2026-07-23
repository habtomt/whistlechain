require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// UZH Ethereum Proof-of-Stake (PoS) test network configuration.
//   Network Name:      UZH_ETH_PoS
//   Default RPC URL:   https://rpc.uzheths.ifi.uzh.ch
//   Chain ID:          70207
//   Currency Symbol:   UZHETHs
//   Block Explorer:    https://explorer.uzheths.ifi.uzh.ch

const UZH_RPC_URL = process.env.UZH_RPC_URL || "https://rpc.uzheths.ifi.uzh.ch";
const UZH_CHAIN_ID = process.env.UZH_CHAIN_ID ? parseInt(process.env.UZH_CHAIN_ID) : 70207;
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {}, // local in-memory network used for `npm test` and local demo
    // Local persistent node: `npx hardhat node`, then --network localhost
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // UZH Ethereum Proof-of-Stake test network.
    // Requires DEPLOYER_PRIVATE_KEY (funded with UZHETHs for gas) in .env.
    uzh: {
      url: UZH_RPC_URL,
      chainId: UZH_CHAIN_ID,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
