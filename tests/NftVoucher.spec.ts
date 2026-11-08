import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { CollectionErrors, NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { ItemErrors, ItemOpcodes, NftVoucherItem } from '../wrappers/NftVoucherItem';

const VOUCHER = toNano('10');

describe('NftVoucher', () => {
    let collectionCode: Cell;
    let itemCode: Cell;

    beforeAll(async () => {
        collectionCode = await compile('NftVoucherCollection');
        itemCode = await compile('NftVoucherItem');
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let collection: SandboxContract<NftVoucherCollection>;
    let item: SandboxContract<NftVoucherItem>;

    const balanceOf = async (addr: { address: any }) => (await blockchain.getContract(addr.address)).balance;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        alice = await blockchain.treasury('alice');
        bob = await blockchain.treasury('bob');

        collection = blockchain.openContract(
            NftVoucherCollection.createFromConfig(
                {
                    ownerAddress: admin.address,
                    collectionContentUrl: 'https://cdn.gumcoin.org/vouchers/collection.json',
                    commonContentUrl: 'https://cdn.gumcoin.org/vouchers/',
                    nftItemCode: itemCode,
                    royaltyParams: { royaltyFactor: 5, royaltyBase: 100, royaltyAddress: admin.address }, // 5% default
                },
                collectionCode,
            ),
        );
        const deploy = await collection.sendDeploy(admin.getSender(), toNano('0.05'));
        expect(deploy.transactions).toHaveTransaction({ from: admin.address, to: collection.address, deploy: true, success: true });

        const mint = await collection.sendMint(admin.getSender(), {
            itemIndex: 0,
            itemOwner: alice.address,
            itemContent: '0.json',
            voucherValue: VOUCHER,
        });
        const itemAddress = await collection.getNftAddressByIndex(0);
        expect(mint.transactions).toHaveTransaction({ from: collection.address, to: itemAddress, deploy: true, success: true });
        item = blockchain.openContract(NftVoucherItem.createFromAddress(itemAddress));
    });

    it('mints a voucher holding its value', async () => {
        const data = await item.getNftData();
        expect(data.initialized).toBe(true);
        expect(data.index).toBe(0n);
        expect(data.collectionAddress.equals(collection.address)).toBe(true);
        expect(data.ownerAddress!.equals(alice.address)).toBe(true);
        expect(await item.getIsBurned()).toBe(false);
        expect(await item.getVoucherValue()).toBeGreaterThanOrEqual(VOUCHER);
        expect((await collection.getCollectionData()).nextItemIndex).toBe(1n);
    });

    it('transfer keeps the voucher value inside the item', async () => {
        const before = await balanceOf(item);
        const res = await item.sendTransfer(alice.getSender(), {
            newOwner: bob.address,
            responseDestination: alice.address,
            value: toNano('0.05'),
        });
        expect(res.transactions).toHaveTransaction({ from: alice.address, to: item.address, success: true });
        // excess goes back to alice and it is only a part of the attached 0.05 TON
        expect(res.transactions).toHaveTransaction({
            from: item.address,
            to: alice.address,
            op: ItemOpcodes.excesses,
            value: (v) => v! > 0n && v! < toNano('0.05'),
        });
        expect((await item.getNftData()).ownerAddress!.equals(bob.address)).toBe(true);
        expect(await balanceOf(item)).toBeGreaterThanOrEqual(before);
    });

    it('transfer with forward amount sends ownership_assigned and keeps value', async () => {
        const before = await balanceOf(item);
        const res = await item.sendTransfer(alice.getSender(), {
            newOwner: bob.address,
            responseDestination: alice.address,
            forwardAmount: toNano('0.1'),
            forwardPayload: beginCell().storeUint(42, 32).endCell(),
            value: toNano('0.2'),
        });
        expect(res.transactions).toHaveTransaction({
            from: item.address,
            to: bob.address,
            op: ItemOpcodes.ownershipAssigned,
            value: toNano('0.1'),
        });
        expect(await balanceOf(item)).toBeGreaterThanOrEqual(before);
    });

    it('rejects a transfer that does not pay its own fees', async () => {
        const res = await item.sendTransfer(alice.getSender(), {
            newOwner: bob.address,
            responseDestination: alice.address,
            forwardAmount: toNano('1'),
            value: toNano('0.5'),
        });
        expect(res.transactions).toHaveTransaction({ from: alice.address, to: item.address, success: false, exitCode: ItemErrors.notEnoughTon });
        expect((await item.getNftData()).ownerAddress!.equals(alice.address)).toBe(true);
        expect(await item.getVoucherValue()).toBeGreaterThanOrEqual(VOUCHER);
    });

    it('only the owner can transfer', async () => {
        const res = await item.sendTransfer(bob.getSender(), { newOwner: bob.address });
        expect(res.transactions).toHaveTransaction({ from: bob.address, to: item.address, success: false, exitCode: ItemErrors.notOwner });
    });

    it('only the owner can burn', async () => {
        const res = await item.sendDestroy(bob.getSender());
        expect(res.transactions).toHaveTransaction({ from: bob.address, to: item.address, success: false, exitCode: ItemErrors.notOwner });
        expect(await item.getIsBurned()).toBe(false);
        expect(await item.getVoucherValue()).toBeGreaterThanOrEqual(VOUCHER);
    });

    it('burn sends the whole balance to the owner who burns', async () => {
        const itemBalance = await balanceOf(item);
        const aliceBefore = await balanceOf(alice);

        const res = await item.sendDestroy(alice.getSender(), { value: toNano('0.02') });
        expect(res.transactions).toHaveTransaction({ from: alice.address, to: item.address, success: true });
        expect(res.transactions).toHaveTransaction({
            from: item.address,
            to: alice.address,
            op: ItemOpcodes.excesses,
            value: (v) => v! >= itemBalance,
        });

        expect(await balanceOf(item)).toBe(0n);
        expect(await item.getIsBurned()).toBe(true);
        expect((await item.getNftData()).ownerAddress).toBeNull();
        // alice got the voucher value minus a few fees
        expect((await balanceOf(alice)) - aliceBefore).toBeGreaterThan(VOUCHER - toNano('0.05'));
    });

    it('new owner gets the value after transfer + burn', async () => {
        await item.sendTransfer(alice.getSender(), { newOwner: bob.address, responseDestination: alice.address });
        const bobBefore = await balanceOf(bob);
        expect((await item.sendDestroy(alice.getSender())).transactions).toHaveTransaction({
            from: alice.address,
            to: item.address,
            exitCode: ItemErrors.notOwner,
        });
        await item.sendDestroy(bob.getSender());
        expect((await balanceOf(bob)) - bobBefore).toBeGreaterThan(VOUCHER - toNano('0.05'));
    });

    it('burned voucher cannot be transferred or burned again', async () => {
        await item.sendDestroy(alice.getSender());
        const t = await item.sendTransfer(alice.getSender(), { newOwner: bob.address });
        expect(t.transactions).toHaveTransaction({ to: item.address, success: false, exitCode: ItemErrors.notOwner });
        const d = await item.sendDestroy(alice.getSender());
        expect(d.transactions).toHaveTransaction({ to: item.address, success: false, exitCode: ItemErrors.notOwner });
    });

    it('collection admin cannot re-mint a burned index', async () => {
        await item.sendDestroy(alice.getSender());
        await collection.sendMint(admin.getSender(), {
            itemIndex: 0,
            itemOwner: admin.address,
            itemContent: '0.json',
            voucherValue: toNano('1'),
        });
        expect(await item.getIsBurned()).toBe(true);
        expect((await item.getNftData()).ownerAddress).toBeNull();
    });

    it('top-up increases the voucher value', async () => {
        const before = await item.getVoucherValue();
        await item.sendTopUp(bob.getSender(), toNano('5'));
        // a tiny amount of gas for processing the empty message is paid from the top-up itself
        expect(await item.getVoucherValue()).toBeGreaterThan(before + toNano('5') - toNano('0.001'));
    });

    it('batch mint creates several vouchers', async () => {
        await collection.sendBatchMint(admin.getSender(), [
            { itemIndex: 1, itemOwner: alice.address, itemContent: '1.json', voucherValue: toNano('1') },
            { itemIndex: 2, itemOwner: bob.address, itemContent: '2.json', voucherValue: toNano('2') },
        ]);
        expect((await collection.getCollectionData()).nextItemIndex).toBe(3n);
        const i2 = blockchain.openContract(NftVoucherItem.createFromAddress(await collection.getNftAddressByIndex(2)));
        expect((await i2.getNftData()).ownerAddress!.equals(bob.address)).toBe(true);
        expect(await i2.getVoucherValue()).toBeGreaterThanOrEqual(toNano('2'));
    });

    it('three voucher kinds resolve to the Gumcoin metadata URLs', async () => {
        await collection.sendBatchMint(admin.getSender(), [
            { itemIndex: 1, itemOwner: alice.address, itemContent: '1.json', voucherValue: toNano('1') },
            { itemIndex: 2, itemOwner: alice.address, itemContent: '2.json', voucherValue: toNano('1') },
        ]);
        for (const i of [0, 1, 2]) {
            const it = blockchain.openContract(NftVoucherItem.createFromAddress(await collection.getNftAddressByIndex(i)));
            const { content } = await it.getNftData();
            expect(await collection.getNftContentUrl(i, content!)).toBe(`https://cdn.gumcoin.org/vouchers/${i}.json`);
        }
    });

    it('collection owner can be changed; only the new owner can mint', async () => {
        expect((await collection.sendChangeOwner(alice.getSender(), alice.address)).transactions).toHaveTransaction({
            from: alice.address,
            to: collection.address,
            success: false,
            exitCode: 401,
        });
        await collection.sendChangeOwner(admin.getSender(), bob.address);
        expect((await collection.getCollectionData()).ownerAddress.equals(bob.address)).toBe(true);

        const old = await collection.sendMint(admin.getSender(), { itemIndex: 1, itemOwner: admin.address, itemContent: '1.json', voucherValue: toNano('1') });
        expect(old.transactions).toHaveTransaction({ from: admin.address, to: collection.address, success: false, exitCode: 401 });
        await collection.sendMint(bob.getSender(), { itemIndex: 1, itemOwner: alice.address, itemContent: '1.json', voucherValue: toNano('1') });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(2n);
    });

    it('has 5% royalty by default', async () => {
        const r = await collection.getRoyaltyParams();
        expect([r.royaltyFactor, r.royaltyBase]).toEqual([5, 100]);
        expect(r.royaltyAddress.equals(admin.address)).toBe(true);
    });

    it('owner changes royalty, metadata URLs stay the same', async () => {
        const urls = await collection.getContentUrls();
        expect(urls).toEqual({
            collectionContentUrl: 'https://cdn.gumcoin.org/vouchers/collection.json',
            commonContentUrl: 'https://cdn.gumcoin.org/vouchers/',
        });
        const res = await collection.sendChangeContent(admin.getSender(), {
            ...urls,
            royaltyParams: { royaltyFactor: 25, royaltyBase: 1000, royaltyAddress: bob.address },
        });
        expect(res.transactions).toHaveTransaction({ from: admin.address, to: collection.address, success: true });

        const r = await collection.getRoyaltyParams();
        expect([r.royaltyFactor, r.royaltyBase]).toEqual([25, 1000]);
        expect(r.royaltyAddress.equals(bob.address)).toBe(true);
        expect(await collection.getContentUrls()).toEqual(urls);
        const { content } = await item.getNftData();
        expect(await collection.getNftContentUrl(0, content!)).toBe('https://cdn.gumcoin.org/vouchers/0.json');
        // minting keeps working after the change
        await collection.sendMint(admin.getSender(), { itemIndex: 1, itemOwner: alice.address, itemContent: '2.json', voucherValue: toNano('1') });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(2n);
    });

    it('only the owner can change royalty', async () => {
        const urls = await collection.getContentUrls();
        const res = await collection.sendChangeContent(bob.getSender(), {
            ...urls,
            royaltyParams: { royaltyFactor: 50, royaltyBase: 100, royaltyAddress: bob.address },
        });
        expect(res.transactions).toHaveTransaction({ from: bob.address, to: collection.address, success: false, exitCode: CollectionErrors.notOwner });
        expect((await collection.getRoyaltyParams()).royaltyFactor).toBe(5);
    });

    it.each([
        [150, 100],
        [1, 0],
    ])('rejects invalid royalty %i/%i', async (factor, base) => {
        const urls = await collection.getContentUrls();
        const res = await collection.sendChangeContent(admin.getSender(), {
            ...urls,
            royaltyParams: { royaltyFactor: factor, royaltyBase: base, royaltyAddress: admin.address },
        });
        expect(res.transactions).toHaveTransaction({ to: collection.address, success: false, exitCode: CollectionErrors.invalidRoyalty });
        expect((await collection.getRoyaltyParams()).royaltyFactor).toBe(5);
    });

    it('only collection owner can mint', async () => {
        const res = await collection.sendMint(alice.getSender(), {
            itemIndex: 1,
            itemOwner: alice.address,
            itemContent: '1.json',
            voucherValue: toNano('1'),
        });
        expect(res.transactions).toHaveTransaction({ from: alice.address, to: collection.address, success: false, exitCode: 401 });
    });
});
