import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, 'vendor/fortress-code');

const shared = {
  bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: true,
  alias: {
    '@fortress-chat/shared': join(VENDOR, 'packages/shared/src/index.ts'),
    vscode: join(HERE, 'src/main/vscodeStub.ts'),
  },
};

await build({ ...shared, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', external: ['electron'] });
await build({ ...shared, entryPoints: [join(VENDOR, 'packages/manager/src/index.ts')], outfile: 'dist/manager/index.js' });
