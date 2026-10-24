import { expect, it } from 'vitest';
import { parseStorageDescriptor, parseStorageCatalog } from '../services/storageCatalog';
import { describeStorageDescriptor } from '../server/cloud/storageRegistry';
import { descriptor } from './helpers/storageRegistryFixtures';

it('retains folder display metadata through the server whitelist and browser parser', () => {
  const input = { ...descriptor('main'), rootPath: 'disk:/Заметки 🗂', accessToken: 'never-public' };
  const output = describeStorageDescriptor(input);
  expect(output).toMatchObject({ rootPath: 'disk:/Заметки 🗂' });
  expect(JSON.stringify(output)).not.toContain('never-public');
  expect(parseStorageDescriptor(output)).toMatchObject({ rootPath: 'disk:/Заметки 🗂' });
});

it('retains folder metadata for an unavailable cloud without treating it as verified', () => {
  const input = {
    id: 'main',
    label: 'Cloud',
    provider: 'yandex',
    status: 'unavailable',
    rootPath: 'disk:/Notes'
  };
  expect(parseStorageCatalog({ activeStorageId: 'main', storages: [input] })?.storages[0]).toEqual(
    input
  );
});

it.each([null, 12, '', 'bad\npath', '\uD800'])(
  'rejects malformed optional folder metadata %j',
  rootPath => {
    expect(parseStorageDescriptor({ ...descriptor('main'), rootPath })).toBeNull();
    expect(
      parseStorageCatalog({
        activeStorageId: 'main',
        storages: [
          { id: 'main', label: 'Main', provider: 'yandex', status: 'unavailable', rootPath }
        ]
      })
    ).toBeNull();
  }
);

it('continues to read historical descriptors with an unknown folder', () => {
  expect(parseStorageDescriptor(descriptor('old'))).toEqual(descriptor('old'));
});
