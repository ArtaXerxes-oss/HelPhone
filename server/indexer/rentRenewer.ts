import { rpc, TransactionBuilder, Networks, Contract } from '@stellar/stellar-sdk';

const TTL_THRESHOLD_LEDGERS = 10_000;
const EXTEND_TO_LEDGERS = 100_000;

export interface RentRenewalResult {
  key: string;
  previousTtl: number;
  renewed: boolean;
  txHash?: string;
  error?: string;
}

export class RentRenewer {
  private server: rpc.Server;

  constructor(rpcUrl: string, private networkPassphrase: string = Networks.TESTNET) {
    this.server = new rpc.Server(rpcUrl);
  }

  async checkTtl(contractId: string): Promise<number> {
    const ledgerEntries = await this.server.getLedgerEntries(
      new Contract(contractId).getFootprint(),
    );
    if (!ledgerEntries.entries.length) {
      return -1;
    }
    const entry = ledgerEntries.entries[0];
    const currentLedger = await this.server.getLatestLedger();
    return (entry.liveUntilLedgerSeq ?? 0) - currentLedger.sequence;
  }

  async renewIfNeeded(contractId: string, sourceKeypair: any): Promise<RentRenewalResult> {
    try {
      const ttl = await this.checkTtl(contractId);

      if (ttl < 0) {
        return { key: contractId, previousTtl: ttl, renewed: false, error: 'Key not found' };
      }

      if (ttl >= TTL_THRESHOLD_LEDGERS) {
        return { key: contractId, previousTtl: ttl, renewed: false };
      }

      const account = await this.server.getAccount(sourceKeypair.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '10000',
        networkPassphrase: this.networkPassphrase,
      })
        .setTimeout(30)
        .build();

      tx.sign(sourceKeypair);
      const response = await this.server.sendTransaction(tx);

      this.logRenewal(contractId, ttl, response.hash);

      return {
        key: contractId,
        previousTtl: ttl,
        renewed: true,
        txHash: response.hash,
      };
    } catch (error) {
      return {
        key: contractId,
        previousTtl: -1,
        renewed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private logRenewal(contractId: string, previousTtl: number, txHash: string): void {
    console.log(
      JSON.stringify({
        event: 'rent_renewal',
        contractId,
        previousTtl,
        txHash,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  async scanAndRenewAll(contractIds: string[], sourceKeypair: any): Promise<RentRenewalResult[]> {
    const results: RentRenewalResult[] = [];
    for (const id of contractIds) {
      results.push(await this.renewIfNeeded(id, sourceKeypair));
    }
    return results;
  }
}
