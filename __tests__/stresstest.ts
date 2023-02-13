/**
 * Keeps trading NFTs between bunch of saves.
 *
 * ENV variables:
 * - RPC_ENDPOINT - RPC endpoint to use, defaults to "LOCAL"
 * - MNEMONIC - mnemonic to use, defaults to one with pubkey of 0x2d1770323750638a27e8a2b4ad4fe54ec2b7edf0
 * - TESTRACT_ADDRESS - address of testract package on the chain of RPC_ENDPOINT
 * - NFT_PROTOCOL_ADDRESS - address of testract package NFT dependency on the chain of RPC_ENDPOINT
 */

console.warn = () => {};
require("dotenv").config();

import { Ed25519Keypair, JsonRpcProvider, ObjectId } from "@mysten/sui.js";
import { SafeFullClient, OrderbookFullClient } from "../src";

// Initial setup
const SAVES_WITH_NFTS_COUNT = 5;
const NFTS_PER_SAFE = 5;
const SAVES_WITHOUT_NFTS_COUNT = 15;
// After each tick, in which we trade NFTs, we sleep for this amount of time
const SLEEP_AFTER_TICK_MS = 0;
const MAX_CONSEQUENT_ERRORS_COUNT = 3;
const SLEEP_AFTER_FIRST_ERROR_MS = 1000;
const DEFAULT_GAS_BUDGET = 100_000;
const TESTRACT_ADDRESS = process.env.TESTRACT_ADDRESS;
const TESTRACT_OTW_TYPE = `${TESTRACT_ADDRESS}::testract::TESTRACT`;
const TESTRACT_C_TYPE = `${TESTRACT_ADDRESS}::testract::CTESTRACT`;
const NFT_PROTOCOL_ADDRESS = process.env.NFT_PROTOCOL_ADDRESS;
const ENV = process.env.RPC_ENDPOINT || "LOCAL";
// DEFAULT is: 0x2d1770323750638a27e8a2b4ad4fe54ec2b7edf0
const MNEMONIC =
  process.env.MNEMONIC ||
  "muffin tuition fit fish average true slender tower salmon artist song biology";
const KEYPAIR = Ed25519Keypair.deriveKeypair(MNEMONIC);
console.log("Using keypair", KEYPAIR.getPublicKey().toSuiAddress());
const safeClient = SafeFullClient.fromKeypair(
  KEYPAIR,
  new JsonRpcProvider(ENV),
  {
    packageObjectId: NFT_PROTOCOL_ADDRESS,
  }
);
const orderbookClient = OrderbookFullClient.fromKeypair(
  KEYPAIR,
  safeClient.client.provider,
  {
    packageObjectId: NFT_PROTOCOL_ADDRESS,
  }
);

/**
 * Taken from https://www.npmjs.com/package/random
 *
 * https://en.wikipedia.org/wiki/Normal_distribution
 */
function normalDistribution(mu: number, sigma: number) {
  let x: number, y: number, r: number;
  do {
    x = Math.random() * 2 - 1;
    y = Math.random() * 2 - 1;
    r = x * x + y * y;
  } while (!r || r > 1);
  return mu + sigma * y * Math.sqrt((-2 * Math.log(r)) / r);
}

// Price distributions
const BID_DISTRIBUTION = () => Math.round(normalDistribution(510, 70));
const ASK_DISTRIBUTION = () => Math.round(normalDistribution(520, 50));

const tradeIntermediaries: string[] = [];

async function createSafeWithNfts(mintCap: ObjectId) {
  const { safe, ownerCap } = await safeClient.createSafeForSender();
  if (ENV !== "LOCAL") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await safeClient.client.sendTxWaitForEffects({
    packageObjectId: TESTRACT_ADDRESS!,
    module: "testract",
    function: "mint_n_nfts",
    typeArguments: [],
    arguments: [mintCap, String(NFTS_PER_SAFE), safe],
    gasBudget: DEFAULT_GAS_BUDGET * 4,
  });

  return { safe, ownerCap };
}

async function createAsk(
  nftToList: ObjectId,
  orderbook: ObjectId,
  safe: ObjectId,
  ownerCap: ObjectId
) {
  const { transferCap } = await safeClient.createExclusiveTransferCapForSender({
    safe,
    ownerCap,
    nft: nftToList,
  });

  const price = ASK_DISTRIBUTION();
  const { trade } = await orderbookClient.createAsk({
    collection: TESTRACT_C_TYPE,
    ft: TESTRACT_OTW_TYPE,
    orderbook,
    price,
    sellerSafe: safe,
    transferCap,
  });

  if (trade) {
    tradeIntermediaries.push(trade);
  }
}

async function createBid(
  treasury: ObjectId,
  orderbook: ObjectId,
  safe: ObjectId
) {
  const price = BID_DISTRIBUTION();
  const { created } = await orderbookClient.client.sendTxWaitForEffects({
    packageObjectId: TESTRACT_ADDRESS!,
    module: "testract",
    function: "create_bid",
    typeArguments: [],
    arguments: [String(price), safe, treasury, orderbook],
    gasBudget: DEFAULT_GAS_BUDGET,
  });

  const trade = created?.find(
    (obj) => typeof obj.owner === "object" && "Shared" in obj.owner
  );
  if (trade) {
    tradeIntermediaries.push(trade.reference.objectId);
  }
}

async function getGlobalObjects(): Promise<{
  treasury: ObjectId;
  allowlist: ObjectId;
  mintCap: ObjectId;
}> {
  console.log("Getting treasury and allowlist...");

  const objs = await orderbookClient.client.getObjects(
    KEYPAIR.getPublicKey().toSuiAddress()
  );

  const treasury = objs.find(
    (obj) =>
      obj.type.includes("TreasuryCap") &&
      // https://github.com/MystenLabs/sui/issues/8017
      obj.type.includes(TESTRACT_ADDRESS!.replace("0x0", "0x"))
  )?.objectId;
  if (!treasury) {
    console.log("TESTRACT_ADDRESS", TESTRACT_ADDRESS);
    objs
      .filter((obj) => obj.type.includes("TreasuryCap"))
      .forEach((obj) => console.log(obj.type));
    throw new Error("Treasury not found");
  }

  const mintCapType = `${NFT_PROTOCOL_ADDRESS!.replace(
    "0x0",
    "0x"
  )}::mint_cap::MintCap<${TESTRACT_C_TYPE!.replace("0x0", "0x")}>`;
  const mintCap = objs.find(
    ({ type }) =>
      // https://github.com/MystenLabs/sui/issues/8017
      type === mintCapType
  )?.objectId;
  if (!mintCap) {
    console.log("NFT_PROTOCOL_ADDRESS", NFT_PROTOCOL_ADDRESS);
    console.log("TESTRACT_ADDRESS", TESTRACT_ADDRESS);
    console.log("MintCap expected type", mintCapType);
    objs
      .filter((obj) => obj.type.includes("MintCap"))
      .forEach((obj) => console.log(obj.type));
    throw new Error("MintCap not found");
  }

  const allowlists = objs
    .filter(
      (obj) =>
        // https://github.com/MystenLabs/sui/issues/8017
        obj.type ===
        `${NFT_PROTOCOL_ADDRESS!.replace(
          "0x0",
          "0x"
        )}::transfer_allowlist::Allowlist`
    )
    .map((o) => o.objectId);

  while (allowlists.length !== 0) {
    const allowlist = allowlists.pop()!;
    const { data } = (await orderbookClient.client.getObject(allowlist)) as any;
    const hasTestract = data.fields.collections.fields.contents.some(
      ({ fields }: any) => fields.name.startsWith(TESTRACT_ADDRESS?.slice(2))
    );
    if (hasTestract) {
      return { treasury, allowlist, mintCap };
    }
  }

  throw new Error("Allowlist not found");
}

async function finishAllTrades(allowlist: ObjectId) {
  while (tradeIntermediaries.length !== 0) {
    const trade = tradeIntermediaries.pop()!;
    const { transferCap, buyerSafe } =
      await orderbookClient.fetchTradeIntermediary(trade);
    if (!transferCap) {
      throw new Error("Expected transfer cap to be present");
    }

    const { tradePayments } = await orderbookClient.finishTrade({
      trade,
      allowlist,
      collection: TESTRACT_C_TYPE,
      ft: TESTRACT_OTW_TYPE,
      buyerSafe,
      sellerSafe: transferCap.safe,
    });
    if (tradePayments.length !== 1) {
      throw new Error("Expected exactly one TradePayment object");
    }
    if (ENV !== "LOCAL") {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await safeClient.client.sendTxWaitForEffects({
      packageObjectId: TESTRACT_ADDRESS!,
      module: "testract",
      function: "collect_royalty",
      typeArguments: [],
      arguments: [tradePayments[0]],
      gasBudget: DEFAULT_GAS_BUDGET,
    });
  }
}

async function tick(
  orderbook: ObjectId,
  treasury: ObjectId,
  allowlist: ObjectId,
  saves: Array<{ safe: ObjectId; ownerCap: ObjectId }>
) {
  const safeIndex = Math.floor(Math.random() * saves.length);
  const { safe, ownerCap } = saves[safeIndex];

  const { nfts } = await safeClient.fetchSafe(safe);
  const nftToList = nfts.find((nft) => nft.transferCapsCount === 0);

  // we don't want to execute a trade where both seller and buyer is the same
  // safe
  const { asks, bids } = await orderbookClient.fetchOrderbook(
    orderbook,
    true // sort
  );

  if (nftToList && !(bids.length > 0 && bids[0].safe === safe)) {
    await createAsk(nftToList.id, orderbook, safe, ownerCap);
  } else if (!(asks.length > 0 && asks[0].transferCap.safe === safe)) {
    await createBid(treasury, orderbook, safe);
  }

  if (SLEEP_AFTER_TICK_MS) {
    await new Promise((resolve) => setTimeout(resolve, SLEEP_AFTER_TICK_MS));
  }

  await finishAllTrades(allowlist);
}

async function start(
  orderbook: ObjectId,
  treasury: ObjectId,
  allowlist: ObjectId,
  saves: Array<{ safe: ObjectId; ownerCap: ObjectId }>
) {
  let consequentErrors = 0;
  while (true) {
    try {
      await tick(orderbook, treasury, allowlist, saves);

      consequentErrors = 0;
    } catch (error) {
      console.error(error);
      consequentErrors += 1;

      if (consequentErrors > MAX_CONSEQUENT_ERRORS_COUNT) {
        break;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, SLEEP_AFTER_FIRST_ERROR_MS * consequentErrors)
      );
    }
  }

  console.log();
  console.log();
  console.error("Terminated due to too many errors");
}

async function main() {
  const { treasury, allowlist, mintCap } = await getGlobalObjects();

  const { orderbook } = await orderbookClient.createOrderbook({
    ft: TESTRACT_OTW_TYPE,
    collection: TESTRACT_C_TYPE,
  });

  const saves: Array<{ safe: ObjectId; ownerCap: ObjectId }> = [];
  console.log(`Creating ${SAVES_WITHOUT_NFTS_COUNT} empty safes...`);
  for (let i = 0; i < SAVES_WITHOUT_NFTS_COUNT; i++) {
    const { safe, ownerCap } = await safeClient.createSafeForSender();
    saves.push({ safe, ownerCap });
  }
  console.log(`Creating ${SAVES_WITH_NFTS_COUNT} safes with NFTs...`);
  for (let i = 0; i < SAVES_WITH_NFTS_COUNT; i++) {
    saves.push(await createSafeWithNfts(mintCap));
  }

  console.log("Trading begins...");
  await start(orderbook, treasury, allowlist, saves);
}

main();