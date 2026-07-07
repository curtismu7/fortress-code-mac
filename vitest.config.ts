import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  resolve: {
    alias: {
      '@fortress-chat/shared': join(HERE, 'vendor/fortress-code/packages/shared/src/index.ts'),
      vscode: join(HERE, 'src/main/vscodeStub.ts'),
    },
  },
});
