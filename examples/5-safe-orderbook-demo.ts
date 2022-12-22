/* eslint-disable no-console */

// eslint-disable-next-line
import * as pressAnyKey from "press-any-key";
import { green, bgWhite, bold } from "console-log-colors";
import {
  MoveCallTransaction,
  ObjectId,
  TransactionEffects,
} from "@mysten/sui.js";
import { OrderbookClient, SafeClient } from "../src";
import { parseObjectOwner } from "../src/client/utils";
import {
  PACKAGE_OBJECT_ID,
  signer,
  provider,
  SUI_CURRENCY_TYPE,
} from "./common";

const COLLECTION_PACKAGE_ID = "0x735d8035efe816f14d5ba5a52d9ccafd3ae7e815";
const COLLECTION_TYPE = `${COLLECTION_PACKAGE_ID}::suimarines::SUIMARINES`;
const COLLECTION_ID = "0xbbcc368589dc8d5dd0e0bc23110f09af041df561";
const WHITELIST_ID = "0x9e9836ce2f5f01e51f0bb14028dd2773394bf431";
const NFT_ID = "0x0fca2bea5a9ee4073ed211f2015ddfcb46ca399a";

async function sendTx(tx: MoveCallTransaction): Promise<TransactionEffects> {
  const res = await signer.executeMoveCall(tx);
  if (typeof res !== "object" || !("EffectsCert" in res)) {
    throw new Error(
      `Response does not contain EffectsCert: ${JSON.stringify(res)}`
    );
  }

  console.log(`(tx digest ${res.EffectsCert.certificate.transactionDigest})`);
  return res.EffectsCert.effects.effects;
}

async function coinWithBalanceGreaterThanOrEqual(
  amount: number
): Promise<ObjectId> {
  const coins = await provider.selectCoinsWithBalanceGreaterThanOrEqual(
    await signer.getAddress(),
    BigInt(amount)
  );

  return (coins[0].details as any).reference.objectId;
}

async function createSafe(): Promise<[ObjectId, ObjectId]> {
  const createSafeRes = await sendTx(
    SafeClient.createSafeForSenderTx({
      packageObjectId: PACKAGE_OBJECT_ID,
    })
  );

  const [object1, object2] = createSafeRes.created;

  let safeId;
  let ownerCapId;

  if (parseObjectOwner(object1.owner) === "shared") {
    safeId = object1.reference.objectId;
    ownerCapId = object2.reference.objectId;
  } else {
    safeId = object2.reference.objectId;
    ownerCapId = object1.reference.objectId;
  }

  return [safeId, ownerCapId];
}

async function pressToContinue(msg: string) {
  console.log();
  console.log(bold(msg));
  await pressAnyKey("Press any key to continue ...");
}

const main = async () => {
  await pressToContinue("Creating Safe object for seller ...");
  // BV5Gv1qLVoMc2bUNAyS3MchJzer5Swy7W5QFVT2cfwnz
  const [sellerSafeId, sellerOwnerCapId] = await createSafe();

  await pressToContinue(
    `Depositing NFT ${bgWhite(NFT_ID)} to Safe ${bgWhite(sellerSafeId)} ...`
  );
  // 3aVAo9oeGgmgfYW4rXfPK8PMduFJbF3UupzxuUvnnh1J
  await sendTx(
    SafeClient.depositNftTx({
      packageObjectId: PACKAGE_OBJECT_ID,
      safe: sellerSafeId,
      nft: NFT_ID,
      collection: COLLECTION_TYPE,
    })
  );

  await pressToContinue(
    `Creating transfer cap with owner cap ${bgWhite(sellerOwnerCapId)} ...`
  );
  // 51SirugikQPVUGb82xCtWR4ViPeL4Xh4vduyLabHmCVc
  const createTransferCapRes = await sendTx(
    SafeClient.createExclusiveTransferCapForSenderTx({
      packageObjectId: PACKAGE_OBJECT_ID,
      safe: sellerSafeId,
      nft: NFT_ID,
      ownerCap: sellerOwnerCapId,
    })
  );
  const transferCapId = createTransferCapRes.created[0].reference.objectId;
  console.log(`Transfer cap created: ${bgWhite(transferCapId)}`);

  await pressToContinue("Creating orderbook ...");
  // 261VPVy9GDz96gKicaare7QdsueH64bGxDqPHv4TQG84
  const createOrderbookRes = await sendTx(
    OrderbookClient.createOrderbookTx({
      packageObjectId: PACKAGE_OBJECT_ID,
      collection: COLLECTION_TYPE,
      ft: SUI_CURRENCY_TYPE,
    })
  );

  const orderbookId = createOrderbookRes.created[0].reference.objectId;

  await pressToContinue(
    `Creating ask order in orderbook ${bgWhite(orderbookId)} ...`
  );
  // A7Cpg1LrY46n4tsRxQNSqwx8NHdcRfMY3tp24EbE246d
  const ASK_AMOUNT = 21; // SUI
  await sendTx(
    OrderbookClient.createAskTx({
      packageObjectId: PACKAGE_OBJECT_ID,
      collection: COLLECTION_TYPE,
      ft: SUI_CURRENCY_TYPE,
      book: orderbookId,
      transferCap: transferCapId,
      sellerSafe: sellerSafeId,
      requestedTokens: ASK_AMOUNT, // 21 SUI
    })
  );

  await pressToContinue("Creating second safe into which we deposit NFT ...");
  // CKjmqTjvemeqeqEQaPCunNKbaMHyxczmFzjaHzmS8wfx
  const [buyerSafeId, _buyerOwnerCapId] = await createSafe();

  await pressToContinue(
    `Buying NFT and depositing to second safe ${bgWhite(buyerSafeId)} ...`
  );
  // 4M4Nsj2xVaarNjuoccBaHPzMjsr7B9pCQskSWVDb2Hj9
  const coinId = await coinWithBalanceGreaterThanOrEqual(ASK_AMOUNT);
  const buyNftRes = await sendTx(
    OrderbookClient.buyNftTx({
      packageObjectId: PACKAGE_OBJECT_ID,
      collection: COLLECTION_TYPE,
      ft: SUI_CURRENCY_TYPE,
      book: orderbookId,
      nft: NFT_ID,
      sellerSafe: sellerSafeId,
      buyerSafe: buyerSafeId,
      wallet: coinId,
      price: ASK_AMOUNT,
      whitelist: WHITELIST_ID,
    })
  );

  const [object1, object2] = buyNftRes.created;
  // creates two objects, one of which is the trade payment (shared)
  const tradePaymentId =
    parseObjectOwner(object1.owner) === "shared"
      ? object1.reference.objectId
      : object2.reference.objectId;

  await pressToContinue(
    `Redeem royalty of trade payment ${bgWhite(tradePaymentId)} ...`
  );
  // aCZBSWwDMQBKeCM8GGuizG5hFuPswr5BEYhoNkzYG15
  await sendTx({
    packageObjectId: COLLECTION_PACKAGE_ID,
    module: "suimarines",
    function: "collect_royalty",
    typeArguments: [SUI_CURRENCY_TYPE],
    arguments: [tradePaymentId, COLLECTION_ID],
    gasBudget: 5000,
  });

  console.log();
  console.log(green.bold("Trade successful!"));
};

main();
