import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getRslintPackages,
  packRslintPackages,
  verifyRslintBuild,
  verifyRslintInstall,
} from '../../rslint';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const version = '0.9.5-fresh.123.1';

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco rslint '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function buildPackages(
  packages: ReturnType<typeof getRslintPackages>,
  packageVersion = version,
) {
  const [core, native] = packages;
  const tuple = native.name.slice('@rslint/native-'.length);
  write(
    path.join(core.directory, 'package.json'),
    JSON.stringify({
      name: core.name,
      version: packageVersion,
      exports: { '.': './dist/index.js', './package.json': './package.json' },
      optionalDependencies: { [native.name]: packageVersion },
    }),
  );
  for (const file of [
    'bin/rslint.js',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/cli.js',
    'dist/config-loader.js',
    'dist/eslint-plugin/index.js',
    'dist/eslint-plugin/host.js',
    'dist/eslint-plugin/lint-worker.js',
  ]) {
    write(path.join(core.directory, file), 'module.exports = {};');
  }
  write(
    path.join(native.directory, 'package.json'),
    JSON.stringify({
      name: native.name,
      version: packageVersion,
      exports: { './package.json': './package.json' },
      publishConfig: {
        executableFiles: [
          tuple.startsWith('win32-') ? './rslint.exe' : './rslint',
        ],
      },
    }),
  );
  write(path.join(native.directory, `rslint.${tuple}.node`), 'native fixture');
  const binary = path.join(
    native.directory,
    tuple.startsWith('win32-') ? 'rslint.exe' : 'rslint',
  );
  write(binary, 'binary fixture');
  fs.chmodSync(binary, 0o755);
}

function installedPackages(dir: string) {
  const [core, native] = getRslintPackages('');
  return [core, native].map((pkg) => ({
    ...pkg,
    directory: path.join(dir, 'node_modules', pkg.name),
  })) as ReturnType<typeof getRslintPackages>;
}

test('complete host build is required, including the worker, CLI, and native parser', (t) => {
  const packages = getRslintPackages(fixture(t));
  buildPackages(packages);
  verifyRslintBuild(packages);
  const worker = path.join(
    packages[0].directory,
    'dist/eslint-plugin/lint-worker.js',
  );
  fs.writeFileSync(worker, '');
  assert.throws(() => verifyRslintBuild(packages), /missing or empty/);
  fs.unlinkSync(worker);
  assert.throws(() => verifyRslintBuild(packages), /missing or empty/);
});

test('checks direct CLI consumers and detects a mismatched native version', (t) => {
  const dir = fixture(t);
  const packages = installedPackages(dir);
  buildPackages(packages);
  write(
    path.join(dir, 'package.json'),
    JSON.stringify({ devDependencies: { '@rslint/core': version } }),
  );
  verifyRslintInstall(dir, version);
  const manifestFile = path.join(packages[1].directory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.version = '0.9.4';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(
    () => verifyRslintInstall(dir, version),
    /unexpected .* version/,
  );
});

test('a correct root core cannot hide an old core under rstack', (t) => {
  const dir = fixture(t);
  buildPackages(installedPackages(dir));
  const rstack = path.join(dir, 'node_modules/rstack');
  write(
    path.join(rstack, 'package.json'),
    JSON.stringify({ name: 'rstack', main: 'index.js' }),
  );
  write(path.join(rstack, 'index.js'), 'module.exports = {};');
  buildPackages(installedPackages(rstack), '0.9.4');
  write(
    path.join(dir, 'package.json'),
    JSON.stringify({
      devDependencies: { '@rslint/core': version, rstack: '0.8.0' },
    }),
  );
  assert.throws(
    () => verifyRslintInstall(dir, version),
    /rstack resolved an unexpected/,
  );
});

test('rejects accidental resolution from an ancestor workspace', (t) => {
  const parent = fixture(t);
  buildPackages(installedPackages(parent));
  const dir = path.join(parent, 'consumer');
  write(
    path.join(dir, 'package.json'),
    JSON.stringify({ devDependencies: { '@rslint/core': version } }),
  );
  assert.throws(
    () => verifyRslintInstall(dir, version),
    /missing from the consumer dependency tree/,
  );
});

test('accepts global virtual store links without allowing native ancestor fallback', (t) => {
  const dir = fixture(t);
  const consumer = path.join(dir, 'consumer');
  const store = path.join(dir, 'store');
  const packages = getRslintPackages('').map((pkg, index) => ({
    ...pkg,
    directory: path.join(store, String(index), 'node_modules', pkg.name),
  })) as ReturnType<typeof getRslintPackages>;
  buildPackages(packages);
  const rstack = path.join(store, 'rstack/node_modules/rstack');
  write(
    path.join(rstack, 'package.json'),
    JSON.stringify({ name: 'rstack', main: 'index.js' }),
  );
  write(path.join(rstack, 'index.js'), 'module.exports = {};');
  write(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      devDependencies: { '@rslint/core': version, rstack: '0.8.0' },
    }),
  );
  const link = (target: string, destination: string) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(target, destination, 'dir');
  };
  link(rstack, path.join(consumer, 'node_modules/rstack'));
  link(packages[0].directory, path.join(consumer, 'node_modules/@rslint/core'));
  link(
    packages[0].directory,
    path.join(store, 'rstack/node_modules/@rslint/core'),
  );
  const nativeLink = path.join(store, '0/node_modules', packages[1].name);
  link(packages[1].directory, nativeLink);
  verifyRslintInstall(consumer, version);
  fs.unlinkSync(nativeLink);
  link(
    packages[1].directory,
    path.join(store, 'node_modules', packages[1].name),
  );
  assert.throws(
    () => verifyRslintInstall(consumer, version),
    /missing from the consumer dependency tree/,
  );
});

test('same-version source reruns install the new native bytes with real pnpm', async (t) => {
  const dir = fixture(t);
  const packages = getRslintPackages(dir);
  buildPackages(packages, '0.9.5');
  const packageManager = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ).packageManager;
  write(
    path.join(dir, 'package.json'),
    JSON.stringify({ private: true, packageManager }),
  );
  write(
    path.join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n  - npm/rslint/*\n',
  );
  const coreFile = path.join(packages[0].directory, 'package.json');
  const core = JSON.parse(fs.readFileSync(coreFile, 'utf8'));
  core.optionalDependencies[packages[1].name] = 'workspace:*';
  fs.writeFileSync(coreFile, JSON.stringify(core));
  const sourceInstall = spawnSync(
    'pnpm',
    ['install', '--ignore-scripts', '--no-frozen-lockfile'],
    { cwd: dir, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(
    sourceInstall.status,
    0,
    sourceInstall.stdout + sourceInstall.stderr,
  );
  const consumer = path.join(dir, 'consumer');
  const binary = process.platform === 'win32' ? 'rslint.exe' : 'rslint';
  let previousNative: string | undefined;
  for (const marker of ['first-build', 'next-build']) {
    fs.writeFileSync(path.join(packages[1].directory, binary), marker);
    const overrides = await packRslintPackages(dir, path.join(dir, 'tarballs'));
    assert.notEqual(overrides[packages[1].name], previousNative);
    previousNative = overrides[packages[1].name];
    write(
      path.join(consumer, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager,
        devDependencies: { '@rslint/core': overrides[packages[0].name] },
      }),
    );
    write(
      path.join(consumer, 'pnpm-workspace.yaml'),
      JSON.stringify({
        packages: ['.'],
        overrides,
      }),
    );
    const install = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
      cwd: consumer,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    verifyRslintInstall(consumer, '0.9.5');
    // Resolve in a fresh process, as each CLI run does, avoiding Node's own
    // module-resolution cache while checking pnpm's installed dependency tree.
    const inspect = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(path.resolve('package.json'));
const core = require.resolve('@rslint/core/package.json');
const native = createRequire(core).resolve(process.argv[1] + '/package.json');
console.log(JSON.stringify({
  corePath: core,
  nativePath: native,
  core: JSON.parse(fs.readFileSync(core, 'utf8')).version,
  native: JSON.parse(fs.readFileSync(native, 'utf8')).version,
  digest: createHash('sha256').update(fs.readFileSync(path.join(path.dirname(native), process.argv[2]))).digest('hex'),
}));`,
        packages[1].name,
        binary,
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(
      inspect.status,
      0,
      JSON.stringify({
        error: inspect.error?.message,
        signal: inspect.signal,
        stderr: inspect.stderr,
      }),
    );
    const { corePath, nativePath, ...installed } = JSON.parse(inspect.stdout);
    assert.deepEqual(
      installed,
      {
        core: '0.9.5',
        native: '0.9.5',
        digest: createHash('sha256').update(marker).digest('hex'),
      },
      JSON.stringify({ corePath, nativePath, install: install.stdout }),
    );
  }
});
