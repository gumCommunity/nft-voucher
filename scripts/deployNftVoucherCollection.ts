import { toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { Address } from '@ton/core';
import { COLLECTION_CONTENT_URL, COMMON_CONTENT_URL, ROYALTY_ADDRESS, ROYALTY_BASE, ROYALTY_FACTOR } from './voucherConfig';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const owner = provider.sender().address!;

    const collectionContentUrl = COLLECTION_CONTENT_URL;
    const commonContentUrl = COMMON_CONTENT_URL;
    ui.write(`Collection metadata: ${collectionContentUrl}`);
    ui.write(`Items prefix:        ${commonContentUrl}`);
    const royaltyAddress = ROYALTY_ADDRESS ? Address.parse(ROYALTY_ADDRESS) : owner;
    ui.write(`Royalty:             ${(ROYALTY_FACTOR * 100) / ROYALTY_BASE}% to ${royaltyAddress.toString()}`);

    const collection = provider.open(
        NftVoucherCollection.createFromConfig(
            {
                ownerAddress: owner,
                collectionContentUrl,
                commonContentUrl,
                nftItemCode: await compile('NftVoucherItem'),
                royaltyParams: { royaltyFactor: ROYALTY_FACTOR, royaltyBase: ROYALTY_BASE, royaltyAddress: royaltyAddress },
            },
            await compile('NftVoucherCollection'),
        ),
    );

    await collection.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(collection.address);

    ui.write(`Collection deployed: ${collection.address.toString()}`);
}
