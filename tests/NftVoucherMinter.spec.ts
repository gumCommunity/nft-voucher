import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, DictionaryValue, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { itemAmount, NftVoucherCollection } from '../wrappers/NftVoucherCollection';
import { NftVoucherItem } from '../wrappers/NftVoucherItem';
import { kindContentCell, MAX_BATCH, MinterErrors, MinterOpcodes, NftVoucherMinter, requiredMintValue } from '../wrappers/NftVoucherMinter';
import { scaleFees } from './helpers/fees';

const KINDS = ['0.json', '1.json', '2.json'];

describe('NftVoucherMinter', () => {
    let code: Record<string, Cell> = {};
    beforeAll(async () => {
        for (const n of ['NftVoucherCollection', 'NftVoucherItem', 'NftVoucherMinter']) code[n] = await compile(n);
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let operator: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let collection: SandboxContract<NftVoucherCollection>;
    let minter: SandboxContract<NftVoucherMinter>;
    let nextIndex: number;

    const item = async (i: number) => blockchain.openContract(NftVoucherItem.createFromAddress(await collection.getNftAddressByIndex(i)));
    const ownerOf = async (i: number) => (await (await item(i)).getNftData()).ownerAddress;
    const mint = (via = operator, content = '0.json', owner: Address = alice.address, opts: { index?: number; value?: bigint } = {}) =>
        minter.sendMint(via.getSender(), { itemIndex: opts.index ?? nextIndex, itemOwner: owner, itemContent: content, voucherValue: toNano('0.1'), value: opts.value });
    const mintOk = async (content = '0.json', owner: Address = alice.address) => {
        const res = await mint(operator, content, owner);
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: collection.address, success: true });
        nextIndex++;
        return res;
    };

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_800_000_000;
        admin = await blockchain.treasury('admin');
        operator = await blockchain.treasury('operator');
        alice = await blockchain.treasury('alice');
        bob = await blockchain.treasury('bob');
        nextIndex = 0;

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
            NftVoucherMinter.createFromConfig(
                { admin: admin.address, operator: operator.address, collection: collection.address, limitPerDay: 3, kinds: KINDS },
                code.NftVoucherMinter,
            ),
        );
        await minter.sendDeploy(admin.getSender(), toNano('0.1'));
        // hand the collection over to the minter
        await collection.sendChangeOwner(admin.getSender(), minter.address);
    });

    it('owns the collection and is configured', async () => {
        expect((await collection.getCollectionData()).ownerAddress.equals(minter.address)).toBe(true);
        const d = await minter.getMinterData();
        expect(d.admin.equals(admin.address)).toBe(true);
        expect(d.operator!.equals(operator.address)).toBe(true);
        expect(d.collection.equals(collection.address)).toBe(true);
        expect([d.paused, d.limit, d.mintedToday, d.remainingToday]).toEqual([false, 3, 0, 3]);
        for (const k of KINDS) expect(await minter.getIsKindAllowed(k)).toBe(true);
        expect(await minter.getIsKindAllowed('3.json')).toBe(false);
    });

    it('operator mints a voucher through the minter', async () => {
        await mintOk('1.json', alice.address);
        expect((await ownerOf(0))!.equals(alice.address)).toBe(true);
        expect(await (await item(0)).getVoucherValue()).toBeGreaterThanOrEqual(toNano('0.1'));
        expect((await minter.getMinterData()).mintedToday).toBe(1);
    });

    it('operator pays for the vouchers, the minter balance is not spent', async () => {
        await admin.send({ to: minter.address, value: toNano('5') });
        const before = (await blockchain.getContract(minter.address)).balance;
        await mintOk();
        expect((await blockchain.getContract(minter.address)).balance).toBeGreaterThanOrEqual(before - toNano('0.001'));
        const res = await mint(operator, '0.json', alice.address, { value: toNano('0.1') }); // less than amount + fee
        expect(res.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: MinterErrors.notEnoughTon });
    });

    it('only the operator can mint through the minter', async () => {
        for (const who of [bob, admin]) {
            const res = await mint(who);
            expect(res.transactions).toHaveTransaction({ from: who.address, to: minter.address, success: false, exitCode: MinterErrors.notOperator });
        }
        expect((await collection.getCollectionData()).nextItemIndex).toBe(0n);
    });

    it('nobody but the minter can mint in the collection anymore', async () => {
        const res = await collection.sendMint(admin.getSender(), { itemIndex: 0, itemOwner: admin.address, itemContent: '0.json', voucherValue: toNano('0.1') });
        expect(res.transactions).toHaveTransaction({ from: admin.address, to: collection.address, success: false, exitCode: 401 });
    });

    it('rejects voucher kinds that are not allowed; admin can allow them', async () => {
        const res = await mint(operator, '3.json');
        expect(res.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: MinterErrors.kindNotAllowed });
        await minter.sendSetKind(admin.getSender(), '3.json', true);
        await mintOk('3.json');
        await minter.sendSetKind(admin.getSender(), '0.json', false);
        expect((await mint(operator, '0.json')).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.kindNotAllowed });
    });

    it('enforces the daily limit and resets it after 24 hours', async () => {
        await mintOk();
        await mintOk();
        await mintOk();
        const res = await mint();
        expect(res.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: MinterErrors.limitExceeded });
        expect((await minter.getMinterData()).remainingToday).toBe(0);

        blockchain.now! += 86400;
        expect((await minter.getMinterData()).remainingToday).toBe(3);
        await mintOk();
        expect((await minter.getMinterData()).mintedToday).toBe(1);
    });

    it('batch mint counts every voucher against the limit', async () => {
        const items = (n: number, start: number) =>
            Array.from({ length: n }, (_, i) => ({ itemIndex: start + i, itemOwner: alice.address, itemContent: KINDS[i % 3], voucherValue: toNano('0.1') }));

        const tooMany = await minter.sendBatchMint(operator.getSender(), items(4, 0));
        expect(tooMany.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: MinterErrors.limitExceeded });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(0n);

        const ok = await minter.sendBatchMint(operator.getSender(), items(2, 0));
        expect(ok.transactions).toHaveTransaction({ from: minter.address, to: collection.address, success: true });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(2n);
        expect((await minter.getMinterData()).mintedToday).toBe(2);

        const badKind = await minter.sendBatchMint(operator.getSender(), [
            { itemIndex: 2, itemOwner: alice.address, itemContent: '9.json', voucherValue: toNano('0.1') },
        ]);
        expect(badKind.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: MinterErrors.kindNotAllowed });
    });

    it('forwards only what the collection needs and refunds the rest to the operator', async () => {
        const items = Array.from({ length: 3 }, (_, i) => ({ itemIndex: i, itemOwner: alice.address, itemContent: KINDS[i], voucherValue: toNano('0.1') }));
        const amounts = items.length * Number(toNano('0.15')); // voucher value + 0.05 storage reserve each
        const minterBefore = (await blockchain.getContract(minter.address)).balance;
        const colBefore = (await blockchain.getContract(collection.address)).balance;
        const opBefore = (await blockchain.getContract(operator.address)).balance;

        const res = await minter.sendBatchMint(operator.getSender(), items, { value: toNano('5') }); // heavy overpay
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: operator.address, op: 0xd53276db, value: (v) => v! > toNano('4.4') });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(3n);

        const spent = opBefore - (await blockchain.getContract(operator.address)).balance;
        expect(spent - BigInt(amounts)).toBeLessThan(toNano('0.03')); // fees + what stays on the collection
        expect((await blockchain.getContract(collection.address)).balance - colBefore).toBeLessThan(toNano('0.01'));
        expect((await blockchain.getContract(minter.address)).balance).toBeGreaterThanOrEqual(minterBefore - toNano('0.001'));
    });

    it(`accepts batches up to ${MAX_BATCH} vouchers`, async () => {
        await minter.sendSetLimit(admin.getSender(), 1000);
        const items = (n: number, start: number) =>
            Array.from({ length: n }, (_, i) => ({ itemIndex: start + i, itemOwner: alice.address, itemContent: KINDS[i % 3], voucherValue: toNano('0.1') }));
        const tooBig = await minter.sendBatchMint(operator.getSender(), items(MAX_BATCH + 1, 0));
        expect(tooBig.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: MinterErrors.badBatch });

        const ok = await minter.sendBatchMint(operator.getSender(), items(MAX_BATCH, 0));
        expect(ok.transactions).not.toHaveTransaction({ success: false });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(BigInt(MAX_BATCH));
        expect((await minter.getMinterData()).mintedToday).toBe(MAX_BATCH);
    });

    it('requires at least amount + fees', async () => {
        const need = requiredMintValue(toNano('0.15'), 1);
        expect((await mint(operator, '0.json', alice.address, { value: need - 1n })).transactions).toHaveTransaction({
            to: minter.address,
            exitCode: MinterErrors.notEnoughTon,
        });
        expect((await mint(operator, '0.json', alice.address, { value: need })).transactions).toHaveTransaction({
            from: minter.address,
            to: collection.address,
            success: true,
        });
    });

    it('admin changes the collection fees (too low fees are paid from the collection balance)', async () => {
        expect((await minter.sendSetFees(operator.getSender(), 0n, 0n)).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.notAdmin });

        await minter.sendSetFees(admin.getSender(), 0n, 0n);
        const d = await minter.getMinterData();
        expect([d.feePerItem, d.feePerCall]).toEqual([0n, 0n]);
        const colBefore = (await blockchain.getContract(collection.address)).balance;
        await mintOk();
        // the collection covered the deploy fees from its own TON
        expect((await blockchain.getContract(collection.address)).balance).toBeLessThan(colBefore);

        await minter.sendSetFees(admin.getSender(), toNano('0.002'), toNano('0.005'));
        const colBefore2 = (await blockchain.getContract(collection.address)).balance;
        await mintOk();
        // with the default fees the collection does not lose TON
        expect((await blockchain.getContract(collection.address)).balance).toBeGreaterThanOrEqual(colBefore2);
    });

    it('restores the counter when the collection rejects a mint', async () => {
        const res = await mint(operator, '0.json', alice.address, { index: 5 }); // index ahead of next_item_index
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: collection.address, success: false, exitCode: 402 });
        expect(res.transactions).toHaveTransaction({ from: collection.address, to: minter.address, inMessageBounced: true });
        expect((await minter.getMinterData()).mintedToday).toBe(0);
        // the returned TON goes on to the operator
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: operator.address, op: 0xd53276db, value: (v) => v! > toNano('0.1') });
    });

    it('pause stops the operator', async () => {
        await minter.sendSetPaused(admin.getSender(), true);
        expect((await mint()).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.paused });
        await minter.sendSetPaused(admin.getSender(), false);
        await mintOk();
    });

    it('admin replaces a leaked operator key', async () => {
        await minter.sendSetOperator(admin.getSender(), bob.address);
        expect((await mint(operator)).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.notOperator });
        const res = await mint(bob);
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: collection.address, success: true });

        await minter.sendSetOperator(admin.getSender(), null); // disable completely
        expect((await mint(bob)).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.notOperator });
    });

    it('operator cannot use admin operations', async () => {
        const s = operator.getSender();
        for (const call of [
            () => minter.sendSetOperator(s, operator.address),
            () => minter.sendSetLimit(s, 1000),
            () => minter.sendSetPaused(s, false),
            () => minter.sendSetKind(s, '9.json', true),
            () => minter.sendChangeCollectionOwner(s, operator.address),
            () => minter.sendWithdrawTon(s),
            () => minter.sendProposeAdmin(s, operator.address),
        ]) {
            expect((await call()).transactions).toHaveTransaction({ from: operator.address, to: minter.address, exitCode: MinterErrors.notAdmin });
        }
        expect((await collection.getCollectionData()).ownerAddress.equals(minter.address)).toBe(true);
    });

    it('admin changes the limit', async () => {
        await minter.sendSetLimit(admin.getSender(), 1);
        await mintOk();
        expect((await mint()).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.limitExceeded });
    });

    it('admin changes royalty through the minter', async () => {
        const urls = await collection.getContentUrls();
        await minter.sendChangeCollectionContent(admin.getSender(), { ...urls, royaltyParams: { royaltyFactor: 3, royaltyBase: 100, royaltyAddress: bob.address } });
        const r = await collection.getRoyaltyParams();
        expect([r.royaltyFactor, r.royaltyBase]).toEqual([3, 100]);
        expect(r.royaltyAddress.equals(bob.address)).toBe(true);
        expect(await collection.getContentUrls()).toEqual(urls);
    });

    it('admin moves the collection to a new minter (rotation)', async () => {
        const minter2 = blockchain.openContract(
            NftVoucherMinter.createFromConfig(
                { admin: admin.address, operator: bob.address, collection: collection.address, limitPerDay: 10, kinds: KINDS },
                code.NftVoucherMinter,
            ),
        );
        await minter2.sendDeploy(admin.getSender(), toNano('0.1'));
        await minter.sendChangeCollectionOwner(admin.getSender(), minter2.address);
        expect((await collection.getCollectionData()).ownerAddress.equals(minter2.address)).toBe(true);

        // old minter: the collection rejects it, the bounce restores the counter
        const old = await mint(operator);
        expect(old.transactions).toHaveTransaction({ from: minter.address, to: collection.address, success: false, exitCode: 401 });
        expect((await minter.getMinterData()).mintedToday).toBe(0);

        await minter2.sendMint(bob.getSender(), { itemIndex: 0, itemOwner: alice.address, itemContent: '2.json', voucherValue: toNano('0.1') });
        expect((await ownerOf(0))!.equals(alice.address)).toBe(true);
    });

    it('admin can take the collection back to a wallet', async () => {
        await minter.sendChangeCollectionOwner(admin.getSender(), admin.address);
        expect((await collection.getCollectionData()).ownerAddress.equals(admin.address)).toBe(true);
    });

    it('admin change takes two steps', async () => {
        await minter.sendProposeAdmin(admin.getSender(), bob.address);
        expect((await minter.getMinterData()).pendingAdmin!.equals(bob.address)).toBe(true);
        // still the old admin until accepted
        expect((await minter.sendSetLimit(bob.getSender(), 99)).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.notAdmin });
        // nobody else can accept
        expect((await minter.sendAcceptAdmin(alice.getSender())).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.notPendingAdmin });

        await minter.sendAcceptAdmin(bob.getSender());
        const d = await minter.getMinterData();
        expect(d.admin.equals(bob.address)).toBe(true);
        expect(d.pendingAdmin).toBeNull();
        expect((await minter.sendSetLimit(admin.getSender(), 99)).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.notAdmin });
        await minter.sendSetLimit(bob.getSender(), 99);
        expect((await minter.getMinterData()).limit).toBe(99);
    });

    it('a pending admin change can be cancelled', async () => {
        await minter.sendProposeAdmin(admin.getSender(), bob.address);
        await minter.sendProposeAdmin(admin.getSender(), null);
        expect((await minter.sendAcceptAdmin(bob.getSender())).transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.notPendingAdmin });
        expect((await minter.getMinterData()).admin.equals(admin.address)).toBe(true);
    });

    it('admin withdraws TON', async () => {
        await bob.send({ to: minter.address, value: toNano('3') });
        const before = (await blockchain.getContract(admin.address)).balance;
        await minter.sendWithdrawTon(admin.getSender());
        expect((await blockchain.getContract(admin.address)).balance - before).toBeGreaterThan(toNano('2.9'));
        expect((await blockchain.getContract(minter.address)).balance).toBeLessThanOrEqual(toNano('0.05'));
    });

    it('vouchers minted through the minter are normal vouchers (transfer + burn)', async () => {
        await mintOk('0.json', alice.address);
        const v = await item(0);
        await v.sendTransfer(alice.getSender(), { newOwner: bob.address, responseDestination: alice.address });
        await v.sendDestroy(bob.getSender());
        expect(await v.getIsBurned()).toBe(true);
    });

    const batchOf = (n: number, start = 0) =>
        Array.from({ length: n }, (_, i) => ({ itemIndex: start + i, itemOwner: alice.address, itemContent: KINDS[i % 3], voucherValue: toNano('0.1') }));
    const tonOf = async (a: Address) => (await blockchain.getContract(a)).balance;

    it('requiredMintValue is enough for a full batch', async () => {
        await minter.sendSetLimit(admin.getSender(), 1000);
        const items = batchOf(MAX_BATCH);
        const total = items.reduce((a, i) => a + itemAmount(i), 0n);
        const res = await minter.sendBatchMint(operator.getSender(), items, { value: requiredMintValue(total, MAX_BATCH) });
        expect(res.transactions).not.toHaveTransaction({ success: false });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(BigInt(MAX_BATCH));
    });

    it('if the minter cannot pay for its message (fee spike), the operator gets the TON back', async () => {
        await minter.sendSetLimit(admin.getSender(), 1000);
        const items = batchOf(MAX_BATCH);
        const total = items.reduce((a, i) => a + itemAmount(i), 0n);
        scaleFees(blockchain, 10n); // the minter's fee no longer covers its own gas
        const operatorBefore = await tonOf(operator.address);
        const minterBefore = await tonOf(minter.address);
        const res = await minter.sendBatchMint(operator.getSender(), items, { value: requiredMintValue(total, MAX_BATCH) });
        expect(res.transactions).toHaveTransaction({ from: operator.address, to: minter.address, aborted: true });
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: operator.address, inMessageBounced: true });
        expect((await minter.getMinterData()).mintedToday).toBe(0);
        expect(await tonOf(minter.address)).toBeGreaterThanOrEqual(minterBefore - toNano('0.001')); // nothing stays on the minter
        expect(operatorBefore - (await tonOf(operator.address))).toBeLessThan(toNano('0.5')); // ~15 TON came back
    });

    it('if the collection cannot pay for the vouchers (fee spike), the TON returns to the operator and the counter is restored', async () => {
        await minter.sendSetLimit(admin.getSender(), 1000);
        scaleFees(blockchain, 4n); // fee_per_item / fee_per_call no longer cover the deploys, the collection itself holds ~0.1 TON
        const operatorBefore = await tonOf(operator.address);
        const collectionBefore = await tonOf(collection.address);
        const res = await minter.sendBatchMint(operator.getSender(), batchOf(MAX_BATCH));
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: collection.address, aborted: true });
        expect(res.transactions).toHaveTransaction({ from: collection.address, to: minter.address, inMessageBounced: true });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(0n);
        expect((await minter.getMinterData()).mintedToday).toBe(0);
        expect(await tonOf(collection.address)).toBeLessThanOrEqual(collectionBefore); // the collection has no withdrawal
        expect(operatorBefore - (await tonOf(operator.address))).toBeLessThan(toNano('0.5'));
    });

    it('a repeated batch (e.g. a retry) is rejected by the collection: TON refunded, counter restored', async () => {
        await minter.sendSetLimit(admin.getSender(), 1000);
        const items = batchOf(3);
        await minter.sendBatchMint(operator.getSender(), items);
        const operatorBefore = await tonOf(operator.address);
        const collectionBefore = await tonOf(collection.address);
        const res = await minter.sendBatchMint(operator.getSender(), items);
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: collection.address, success: false, exitCode: 403 + 1 });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(3n);
        expect((await minter.getMinterData()).mintedToday).toBe(3);
        expect(await tonOf(collection.address)).toBeLessThanOrEqual(collectionBefore);
        expect(operatorBefore - (await tonOf(operator.address))).toBeLessThan(toNano('0.05'));
    });

    it('the operator cannot add forward fields to a voucher (no notification on mint)', async () => {
        // with forward_amount the new voucher would send ownership_assigned(prev_owner = collection) to its owner,
        // e.g. make the redeemer pay GUM to the collection
        const content = beginCell().storeAddress(alice.address).storeRef(kindContentCell('0.json')).storeCoins(toNano('0.15')).storeBit(false).endCell();
        const single = beginCell().storeUint(MinterOpcodes.mint, 32).storeUint(0, 64).storeUint(0, 64).storeCoins(toNano('0.4')).storeRef(content).endCell();
        expect((await operator.send({ to: minter.address, value: toNano('1'), body: single })).transactions).toHaveTransaction({
            to: minter.address,
            success: false,
            exitCode: MinterErrors.badItem,
        });
        const RawItem: DictionaryValue<Cell> = {
            serialize: (c, b) => b.storeCoins(toNano('0.4')).storeRef(c),
            parse: () => {
                throw new Error('unused');
            },
        };
        const list = Dictionary.empty(Dictionary.Keys.BigUint(64), RawItem);
        list.set(0n, content);
        const batch = beginCell().storeUint(MinterOpcodes.batchMint, 32).storeUint(0, 64).storeRef(beginCell().storeDictDirect(list).endCell()).endCell();
        expect((await operator.send({ to: minter.address, value: toNano('1'), body: batch })).transactions).toHaveTransaction({
            to: minter.address,
            success: false,
            exitCode: MinterErrors.badItem,
        });
        expect((await collection.getCollectionData()).nextItemIndex).toBe(0n);
    });

    it('rejects unknown ops', async () => {
        const res = await admin.send({ to: minter.address, value: toNano('0.05'), body: beginCell().storeUint(0xdeadbeef, 32).storeUint(0, 64).endCell() });
        expect(res.transactions).toHaveTransaction({ to: minter.address, exitCode: MinterErrors.unknownOp });
    });
});
