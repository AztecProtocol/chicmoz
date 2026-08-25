import { type FC } from "react";
import { StaticPage } from "./static-page";

export const AboutUsPage: FC = () => (
  <StaticPage
    slug="about-us"
    title="About"
    comment="what Aztec-Scan is and who runs it"
  >
    <p>
      Aztec-Scan is an open-source block explorer for the Aztec network. It
      indexes blocks, transactions, contracts, validators, and L1 events, and
      makes them searchable without compromising the privacy the network is
      built around.
    </p>
    <p>
      The explorer was created by its original builders as a public good and
      is now operated by the Aztec Foundation. The source code remains open
      and contributions are welcome on{" "}
      <a
        href="https://github.com/AztecProtocol/chicmoz"
        target="_blank"
        rel="noreferrer"
      >
        GitHub
      </a>
      .
    </p>
  </StaticPage>
);
