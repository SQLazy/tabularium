// CI only: writes the throwaway TESTNET payer file the tests read (.testnet-wallets.json, gitignored) from the
// TESTNET_PAYER_KEY secret. Refuses to run without it, and never prints the key.
import { writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.TESTNET_PAYER_KEY?.trim();
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("TESTNET_PAYER_KEY is missing or not a 0x-prefixed 32-byte hex key");
  process.exit(1);
}
const address = privateKeyToAccount(key).address;
writeFileSync(".testnet-wallets.json", JSON.stringify({ payer: { address, privateKey: key } }, null, 2), { mode: 0o600 });
console.log(`testnet payer ${address}`);
