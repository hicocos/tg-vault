import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const source = new URL('../src/db/schema.sql', import.meta.url);
const destination = new URL('../dist/schema.sql', import.meta.url);
const migrationSource = new URL('../src/db/migrations/', import.meta.url);
const migrationDestination = new URL('../dist/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationSource)).filter(name => name.endsWith('.sql')).sort();
if (process.argv.includes('--check')) {
    const [expected, actual, distMigrationFiles] = await Promise.all([
        readFile(source),
        readFile(destination),
        readdir(migrationDestination).then(files => files.filter(name => name.endsWith('.sql')).sort()),
    ]);
    if (!expected.equals(actual)) throw new Error('dist/schema.sql is not synchronized with src/db/schema.sql');
    if (migrationFiles.join('\n') !== distMigrationFiles.join('\n')) throw new Error('dist/migrations is not synchronized with src/db/migrations');
    await Promise.all(migrationFiles.map(async name => {
        const [migration, distMigration] = await Promise.all([
            readFile(new URL(name, migrationSource)),
            readFile(new URL(name, migrationDestination)),
        ]);
        if (!migration.equals(distMigration)) throw new Error(`dist/migrations/${name} is not synchronized`);
    }));
} else {
    await copyFile(source, destination);
    await mkdir(migrationDestination, { recursive: true });
    await Promise.all(migrationFiles.map(name => copyFile(new URL(name, migrationSource), new URL(name, migrationDestination))));
    await Promise.all(['baseline.sql', 'snapshot.json'].map(name => copyFile(
        new URL(`../src/db/${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url),
    )));
}
