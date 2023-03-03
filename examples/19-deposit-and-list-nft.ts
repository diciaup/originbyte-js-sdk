import { SUI_TYPE_ARG } from "@mysten/sui.js";
import {
  ORDERBOOK_ID,
  orderbookClient,
  COLLECTION_ID_NAME,
  fetchNfts,
  getSafeAndOwnerCap,
  NFT_TYPE,
} from "./common";

export const depositAndListNft = async () => {
  const allNfts = await fetchNfts();

  if (allNfts.length === 0) {
    console.log("No NFTs for placing ask");
    return;
  }

  console.log("allNfts: ", allNfts, "allNfts.length: ", allNfts.length);

  const nft = allNfts[0];
  const { ownerCap, safe } = await getSafeAndOwnerCap();

  const result = await orderbookClient.depositAndListNft({
    sellerSafe: safe,
    ownerCap,
    nft,
    nftType: NFT_TYPE,
    collection: COLLECTION_ID_NAME,
    ft: SUI_TYPE_ARG,
    orderbook: ORDERBOOK_ID,
    price: 11,
  });

  console.log("result: ", result);
};

depositAndListNft();
