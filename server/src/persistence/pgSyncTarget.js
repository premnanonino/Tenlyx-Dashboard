/**
 * The sync worker's "store" in production: the same interface BillingSync
 * uses for the in-memory BillingStore, backed by PostgreSQL.
 */
export class PgSyncTarget {
  constructor({ repo }) {
    this.repo = repo;
  }

  /** Insert-or-ignore; resolves to the records that were new. */
  ingest(batch) {
    return this.repo.insertRecords(batch);
  }

  async setBalance(b) {
    await this.repo.insertBalance(b);
  }

  async setGroups(groups) {
    await this.repo.setKv('billing_groups', groups);
  }

  async setAssistants(list) {
    await this.repo.setKv('assistants', list);
  }
}

/** Checkpoint persistence for BillingSync (one small JSON document). */
export function pgCheckpoints(repo) {
  return {
    load: () => repo.getKv('sync_checkpoint'),
    save: (state) => repo.setKv('sync_checkpoint', state),
  };
}
