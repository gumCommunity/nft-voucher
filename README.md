# Gumcoin NFT Voucher

TON NFT collection of vouchers (FunC, [Blueprint](https://github.com/ton-org/blueprint)).
Every NFT keeps TON on its own balance; the owner can **burn** the NFT and receive that whole balance.
Vouchers are exchanged for GUM by the [voucher-redeemer](https://github.com/gumCommunity/voucher-redeemer) contract.

Based on [getgems-io/nft-contracts](https://github.com/getgems-io/nft-contracts) (MIT), TEP-62 compatible.
Burn follows the `destroy` operation of SBT (TEP-85).

## Contracts

| File | Description |
|---|---|
| `contracts/nft_voucher_collection.fc` | Getgems collection: mint (op 1), batch mint (op 2), change owner (op 3), change content/royalty (op 4, as in getgems `nft-collection-editable`, plus a royalty check) |
| `contracts/nft_voucher_item.fc` | Voucher item, Getgems `nft-item-v2.fc` with the changes below |

### Differences from Getgems `nft-item-v2`

1. **`destroy` (op `0x1f04537a`)**: only the owner can send it. The whole balance goes to the owner (send mode 128, op `excesses`), the owner becomes `addr_none`, so the voucher can never be transferred or burned again.
2. **`transfer` never spends the voucher value.** In the original item the excess sent to `response_destination` is `balance − 0.05 TON`, so the value would leak on the first transfer. Here:
   - all fees and `forward_amount` are paid only from the TON attached to the transfer;
   - at least `0.01 TON + forward_amount + fees` must be attached, otherwise error `402`;
   - the balance before the message is locked with `raw_reserve`, so the value cannot leave even if fees are miscalculated.
3. **`request_voucher_data` (op `0x6d2e6461`)**: read-only request; the item answers the sender with `report_voucher_data` (op `0x7d85c51d`): `query_id index owner ^content ^payload`. The redeemer uses it to learn the voucher kind and checks the reply by recomputing the item address from `index`.
4. **Top-up**: a message with an empty body increases the voucher value (anyone can top up).
5. **Get methods**: `is_burned()` and `get_voucher_value()` (current item balance in nanoTON).

The burn does not use flag +32, so the account is not deleted: a burned voucher is visible via `get_nft_data` (owner = `addr_none`), and the collection owner cannot mint the same index again (covered by tests).

### Errors

| Code | Meaning |
|---|---|
| 401 | sender is not the owner (item: also when the voucher is already burned) |
| 402 | not enough TON attached to `transfer` |
| 405 | initialization not from the collection |
| 333 | address is not in workchain 0 |
| 410 | collection: invalid royalty (base is 0 or more than 100%) |
| 0xffff | unknown op |

## Metadata (Gumcoin Vouchers)

Configured in `scripts/voucherConfig.ts`:

- collection: `https://cdn.gumcoin.org/vouchers/collection.json`
- items prefix: `https://cdn.gumcoin.org/vouchers/`
- three voucher kinds; every item stores only its suffix, full URL = prefix + suffix:

| Kind | Suffix | Name |
|---|---|---|
| 0 | `0.json` | 10 000 GUM Voucher |
| 1 | `1.json` | 5 000 GUM Voucher |
| 2 | `2.json` | 1 000 GUM Voucher |

Item index and kind are independent: item #57 may be a `1.json` voucher.

## Usage

```bash
npm install
npm run build        # compile both contracts
npm test             # tests in @ton/sandbox

npx blueprint run deployNftVoucherCollection --testnet
npx blueprint run mintVoucher <collection_address> --testnet   # asks kind, owner and TON value
npx blueprint run burnVoucher <item_address> --testnet
npx blueprint run changeCollectionOwner <collection_address> --testnet   # transfer the right to mint
npx blueprint run changeRoyalty <collection_address> --testnet           # change royalty % and receiver
```

From code:

```ts
await collection.sendMint(sender, {
    itemIndex: nextItemIndex,          // from getCollectionData()
    itemOwner: Address.parse('UQ...'),
    itemContent: '1.json',             // '0.json' = 10 000, '1.json' = 5 000, '2.json' = 1 000 GUM
    voucherValue: toNano('1'),         // TON locked inside the NFT
});
```

On mint the item receives `voucherValue + 0.05 TON` (storage reserve). Up to 249 vouchers can be minted in one message with `sendBatchMint`.

## Notes

- If you change `nft_voucher_item.fc`, update the pinned item code in `voucher-redeemer` as well, otherwise the redeemer will not recognise the new items.
- The collection owner is fully trusted: they mint vouchers and decide how much TON goes into each one.
- Collection ownership can be transferred with `changeCollectionOwner` (op 3). It is one step and immediate, so the script
  asks for the new address twice and refuses obviously wrong ones. The redeemer recognises vouchers by the collection
  address, so changing the owner does not affect it.
- **Royalty** is 0% by default (`ROYALTY_*` in `scripts/voucherConfig.ts`; the receiver is the deployer). The owner can change the percent
  and the receiver at any time with `changeRoyalty` (op 4 keeps the metadata URLs; the contract rejects more than 100%,
  error `410`). Royalty is honoured by marketplaces (they read `royalty_params`); direct wallet transfers pay none.
  Changing the owner does not change the royalty receiver.
- Test on testnet first and get an audit before mainnet: the NFTs hold real value.

## License

MIT, see [LICENSE](LICENSE).
