import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { NftVoucherMinter } from '../wrappers/NftVoucherMinter';
import { NftVoucherItem } from '../wrappers/NftVoucherItem';
import { VOUCHER_KINDS } from './voucherConfig';

// Mint a voucher as the OPERATOR through the minter.
// A server can run it non-interactively with its own key:
//   WALLET_MNEMONIC="..." WALLET_VERSION=v4 npx blueprint run mintViaMinter --testnet --mnemonic <minter> <owner> <kind 0|1|2> <ton>
export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const minterAddress = args[0] ? Address.parse(args[0]) : await ui.inputAddress('Minter address');
    const minter = provider.open(NftVoucherMinter.createFromAddress(minterAddress));
    const d = await minter.getMinterData();

    const me = provider.sender().address!;
    if (!d.operator || !d.operator.equals(me)) throw new Error(`Your wallet ${me.toString()} is not the minter operator (${d.operator?.toString() ?? 'disabled'}).`);
    if (d.paused) throw new Error('The minter is paused.');
    if (d.remainingToday < 1) throw new Error(`Daily limit reached (${d.limit}); resets at ${new Date(d.periodEndsAt * 1000).toISOString()}.`);

    const kind = args[2] !== undefined ? VOUCHER_KINDS[Number(args[2])] : await ui.choose('Voucher kind:', [...VOUCHER_KINDS], (k) => `${k.name} (${k.content})`);
    if (!kind) throw new Error('Unknown kind, use 0, 1 or 2.');
    const owner = args[1] ? Address.parse(args[1]) : await ui.inputAddress('Voucher owner address');
    const voucherValue = toNano(args[3] ?? (await ui.input('TON locked inside the voucher, e.g. 0.1')));

    const collection = provider.open(NftVoucherCollection.createFromAddress(d.collection));
    const { nextItemIndex } = await collection.getCollectionData();
    ui.write(`Minting #${nextItemIndex} ${kind.name} for ${owner.toString()} (${d.remainingToday} left today)`);

    // mint sequentially: two mints with the same index produce only one voucher
    await minter.sendMint(provider.sender(), { itemIndex: nextItemIndex, itemOwner: owner, itemContent: kind.content, voucherValue });

    const itemAddress = await collection.getNftAddressByIndex(nextItemIndex);
    await provider.waitForDeploy(itemAddress);
    const data = await provider.open(NftVoucherItem.createFromAddress(itemAddress)).getNftData();
    ui.write(`Voucher #${nextItemIndex} minted: ${itemAddress.toString()} (owner ${data.ownerAddress?.toString()})`);
}
