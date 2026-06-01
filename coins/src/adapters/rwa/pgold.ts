import { Write } from "../utils/dbInterfaces";
import getWrites from "../utils/getWrites";
import { fetch } from "../utils";

// PGOLD ("Pleasing Gold") is a tokenized-gold RWA. It is listed on CoinGecko
// (id "pleasing-gold") but its thin trading volume keeps it below the coins
// CoinGecko-ingestion threshold (see src/scripts/coingecko.ts coinType tiers),
// so it is never auto-ingested and a `coingecko#pleasing-gold` redirect would
// resolve to nothing. The contract exposes no on-chain NAV/price oracle, so we
// fetch the CoinGecko spot price directly and write it as a concrete price.
const CG_ID = "pleasing-gold";

// Same asset on both chains (CoinGecko lists both platforms).
const config: { [chain: string]: string } = {
  arbitrum: "0x3e76bb02286bfeaa89dd35f11253f2cbce634f91",
  apechain: "0x64ae250e044688ddd04262f17daca23c28d241c2",
};

export async function pgold(timestamp: number = 0): Promise<Write[]> {
  // CoinGecko /simple/price is current-only; skip historical refills.
  if (timestamp !== 0) return [];

  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${CG_ID}&vs_currencies=usd`,
  );
  const price = Number(res?.[CG_ID]?.usd);
  if (!isFinite(price) || price <= 0)
    throw new Error(`pgold: no CoinGecko price for ${CG_ID}`);

  const writes: Write[] = [];
  for (const [chain, address] of Object.entries(config)) {
    await getWrites({
      chain,
      timestamp,
      pricesObject: { [address]: { price } },
      writes,
      projectName: "pgold",
    });
  }
  return writes;
}
