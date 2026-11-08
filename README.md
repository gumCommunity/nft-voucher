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
| `contracts/nft_voucher_minter.fc` | Minter: owns the collection, lets a server (operator) mint within a daily limit, everything else stays with the admin — see [Minter](#minter-server-minting-with-a-limited-key) |

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

## Minter: server minting with a limited key

The collection owner can mint unlimited vouchers, i.e. effectively claim all GUM on the redeemer. To keep that power out of
a server, the collection is owned by the **minter** contract, which has two roles:

```
admin (cold wallet) ──manages──> Minter ──owns──> Collection
operator (server key) ──"mint a voucher" only──> Minter
```

| Operator (server) can | Admin can |
|---|---|
| mint vouchers through the minter (`minter_mint`, `minter_batch_mint`) | replace or disable the operator |
| only allowed kinds (`0.json`, `1.json`, `2.json`) | pause minting |
| at most **N vouchers per 24 h** | change the daily limit and allowed kinds |
| paying the TON itself (the minter balance is never used) | change royalty / metadata, transfer the collection (to a new minter or a wallet) |
| | withdraw TON; change admin in **two steps** (propose → the new admin accepts) |

If the server key leaks: at most N vouchers per day can be minted until the admin replaces the operator (one transaction).
The redeemer is not affected by any of this: it recognises vouchers by the collection address, not by its owner.

| Op | Code | Who |
|---|---|---|
| `minter_mint` | `0x2eb92088` | operator: `query_id item_index:uint64 amount:Coins ^nft_content` (attach `amount + 0.03 TON`) |
| `minter_batch_mint` | `0x76671074` | operator: `query_id ^deploy_list` (same dict as collection op 2, up to 249) |
| `minter_set_operator` | `0x25745a78` | admin (`addr_none` disables) |
| `minter_set_paused` | `0x5ce84131` | admin |
| `minter_set_limit` | `0x1907b1ec` | admin, vouchers per 24 h |
| `minter_set_kind` | `0x26796708` | admin: `content_hash:uint256 allowed:Bool` |
| `minter_collection_call` | `0x75f071b1` | admin: any `^body` to the collection as its owner (op 3 change owner, op 4 royalty, …) |
| `minter_withdraw_ton` | `0x1c88f70d` | admin (`0` = all except 0.05 TON) |
| `minter_propose_admin` / `minter_accept_admin` | `0x3d8bf3c0` / `0x26728af0` | admin proposes, the new admin accepts |

Errors: `401` not admin, `402` not operator, `403` paused, `404` kind not allowed, `405` daily limit reached,
`406` not enough TON attached, `407` not the pending admin, `408` empty or too large batch.
Get methods: `get_minter_data` (admin, pending admin, operator, collection, paused, limit, minted in the current window,
window end), `is_kind_allowed(content_hash)`.

The 24-hour window starts with the first mint after the previous window ended, so in the worst case 2 × N vouchers can be
minted within a short time around the window boundary. If the collection rejects an operator mint, the counter is restored.

**Setup**

```bash
npx blueprint run deployNftVoucherCollection --testnet           # owner = your (admin) wallet
npx blueprint run deployMinter <collection> --testnet            # asks operator + limit, then hands the collection over
npx blueprint run manageMinter <minter> --testnet                # admin panel
npx blueprint run mintViaMinter <minter> --testnet               # mint as the operator
```

`MINTER_LIMIT_PER_DAY` in `scripts/voucherConfig.ts` sets the limit (if `null`, `deployMinter` asks).
Once the minter owns the collection, `mintVoucher`, `changeRoyalty` and `changeCollectionOwner` point you to `manageMinter`.

**Server.** [`examples/serverMint.ts`](examples/serverMint.ts) mints with the operator mnemonic from the environment
(`@ton/ton`, no Blueprint). Alternatively `WALLET_MNEMONIC=... WALLET_VERSION=v4 npx blueprint run mintViaMinter --mnemonic …`.
Mint one voucher at a time (or use batch mint): the item index is read from the collection, and two mints with the same
index produce only one voucher.

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
