import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execa } from 'execa';

interface PackageInfo {
  name: string;
  directory: string;
}

export function getRslintPackages(
  stackPath: string,
): [PackageInfo, PackageInfo] {
  const { platform, arch } = process;
  assert(
    ['darwin', 'linux', 'win32'].includes(platform) &&
      ['arm64', 'x64'].includes(arch),
    `unsupported rslint platform: ${platform}-${arch}`,
  );
  let suffix = '';
  if (platform === 'linux') {
    const report = process.report.getReport() as {
      header: { glibcVersionRuntime?: string };
    };
    suffix = report.header.glibcVersionRuntime ? '-gnu' : '-musl';
  } else if (platform === 'win32') {
    suffix = '-msvc';
  }
  const tuple = `${platform}-${arch}${suffix}`;
  return [
    {
      name: '@rslint/core',
      directory: path.join(stackPath, 'packages/rslint'),
    },
    {
      name: `@rslint/native-${tuple}`,
      directory: path.join(stackPath, 'npm/rslint', tuple),
    },
  ];
}

export function verifyRslintBuild([core, native]: [PackageInfo, PackageInfo]) {
  const tuple = native.name.slice('@rslint/native-'.length);
  const binary = tuple.startsWith('win32-') ? 'rslint.exe' : 'rslint';
  const outputs = [
    ...[
      'bin/rslint.js',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/cli.js',
      'dist/config-loader.js',
      'dist/eslint-plugin/index.js',
      'dist/eslint-plugin/host.js',
      'dist/eslint-plugin/lint-worker.js',
    ].map((file) => path.join(core.directory, file)),
    path.join(native.directory, `rslint.${tuple}.node`),
    path.join(native.directory, binary),
  ];
  for (const file of outputs) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    assert(
      stat?.isFile() && stat.size > 0,
      `missing or empty rslint build output: ${file}`,
    );
  }
  if (!tuple.startsWith('win32-')) {
    fs.accessSync(path.join(native.directory, binary), fs.constants.X_OK);
  }
}

export async function packRslintPackages(
  stackPath: string,
  outputDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const packages = getRslintPackages(stackPath);
  verifyRslintBuild(packages);
  fs.mkdirSync(outputDir, { recursive: true });
  // Keep symlink aliases (e.g. macOS /var) out of pnpm's relative file IDs.
  const realOutputDir = fs.realpathSync(outputDir);
  const overrides: Record<string, string> = {};
  for (const pkg of packages) {
    const name = pkg.name.replace('@', '').replace('/', '-');
    const temporaryTarball = path.join(realOutputDir, `${name}.tgz`);
    // pnpm resolves workspace/catalog specs while packing, as it does on publish.
    await execa('pnpm', ['pack', '--out', temporaryTarball], {
      cwd: pkg.directory,
      env,
      stdio: 'inherit',
    });
    // A reused file: path can retain old same-version binaries in pnpm's cache.
    // Bind the dependency URL to the actual bytes, including during bisect.
    const digest = createHash('sha256')
      .update(fs.readFileSync(temporaryTarball))
      .digest('hex');
    const tarball = path.join(realOutputDir, `${name}-${digest}.tgz`);
    fs.renameSync(temporaryTarball, tarball);
    overrides[pkg.name] = `file:${tarball}`;
  }
  return overrides;
}

function resolveInstalledPackage(
  callerManifest: string,
  name: string,
  consumer: string,
): PackageInfo {
  const realCaller = fs.realpathSync(callerManifest);
  const callerDir = path.dirname(realCaller);
  const relative = path.relative(consumer, callerDir);
  let boundary = path.join(consumer, 'node_modules');
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    // pnpm's global virtual store lives outside the checkout. Each package
    // owns dependency links in its nearest enclosing node_modules directory.
    boundary = callerDir;
    while (path.basename(boundary) !== 'node_modules') {
      const parent = path.dirname(boundary);
      assert(parent !== boundary, `missing dependency links for ${realCaller}`);
      boundary = parent;
    }
  }
  const lookups = createRequire(realCaller).resolve.paths(name) ?? [];
  const end = lookups.indexOf(boundary);
  assert(end >= 0, `missing dependency lookup boundary for ${realCaller}`);
  // Follow Node's lookup directories through the current links. require.resolve
  // caches old targets across installs in a long-running bisect process.
  for (const lookup of lookups.slice(0, end + 1)) {
    const directory = path.join(lookup, name);
    if (fs.existsSync(path.join(directory, 'package.json'))) {
      return { name, directory: fs.realpathSync(directory) };
    }
  }
  throw new Error(
    `${name} is missing from the consumer dependency tree; ancestor fallback is disabled`,
  );
}

// Check resolution from the actual caller. A root-level core package alone
// cannot prove that `rs lint` uses it through rstack's dependency tree.
export function verifyRslintInstall(dir: string, expectedVersion: string) {
  const consumer = fs.realpathSync(dir);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(consumer, 'package.json'), 'utf8'),
  );
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  const callers = [
    ...(dependencies['@rslint/core'] ? ['@rslint/core'] : []),
    ...(dependencies.rstack ? ['rstack'] : []),
  ];
  assert(
    callers.length,
    `${dir} does not consume rslint directly or through rstack`,
  );
  const [, hostNative] = getRslintPackages('');
  for (const caller of callers) {
    const callerManifest =
      caller === 'rstack'
        ? path.join(consumer, 'node_modules/rstack/package.json')
        : path.join(consumer, 'package.json');
    const core = resolveInstalledPackage(
      callerManifest,
      '@rslint/core',
      consumer,
    );
    const native = resolveInstalledPackage(
      path.join(core.directory, 'package.json'),
      hostNative.name,
      consumer,
    );
    const packages: [PackageInfo, PackageInfo] = [core, native];
    for (const pkg of packages) {
      const installed = JSON.parse(
        fs.readFileSync(path.join(pkg.directory, 'package.json'), 'utf8'),
      );
      assert.equal(installed.name, pkg.name);
      assert.equal(
        installed.version,
        expectedVersion,
        `${caller} resolved an unexpected ${pkg.name} version`,
      );
    }
    verifyRslintBuild(packages);
    console.log(
      `Verified ${caller} uses @rslint/core and ${hostNative.name}@${expectedVersion}`,
    );
  }
}
