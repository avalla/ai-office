export class TransactionAlreadyActiveError extends Error {
  constructor() {
    super("A transaction is already active on this connection");
    this.name = "TransactionAlreadyActiveError";
  }
}

export interface TransactionRunner {
  run<T>(work: () => Promise<T>): Promise<T>;
}
