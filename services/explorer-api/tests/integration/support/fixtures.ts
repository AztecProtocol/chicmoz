import { type ChicmozChainInfoEvent } from "@chicmoz-pkg/message-registry";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

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
