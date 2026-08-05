export interface TransactionRunner {
  run<T>(work: () => Promise<T>): Promise<T>;
}
