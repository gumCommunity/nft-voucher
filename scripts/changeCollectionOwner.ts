import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';

// Transfers the collection ownership (the right to mint vouchers) to another address.
// One step, effective immediately: a wrong address means minting is lost forever.
export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const collectionAddress = args[0] ? Address.parse(args[0]) : await ui.inputAddress('Collection address');
    const collection = provider.open(NftVoucherCollection.createFromAddress(collectionAddress));

    let data;
    try {
        data = await collection.getCollectionData();
    } catch {
        throw new Error(`${collectionAddress.toString()} is not an NFT collection (get_collection_data failed).`);
    }
    const me = provider.sender().address!;
    ui.write(`Collection:     ${collectionAddress.toString()}`);
    ui.write(`Current owner:  ${data.ownerAddress.toString()}`);
    ui.write(`Minted items:   ${data.nextItemIndex}`);
    if (!data.ownerAddress.equals(me)) {
        throw new Error(`Your wallet ${me.toString()} is not the collection owner, the transaction would fail.`);
    }

    ui.write('⚠ The new owner gets the right to mint vouchers (and therefore to claim GUM from the redeemer).');
    ui.write('⚠ There is no confirmation from the new address — a wrong address means minting is lost forever.');
    const newOwner = await ui.inputAddress('New owner address');
    const repeat = await ui.inputAddress('Repeat the new owner address');
    if (!newOwner.equals(repeat)) throw new Error('Addresses do not match, nothing sent.');
    if (newOwner.equals(data.ownerAddress)) throw new Error('This address is already the owner.');
    if (newOwner.equals(collectionAddress)) throw new Error('This is the collection itself, not a wallet. Nothing sent.');
    for (const i of [0n, data.nextItemIndex > 0n ? data.nextItemIndex - 1n : 0n]) {
        if (newOwner.equals(await collection.getNftAddressByIndex(i))) throw new Error('This is a voucher NFT, not a wallet. Nothing sent.');
    }

    const state = (await provider.provider(newOwner).getState()).state.type;
    if (state === 'active') {
        let isWallet = true;
        try {
            await provider.provider(newOwner).get('seqno', []);
        } catch {
            isWallet = false;
        }
        if (!isWallet && !(await ui.prompt('This address is a smart contract without `seqno` (not a regular wallet). Continue anyway?'))) {
            ui.write('Cancelled.');
            return;
        }
    } else {
        ui.write(`Note: ${newOwner.toString()} has never been used on ${provider.network()} (${state}). Make sure you have its seed phrase.`);
    }

    if (!(await ui.prompt(`Transfer ownership of the collection to ${newOwner.toString()}?`))) {
        ui.write('Cancelled.');
        return;
    }
    await collection.sendChangeOwner(provider.sender(), newOwner);

    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if ((await collection.getCollectionData()).ownerAddress.equals(newOwner)) {
            ui.write(`Collection owner changed to ${newOwner.toString()}.`);
            return;
        }
    }
    ui.write('Not confirmed yet, check get_collection_data in an explorer.');
}
