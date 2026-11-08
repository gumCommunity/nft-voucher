// Example: a backend mints vouchers with the OPERATOR key through the minter (no Blueprint).
//
// Collect requests (e.g. for one minute), then call mintPending(): it sends them as batches of up to 100 vouchers
// in one transaction each (~0.0025 TON per voucher in fees vs ~0.008 TON when minting one by one), respects the
// daily limit and returns the requests that did not fit, so you can retry them on the next run.
//
//   OPERATOR_MNEMONIC="word1 ... word24" MINTER=EQ... NETWORK=testnet \
//   npx ts-node examples/serverMint.ts requests.json
//   requests.json: [{ "owner": "UQ...", "kind": 0, "ton": "0.1" }, ...]   kind: 0 = 10 000, 1 = 5 000, 2 = 1 000 GUM
//
// Keep the mnemonic only on the server (env / secret manager). If it leaks, the admin replaces the operator
// with manageMinter; until then at most `limit` vouchers per 24h can be minted.
//
// Run ONE mintPending at a time: item indexes come from the collection, and two concurrent mints with the
// same index produce only one voucher.
import { Address, Contract, OpenedContract, Sender, toNano } from '@ton/core';
import { NftVoucherMinter, MAX_BATCH, requiredMintValue } from '../wrappers/NftVoucherMinter';
import { NftVoucherCollection, MintParams } from '../wrappers/NftVoucherCollection';

export const KINDS = ['0.json', '1.json', '2.json']; // 10 000 / 5 000 / 1 000 GUM
const STORAGE_RESERVE = toNano('0.05'); // added to every voucher by the collection wrapper

export type MintRequest = { owner: Address; kind: number; tonInside?: bigint };
export type MintResult = { minted: { request: MintRequest; index: bigint }[]; deferred: MintRequest[]; reason?: string };

type Open = <T extends Contract>(c: T) => OpenedContract<T>;

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mintPending(
    open: Open,
    sender: Sender,
    minterAddress: Address,
    requests: MintRequest[],
    opts: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): Promise<MintResult> {
    const sleep = opts.sleep ?? defaultSleep;
    const minter = open(NftVoucherMinter.createFromAddress(minterAddress));
    const result: MintResult = { minted: [], deferred: [] };
    let queue = requests.filter((r) => KINDS[r.kind] !== undefined);
    result.deferred.push(...requests.filter((r) => KINDS[r.kind] === undefined)); // unknown kind: never mintable

    while (queue.length > 0) {
        const m = await minter.getMinterData();
        if (m.paused) return { ...result, deferred: [...result.deferred, ...queue], reason: 'minter paused' };
        if (m.remainingToday < 1) return { ...result, deferred: [...result.deferred, ...queue], reason: 'daily limit reached' };

        const collection = open(NftVoucherCollection.createFromAddress(m.collection));
        const start = (await collection.getCollectionData()).nextItemIndex;
        const chunk = queue.slice(0, Math.min(MAX_BATCH, m.remainingToday));
        const items: MintParams[] = chunk.map((r, i) => ({
            itemIndex: start + BigInt(i),
            itemOwner: r.owner,
            itemContent: KINDS[r.kind],
            voucherValue: r.tonInside ?? toNano('0.1'),
        }));
        const total = items.reduce((a, i) => a + i.voucherValue + STORAGE_RESERVE, 0n);
        // what the minter requires + a small margin; the unused part is refunded to the operator
        const value = requiredMintValue(total, items.length, m.feePerItem, m.feePerCall) + toNano('0.02');

        await minter.sendBatchMint(sender, items, { value });

        // wait until the collection has deployed the whole batch
        const target = start + BigInt(items.length);
        const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
        for (;;) {
            if ((await collection.getCollectionData()).nextItemIndex >= target) break;
            if (Date.now() > deadline) {
                return { ...result, deferred: [...result.deferred, ...queue], reason: 'batch not confirmed in time (check the minter transactions)' };
            }
            await sleep(3000);
        }
        chunk.forEach((request, i) => result.minted.push({ request, index: start + BigInt(i) }));
        queue = queue.slice(chunk.length);
    }
    return result;
}

async function main() {
    const { readFileSync } = await import('fs');
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

    const raw: { owner: string; kind: number; ton?: string }[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const requests = raw.map((r) => ({ owner: Address.parse(r.owner), kind: r.kind, tonInside: r.ton ? toNano(r.ton) : undefined }));

    const res = await mintPending((c) => client.open(c), wallet.sender(key.secretKey), Address.parse(process.env.MINTER!), requests);
    for (const m of res.minted) console.log(`minted #${m.index} kind ${m.request.kind} -> ${m.request.owner.toString()}`);
    if (res.deferred.length) console.log(`${res.deferred.length} deferred: ${res.reason ?? 'unknown kind'}`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
