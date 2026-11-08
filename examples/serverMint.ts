// Example: a backend mints vouchers with the OPERATOR key through the minter (no Blueprint).
//
// Collect requests (e.g. for one minute), then call mintPending(): it sends them as batches of up to 100 vouchers
// in one transaction each (~0.0025 TON per voucher in fees vs ~0.008 TON when minting one by one), respects the
// daily limit and returns:
//   minted   — confirmed vouchers (request + item index);
//   deferred — requests that were NOT sent (daily limit, pause, unknown kind): pass them again next time;
//   pending  — a batch that WAS sent but not confirmed within the timeout. Pass it back as `opts.pending` and never
//              put its requests back into the queue yourself: mintPending checks whether it landed and, if not, sends
//              exactly the same batch (same item indexes) again. The collection accepts only next_item_index, so at
//              most one copy is minted; the other one bounces and its TON is refunded.
// Persist every batch in `opts.beforeSend` (called right before sending): if the process dies after sending,
// that saved batch is your `pending` for the next run.
//
//   OPERATOR_MNEMONIC="word1 ... word24" MINTER=EQ... NETWORK=testnet \
//   npx ts-node examples/serverMint.ts requests.json
//   requests.json: [{ "owner": "UQ...", "kind": 0, "ton": "0.1" }, ...]   kind: 0 = 10 000, 1 = 5 000, 2 = 1 000 GUM
//   The script rewrites requests.json with what still has to be sent and keeps an unconfirmed batch in
//   pending-batch.json (PENDING_FILE), which is checked on the next run.
//
// Keep the mnemonic only on the server (env / secret manager). If it leaks, the admin replaces the operator
// with manageMinter; until then at most `limit` vouchers per 24h can be minted.
//
// Run ONE mintPending at a time and do not mint through the collection by other means meanwhile: a batch is
// confirmed by the collection's next_item_index and the kinds of its first and last voucher.
import { Address, Contract, fromNano, OpenedContract, Sender, toNano } from '@ton/core';
import { NftVoucherMinter, MAX_BATCH, requiredMintValue } from '../wrappers/NftVoucherMinter';
import { NftVoucherCollection, MintParams } from '../wrappers/NftVoucherCollection';
import { NftVoucherItem } from '../wrappers/NftVoucherItem';

export const KINDS = ['0.json', '1.json', '2.json']; // 10 000 / 5 000 / 1 000 GUM
const STORAGE_RESERVE = toNano('0.05'); // added to every voucher by the collection wrapper

export type MintRequest = { owner: Address; kind: number; tonInside?: bigint };
/** A sent batch: item `start + i` is minted for `requests[i]`. */
export type PendingBatch = { start: bigint; requests: MintRequest[] };
export type MintResult = { minted: { request: MintRequest; index: bigint }[]; deferred: MintRequest[]; pending?: PendingBatch; reason?: string };

type Open = <T extends Contract>(c: T) => OpenedContract<T>;

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Are the batch's vouchers on-chain? The kind (item content) never changes after mint, unlike the owner. */
async function landed(open: Open, collection: OpenedContract<NftVoucherCollection>, batch: PendingBatch): Promise<boolean> {
    for (const i of new Set([0, batch.requests.length - 1])) {
        const item = open(NftVoucherItem.createFromAddress(await collection.getNftAddressByIndex(batch.start + BigInt(i))));
        const { content } = await item.getNftData();
        if (!content || content.beginParse().loadStringTail() !== KINDS[batch.requests[i].kind]) return false;
    }
    return true;
}

export async function mintPending(
    open: Open,
    sender: Sender,
    minterAddress: Address,
    requests: MintRequest[],
    opts: {
        sleep?: (ms: number) => Promise<void>;
        timeoutMs?: number;
        pending?: PendingBatch;
        beforeSend?: (batch: PendingBatch) => void | Promise<void>;
    } = {},
): Promise<MintResult> {
    const sleep = opts.sleep ?? defaultSleep;
    const minter = open(NftVoucherMinter.createFromAddress(minterAddress));
    const result: MintResult = { minted: [], deferred: requests.filter((r) => KINDS[r.kind] === undefined) }; // unknown kind: never mintable
    let queue = requests.filter((r) => KINDS[r.kind] !== undefined);
    let pending = opts.pending;
    const stop = (reason: string): MintResult => ({ ...result, deferred: [...result.deferred, ...queue], pending, reason });

    while (pending || queue.length > 0) {
        const m = await minter.getMinterData();
        const collection = open(NftVoucherCollection.createFromAddress(m.collection));
        const next = (await collection.getCollectionData()).nextItemIndex;

        if (pending) {
            const sent = pending;
            if (next >= sent.start + BigInt(sent.requests.length) && (await landed(open, collection, sent))) {
                sent.requests.forEach((request, i) => result.minted.push({ request, index: sent.start + BigInt(i) }));
                pending = undefined;
                continue;
            }
            if (next > sent.start) {
                // its indexes were used by another mint, so this batch can never land: queue its requests again
                queue = [...sent.requests, ...queue];
                pending = undefined;
                continue;
            }
            // next == start: not minted (yet) -> send exactly the same batch again below
        }

        if (m.paused) return stop('minter paused');
        const batch = pending ?? { start: next, requests: queue.slice(0, Math.min(MAX_BATCH, m.remainingToday)) };
        if (batch.requests.length === 0 || m.remainingToday < batch.requests.length) return stop('daily limit reached');

        const items: MintParams[] = batch.requests.map((r, i) => ({
            itemIndex: batch.start + BigInt(i),
            itemOwner: r.owner,
            itemContent: KINDS[r.kind],
            voucherValue: r.tonInside ?? toNano('0.1'),
        }));
        const total = items.reduce((a, i) => a + i.voucherValue + STORAGE_RESERVE, 0n);
        // what the minter requires + a small margin; the unused part is refunded to the operator
        const value = requiredMintValue(total, items.length, m.feePerItem, m.feePerCall) + toNano('0.02');

        if (!pending) {
            await opts.beforeSend?.(batch);
            queue = queue.slice(batch.requests.length);
            pending = batch;
        }
        await minter.sendBatchMint(sender, items, { value });

        // wait until the collection has deployed the batch; the next loop iteration confirms it
        const target = batch.start + BigInt(batch.requests.length);
        const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
        while ((await collection.getCollectionData()).nextItemIndex < target) {
            if (Date.now() > deadline) return stop('batch not confirmed in time: pass `pending` to the next call');
            await sleep(3000);
        }
    }
    return result;
}

async function main() {
    const { existsSync, readFileSync, unlinkSync, writeFileSync } = await import('fs');
    const { TonClient, WalletContractV4 } = await import('@ton/ton');
    const { mnemonicToPrivateKey } = await import('@ton/crypto');

    const testnet = process.env.NETWORK !== 'mainnet';
    const client = new TonClient({
        endpoint: testnet ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });
    const key = await mnemonicToPrivateKey(process.env.OPERATOR_MNEMONIC!.trim().split(/\s+/));
    // use the same wallet version the operator address was created with (v4 here)
    const wallet = client.open(WalletContractV4.create({ workchain: 0, publicKey: key.publicKey }));

    type Json = { owner: string; kind: number; ton?: string };
    const fromJson = (r: Json): MintRequest => ({ owner: Address.parse(r.owner), kind: r.kind, tonInside: r.ton ? toNano(r.ton) : undefined });
    const toJson = (r: MintRequest): Json => ({ owner: r.owner.toString(), kind: r.kind, ...(r.tonInside !== undefined ? { ton: fromNano(r.tonInside) } : {}) });

    const requestsFile = process.argv[2];
    const pendingFile = process.env.PENDING_FILE ?? 'pending-batch.json';
    let todo: MintRequest[] = (JSON.parse(readFileSync(requestsFile, 'utf8')) as Json[]).map(fromJson);
    const saved = existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')) : undefined;
    const pending: PendingBatch | undefined = saved && { start: BigInt(saved.start), requests: (saved.requests as Json[]).map(fromJson) };
    const savePending = (b: PendingBatch) => writeFileSync(pendingFile, JSON.stringify({ start: b.start.toString(), requests: b.requests.map(toJson) }, null, 2));

    const res = await mintPending((c) => client.open(c), wallet.sender(key.secretKey), Address.parse(process.env.MINTER!), todo, {
        pending,
        beforeSend: (b) => {
            // persist first: if this process dies after sending, the next run finds the batch in pendingFile
            savePending(b);
            todo = todo.filter((r) => !b.requests.includes(r));
            writeFileSync(requestsFile, JSON.stringify(todo.map(toJson), null, 2));
        },
    });
    writeFileSync(requestsFile, JSON.stringify(res.deferred.map(toJson), null, 2));
    if (res.pending) savePending(res.pending);
    else if (existsSync(pendingFile)) unlinkSync(pendingFile);

    for (const m of res.minted) console.log(`minted #${m.index} kind ${m.request.kind} -> ${m.request.owner.toString()}`);
    if (res.pending) console.log(`batch from #${res.pending.start} sent but not confirmed yet: kept in ${pendingFile}, checked on the next run`);
    if (res.deferred.length) console.log(`${res.deferred.length} not sent (${res.reason ?? 'unknown kind'}): left in ${requestsFile}`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
