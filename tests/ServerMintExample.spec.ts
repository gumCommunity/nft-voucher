// Runs examples/serverMint.ts (mintPending) against the sandbox.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, Sender, SenderArguments, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { buildItemInit, itemAmount, NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { NftVoucherItem } from '../wrappers/NftVoucherItem';
import { NftVoucherMinter } from '../wrappers/NftVoucherMinter';
import { KINDS, mintPending, MintRequest, PendingBatch } from '../examples/serverMint';

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

    /** Holds the server's messages back until deliver(): a slow network / a late confirmation. */
    const slowSender = () => {
        const held: SenderArguments[] = [];
        const sender: Sender = { address: server.address, send: async (a) => void held.push(a) };
        return {
            sender,
            deliver: async () => {
                for (const a of held.splice(0)) await server.send(a);
            },
            drop: () => void held.splice(0),
        };
    };
    const vouchers = async () => (await collection.getCollectionData()).nextItemIndex;
    const noWait = { sleep: noSleep, timeoutMs: -1 };

    it('a batch confirmed after the timeout comes back as pending and is not minted twice', async () => {
        const slow = slowSender();
        const saved: PendingBatch[] = [];
        const r1 = await mintPending(open, slow.sender, minter.address, requests(20), { ...noWait, beforeSend: (b) => void saved.push(b) });
        expect(r1.minted).toHaveLength(0);
        expect(r1.deferred).toHaveLength(0);
        expect(r1.pending!.requests).toHaveLength(20);
        expect(saved).toEqual([r1.pending]); // persisted before it was sent
        await slow.deliver(); // the batch lands after the timeout
        const r2 = await mintPending(open, server.getSender(), minter.address, r1.deferred, { sleep: noSleep, pending: r1.pending });
        expect(r2.minted.map((m) => m.index)).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i)));
        expect(r2.pending).toBeUndefined();
        expect(await vouchers()).toBe(20n); // not 40
    });

    it('a batch that never arrived is sent again with the same item indexes', async () => {
        const lost = slowSender();
        const r1 = await mintPending(open, lost.sender, minter.address, requests(10), noWait);
        lost.drop();
        const r2 = await mintPending(open, server.getSender(), minter.address, r1.deferred, { sleep: noSleep, pending: r1.pending });
        expect(r2.minted.map((m) => m.request)).toEqual(r1.pending!.requests);
        expect(r2.minted.map((m) => m.index)).toEqual(Array.from({ length: 10 }, (_, i) => BigInt(i)));
        expect(await vouchers()).toBe(10n);
    });

    it('if both copies of a batch arrive, one is minted and the other is refunded', async () => {
        const before = (await blockchain.getContract(server.address)).balance;
        const slow = slowSender();
        const r1 = await mintPending(open, slow.sender, minter.address, requests(10), noWait);
        const r2 = await mintPending(open, server.getSender(), minter.address, r1.deferred, { sleep: noSleep, pending: r1.pending });
        await slow.deliver(); // the first copy arrives after the re-sent one
        expect(r2.minted).toHaveLength(10);
        expect(await vouchers()).toBe(10n);
        expect((await minter.getMinterData()).mintedToday).toBe(10);
        const spent = before - (await blockchain.getContract(server.address)).balance;
        expect(spent - 10n * toNano('0.15')).toBeLessThan(toNano('0.1')); // the second copy's TON came back
    });

    it('a pending batch whose indexes were taken by another mint is queued again', async () => {
        const lost = slowSender();
        const r1 = await mintPending(open, lost.sender, minter.address, requests(5), noWait);
        lost.drop();
        // meanwhile the admin mints index 0 through the minter's collection call
        const p = { itemIndex: 0, itemOwner: admin.address, itemContent: '2.json', voucherValue: toNano('0.1') };
        const mint = beginCell().storeUint(1, 32).storeUint(0, 64).storeUint(0, 64).storeCoins(itemAmount(p)).storeRef(buildItemInit(p)).endCell();
        await minter.sendCollectionCall(admin.getSender(), mint, toNano('0.5'));
        expect(await vouchers()).toBe(1n);
        const r2 = await mintPending(open, server.getSender(), minter.address, r1.deferred, { sleep: noSleep, pending: r1.pending });
        expect(r2.minted.map((m) => m.index)).toEqual([1n, 2n, 3n, 4n, 5n]);
        expect(r2.minted.map((m) => m.request)).toEqual(r1.pending!.requests);
        expect(await vouchers()).toBe(6n);
    });
});
