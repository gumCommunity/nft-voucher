import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { COMMON_CONTENT_URL, VOUCHER_KINDS } from './voucherConfig';

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();

    const collectionAddress = Address.parse(args[0] ?? (await ui.input('Collection address')));
    const collection = provider.open(NftVoucherCollection.createFromAddress(collectionAddress));

    const kind = await ui.choose('Voucher kind:', [...VOUCHER_KINDS], (k) => `${k.name} (${k.content})`);
    const owner = await ui.inputAddress('Voucher owner address');
    const voucherValue = toNano(await ui.input('TON locked inside the voucher (paid out on burn), e.g. 1'));

    const { nextItemIndex } = await collection.getCollectionData();
    await collection.sendMint(provider.sender(), {
        itemIndex: nextItemIndex,
        itemOwner: owner,
        itemContent: kind.content,
        voucherValue,
    });

    const itemAddress = await collection.getNftAddressByIndex(nextItemIndex);
    await provider.waitForDeploy(itemAddress);
    ui.write(`Voucher #${nextItemIndex} (${kind.name}) minted: ${itemAddress.toString()}`);
    ui.write(`Metadata: ${COMMON_CONTENT_URL}${kind.content}`);
}
