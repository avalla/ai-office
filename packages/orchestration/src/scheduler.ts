export interface RunnableTask {
  id: string;
  priority: number;
}

export interface TaskSelector {
  findRunnable(limit: number): Promise<RunnableTask[]>;
}

export interface TaskExecutor {
  execute(taskId: string): Promise<void>;
}

export class Scheduler {
  constructor(
    private readonly selector: TaskSelector,
    private readonly executor: TaskExecutor,
    private readonly capacity: number,
  ) {}

  async tick(): Promise<number> {
    const tasks = await this.selector.findRunnable(this.capacity);
    await Promise.all(tasks.map((task) => this.executor.execute(task.id)));
    return tasks.length;
  }
}
