// Runs examples/serverMint.ts (mintPending) against the sandbox.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { NftVoucherItem } from '../wrappers/NftVoucherItem';
import { NftVoucherMinter } from '../wrappers/NftVoucherMinter';
import { KINDS, mintPending, MintRequest } from '../examples/serverMint';

describe('examples/serverMint mintPending', () => {
    let code: Record<string, Cell> = {};
    beforeAll(async () => {
        for (const n of ['NftVoucherCollection', 'NftVoucherItem', 'NftVoucherMinter']) code[n] = await compile(n);
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let server: SandboxContract<TreasuryContract>;
    let users: SandboxContract<TreasuryContract>[];
    let collection: SandboxContract<NftVoucherCollection>;
    let minter: SandboxContract<NftVoucherMinter>;
    const open = (c: any) => blockchain.openContract(c) as any;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        server = await blockchain.treasury('server', { balance: toNano('1000') });
        users = await Promise.all(Array.from({ length: 5 }, (_, i) => blockchain.treasury('user' + i)));
        collection = blockchain.openContract(
            NftVoucherCollection.createFromConfig(
                {
                    ownerAddress: admin.address,
                    collectionContentUrl: 'https://cdn.gumcoin.org/vouchers/collection.json',
                    commonContentUrl: 'https://cdn.gumcoin.org/vouchers/',
                    nftItemCode: code.NftVoucherItem,
                    royaltyParams: { royaltyFactor: 0, royaltyBase: 100, royaltyAddress: admin.address },
                },
                code.NftVoucherCollection,
            ),
        );
        await collection.sendDeploy(admin.getSender(), toNano('0.05'));
        minter = blockchain.openContract(
            NftVoucherMinter.createFromConfig({ admin: admin.address, operator: server.address, collection: collection.address, limitPerDay: 1000, kinds: KINDS }, code.NftVoucherMinter),
        );
        await minter.sendDeploy(admin.getSender(), toNano('0.1'));
        await collection.sendChangeOwner(admin.getSender(), minter.address);
    });

    const requests = (n: number): MintRequest[] => Array.from({ length: n }, (_, i) => ({ owner: users[i % users.length].address, kind: i % 3 }));
    const noSleep = async () => {};

    it('mints 20 requests of one minute in a single batch', async () => {
        const before = (await blockchain.getContract(server.address)).balance;
        const res = await mintPending(open, server.getSender(), minter.address, requests(20), { sleep: noSleep });
        expect(res.minted).toHaveLength(20);
        expect(res.deferred).toHaveLength(0);
        expect((await collection.getCollectionData()).nextItemIndex).toBe(20n);
        // one minter call
        expect((await minter.getMinterData()).mintedToday).toBe(20);
        for (const m of res.minted.slice(0, 4)) {
            const item = blockchain.openContract(NftVoucherItem.createFromAddress(await collection.getNftAddressByIndex(m.index)));
            const d = await item.getNftData();
            expect(d.ownerAddress!.equals(m.request.owner)).toBe(true);
            expect(d.content!.beginParse().loadStringTail()).toBe(KINDS[m.request.kind]);
        }
        const spent = before - (await blockchain.getContract(server.address)).balance;
        const insideVouchers = 20n * toNano('0.15'); // 0.1 voucher value + 0.05 storage reserve
        console.log(`20 vouchers: ${Number(spent - insideVouchers) / 1e9} TON fees + what stays on the collection`);
        expect(spent - insideVouchers).toBeLessThan(toNano('0.06'));
    });

    it('splits more than 100 requests into batches', async () => {
        const res = await mintPending(open, server.getSender(), minter.address, requests(130), { sleep: noSleep });
        expect(res.minted).toHaveLength(130);
        expect((await collection.getCollectionData()).nextItemIndex).toBe(130n);
    });

    it('defers what does not fit into the daily limit', async () => {
        await minter.sendSetLimit(admin.getSender(), 15);
        const res = await mintPending(open, server.getSender(), minter.address, requests(20), { sleep: noSleep });
        expect(res.minted).toHaveLength(15);
        expect(res.deferred).toHaveLength(5);
        expect(res.reason).toBe('daily limit reached');
    });

    it('defers everything while paused', async () => {
        await minter.sendSetPaused(admin.getSender(), true);
        const res = await mintPending(open, server.getSender(), minter.address, requests(3), { sleep: noSleep });
        expect(res.minted).toHaveLength(0);
        expect(res.reason).toBe('minter paused');
    });
});
