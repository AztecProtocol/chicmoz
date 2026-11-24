import { type ChicmozChainInfoEvent } from "@chicmoz-pkg/message-registry";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

// Constructed: no SignalCast log is recorded. A signal for the payload of the
// recorded governance proposal 8.
export const governanceSignalCast = {
  payloadAddress: "0x5e9d4e98a9258951fcbbe644d6cbf122845f93be",
  round: 7n,
  signaler: "0x01c7d4ca153748d2377968fef22894cb162e9480",
  l1BlockNumber: 11969300n,
  l1BlockHash: `0x${"ab".repeat(32)}`,
  l1BlockTimestamp: 1792669200000,
  l1TransactionHash: `0x${"cd".repeat(32)}`,
  l1LogIndex: 5,
  isFinalized: true,
};

export const chainInfoEvent: ChicmozChainInfoEvent = {
  chainInfo: {
    l2NetworkId: "SANDBOX",
    l1ChainId: 31337,
    rollupVersion: 7n,
    l1ContractAddresses: {
      rollupAddress: address(1),
      registryAddress: address(2),
      inboxAddress: address(3),
      outboxAddress: address(4),
      feeJuiceAddress: address(5),
      feeJuicePortalAddress: address(6),
      coinIssuerAddress: address(7),
      rewardDistributorAddress: address(8),
      governanceProposerAddress: address(9),
      governanceAddress: address(10),
      stakingAssetAddress: address(11),
    },
    protocolContractAddresses: {
      classRegistry: address(0x10),
      feeJuice: address(0x11),
      instanceRegistry: address(0x12),
      multiCallEntrypoint: address(0x13),
    },
  },
};
