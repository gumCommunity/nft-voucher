import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';

/** Error text for "you are not the collection owner", pointing to manageMinter when a minter owns it. */
export async function notOwnerMessage(provider: NetworkProvider, owner: Address, me: Address): Promise<string> {
    let isMinter = false;
    try {
        await provider.provider(owner).get('get_minter_data', []);
        isMinter = true;
    } catch {
        /* a wallet or another contract */
    }
    return isMinter
        ? `The collection is owned by the minter ${owner.toString()}. Use: npx blueprint run manageMinter ${owner.toString()}`
        : `Your wallet ${me.toString()} is not the collection owner (${owner.toString()}), the transaction would fail.`;
}
