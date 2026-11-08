import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { notOwnerMessage } from './ownerHint';

const pct = (f: number, b: number) => `${(f * 100) / b}%`;

/** "5" -> 5/100, "2.5" -> 25/1000; null if invalid. */
function parsePercent(input: string): { factor: number; base: number } | null {
    const v = input.trim().replace(',', '.');
    if (/^\d+$/.test(v)) return { factor: Number(v), base: 100 };
    if (/^\d+\.\d$/.test(v)) return { factor: Math.round(Number(v) * 10), base: 1000 };
    return null;
}

// Changes the marketplace royalty of the collection (percent and/or receiver). Metadata URLs are kept.
export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const collectionAddress = args[0] ? Address.parse(args[0]) : await ui.inputAddress('Collection address');
    const collection = provider.open(NftVoucherCollection.createFromAddress(collectionAddress));

    let data, royalty, urls;
    try {
        data = await collection.getCollectionData();
        royalty = await collection.getRoyaltyParams();
        urls = await collection.getContentUrls();
    } catch {
        throw new Error(`${collectionAddress.toString()} is not a voucher collection.`);
    }
    const me = provider.sender().address!;
    ui.write(`Collection:       ${collectionAddress.toString()}`);
    ui.write(`Owner:            ${data.ownerAddress.toString()}`);
    ui.write(`Current royalty:  ${pct(royalty.royaltyFactor, royalty.royaltyBase)} to ${royalty.royaltyAddress.toString()}`);
    if (!data.ownerAddress.equals(me)) {
        throw new Error(await notOwnerMessage(provider, data.ownerAddress, me));
    }

    let next: { factor: number; base: number } | null = null;
    while (!next) {
        const input = await ui.input(`New royalty percent, e.g. 5 or 2.5 (Enter = keep ${pct(royalty.royaltyFactor, royalty.royaltyBase)})`);
        if (!input.trim()) next = { factor: royalty.royaltyFactor, base: royalty.royaltyBase };
        else {
            next = parsePercent(input);
            if (!next || next.factor > next.base) {
                ui.write('Enter a number from 0 to 100 with at most one decimal.');
                next = null;
            }
        }
    }
    if ((next.factor * 100) / next.base > 15 && !(await ui.prompt(`${pct(next.factor, next.base)} is unusually high. Continue?`))) {
        ui.write('Cancelled.');
        return;
    }
    const receiver = await ui.inputAddress(`Royalty receiver (Enter = keep ${royalty.royaltyAddress.toString()})`, royalty.royaltyAddress);

    const unchanged =
        next.factor * royalty.royaltyBase === royalty.royaltyFactor * next.base && receiver.equals(royalty.royaltyAddress);
    if (unchanged) {
        ui.write('Nothing to change.');
        return;
    }
    if (!(await ui.prompt(`Set royalty to ${pct(next.factor, next.base)} paid to ${receiver.toString()}?`))) {
        ui.write('Cancelled.');
        return;
    }

    await collection.sendChangeContent(provider.sender(), {
        ...urls, // keep metadata URLs as they are
        royaltyParams: { royaltyFactor: next.factor, royaltyBase: next.base, royaltyAddress: receiver },
    });

    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const r = await collection.getRoyaltyParams();
        if (r.royaltyFactor === next.factor && r.royaltyBase === next.base && r.royaltyAddress.equals(receiver)) {
            ui.write(`Royalty is now ${pct(r.royaltyFactor, r.royaltyBase)} to ${r.royaltyAddress.toString()}.`);
            return;
        }
    }
    ui.write('Not confirmed yet, check royalty_params in an explorer.');
}
