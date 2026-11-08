import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { NftVoucherItem } from '../wrappers/NftVoucherItem';

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();

    const itemAddress = Address.parse(args[0] ?? (await ui.input('Voucher (NFT item) address')));
    const item = provider.open(NftVoucherItem.createFromAddress(itemAddress));

    const { ownerAddress } = await item.getNftData();
    if (!ownerAddress) {
        ui.write('This voucher is already burned.');
        return;
    }
    if (!ownerAddress.equals(provider.sender().address!)) {
        ui.write(`You are not the owner. Owner: ${ownerAddress.toString()}`);
        return;
    }

    const value = await item.getVoucherValue();
    ui.write(`Burning voucher, value inside: ${Number(value) / 1e9} TON`);
    await item.sendDestroy(provider.sender());

    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (await item.getIsBurned()) {
            ui.write('Voucher burned, its balance was sent to your wallet.');
            return;
        }
    }
    ui.write('Burn not confirmed yet, check the transaction in an explorer.');
}
