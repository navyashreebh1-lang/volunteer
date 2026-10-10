import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

// One in-memory replica set for the whole run (transactions need a replica
// set); each test file uses its own database on it.
export default async function setup(project: TestProject) {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  project.provide('mongoBaseUri', replSet.getUri());
  return async () => {
    await replSet.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoBaseUri: string;
  }
}
