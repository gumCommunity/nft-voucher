import { Address, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { NftVoucherMinter } from '../wrappers/NftVoucherMinter';
import { MINTER_LIMIT_PER_DAY, VOUCHER_KINDS } from './voucherConfig';

// Deploys a minter for the collection and (optionally) hands the collection over to it.
// The connected wallet becomes the minter admin.
export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const admin = provider.sender().address!;

    const collectionAddress = args[0] ? Address.parse(args[0]) : await ui.inputAddress('Collection address');
    const collection = provider.open(NftVoucherCollection.createFromAddress(collectionAddress));
    const { ownerAddress } = await collection.getCollectionData();

    const operator = await ui.inputAddress('Operator address (the server wallet that will mint vouchers)');
    if (operator.equals(admin) && !(await ui.prompt('Operator = admin (your wallet). The point of the minter is a separate server key. Continue?'))) {
        return;
    }
    let limit = MINTER_LIMIT_PER_DAY;
    while (limit === null || !Number.isInteger(limit) || limit < 0) {
        limit = Number((await ui.input('Max vouchers the operator may mint per 24 hours')).trim());
    }
    const kinds = VOUCHER_KINDS.map((k) => k.content);

    ui.write(`Admin:     ${admin.toString()}`);
    ui.write(`Operator:  ${operator.toString()}`);
    ui.write(`Limit:     ${limit} vouchers / 24h`);
    ui.write(`Kinds:     ${kinds.join(', ')}`);
    if (!(await ui.prompt('Deploy the minter?'))) return;

    const minter = provider.open(
        NftVoucherMinter.createFromConfig({ admin, operator, collection: collectionAddress, limitPerDay: limit, kinds }, await compile('NftVoucherMinter')),
    );
    await minter.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(minter.address);
    ui.write(`Minter deployed: ${minter.address.toString()}`);

    if (!ownerAddress.equals(admin)) {
        ui.write(`The collection is owned by ${ownerAddress.toString()}, not by your wallet: transfer it to the minter from that owner.`);
        return;
    }
    if (!(await ui.prompt(`Transfer the collection ${collectionAddress.toString()} to the minter now?`))) {
        ui.write(`Later: npx blueprint run changeCollectionOwner ${collectionAddress.toString()}  (new owner = ${minter.address.toString()})`);
        return;
    }
    await collection.sendChangeOwner(provider.sender(), minter.address);
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if ((await collection.getCollectionData()).ownerAddress.equals(minter.address)) {
            ui.write('The collection is now owned by the minter. Only the operator (through the minter) and you (manageMinter) can mint.');
            return;
        }
    }
    ui.write('Ownership transfer not confirmed yet, check the collection in an explorer.');
}
