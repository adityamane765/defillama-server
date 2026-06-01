import { addToDBWritesList } from "../utils/database";
import { Write } from "../utils/dbInterfaces";
import { fetch } from "../utils";

// PGOLD ("Pleasing Gold") is a tokenized-gold RWA. It is listed on CoinGecko
// (id "pleasing-gold") but its thin trading volume keeps it below the coins
// CoinGecko-ingestion threshold (see src/scripts/coingecko.ts coinType tiers),
// so it is never auto-ingested. The contract exposes no on-chain NAV/price
// oracle, so we fetch the CoinGecko spot price directly and write it under the
// canonical `coingecko#pleasing-gold` PK. The per-chain contract addresses
// redirect to this coin via tokenMapping.json.
const CG_ID = "pleasing-gold";

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
  addToDBWritesList(
    writes,
    "coingecko",
    CG_ID,
    price,
    18,
    "PGOLD",
    timestamp,
    "pgold",
    0.9,
  );
  return writes;
}
