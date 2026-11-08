import { toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { COLLECTION_CONTENT_URL, COMMON_CONTENT_URL } from './voucherConfig';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const owner = provider.sender().address!;

    const collectionContentUrl = COLLECTION_CONTENT_URL;
    const commonContentUrl = COMMON_CONTENT_URL;
    ui.write(`Collection metadata: ${collectionContentUrl}`);
    ui.write(`Items prefix:        ${commonContentUrl}`);

    const collection = provider.open(
        NftVoucherCollection.createFromConfig(
            {
                ownerAddress: owner,
                collectionContentUrl,
                commonContentUrl,
                nftItemCode: await compile('NftVoucherItem'),
                royaltyParams: { royaltyFactor: 0, royaltyBase: 100, royaltyAddress: owner },
            },
            await compile('NftVoucherCollection'),
        ),
    );

    await collection.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(collection.address);

    ui.write(`Collection deployed: ${collection.address.toString()}`);
}
