export class WriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const clear = () => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
    const tail = result.then(clear, clear);
    this.tails.set(key, tail);

    return result;
  }

  async settle(): Promise<void> {
    await Promise.all(this.tails.values());
  }

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
