'use strict';

const { parseFrontmatter } = require('../skills');

describe('parseFrontmatter (A3)', () => {
  test('key: value simple', () => {
    const { meta } = parseFrontmatter('---\nname: foo\ndescription: bar\n---\nbody');
    expect(meta.name).toBe('foo');
    expect(meta.description).toBe('bar');
  });

  test('array inline [a, b, c]', () => {
    const { meta } = parseFrontmatter('---\nallowedTools: [bash, read_file, write_file]\n---\n');
    expect(meta.allowedTools).toEqual(['bash', 'read_file', 'write_file']);
  });

  test('array en formato lista con guiones', () => {
    const input = [
      '---',
      'allowedTools:',
      '  - bash',
      '  - files_*',
      '---',
      'body',
    ].join('\n');
    const { meta, body } = parseFrontmatter(input);
    expect(meta.allowedTools).toEqual(['bash', 'files_*']);
    expect(body).toBe('body');
  });

  test('alias kebab-case allowed-tools también funciona', () => {
    const { meta } = parseFrontmatter('---\nallowed-tools: [bash]\n---\n');
    expect(meta['allowed-tools']).toEqual(['bash']);
  });

  test('string value único en ARRAY_KEY se normaliza a array', () => {
    const { meta } = parseFrontmatter('---\nallowedTools: bash\n---\n');
    expect(meta.allowedTools).toEqual(['bash']);
  });

  test('comillas alrededor de strings se remueven', () => {
    const { meta } = parseFrontmatter('---\nname: "Hola Mundo"\ndescription: \'algo\'\n---\n');
    expect(meta.name).toBe('Hola Mundo');
    expect(meta.description).toBe('algo');
  });

  test('whenToUse multilínea con pipe (|)', () => {
    const input = [
      '---',
      'whenToUse: |',
      '  cuando el usuario',
      '  pide algo',
      '---',
    ].join('\n');
    const { meta } = parseFrontmatter(input);
    expect(meta.whenToUse).toBe('cuando el usuario\npide algo');
  });

  test('body sigue separado del frontmatter', () => {
    const input = [
      '---',
      'name: foo',
      '---',
      '',
      'Este es el body del skill.',
    ].join('\n');
    const { body } = parseFrontmatter(input);
    expect(body).toBe('Este es el body del skill.');
  });

  test('sin frontmatter devuelve body completo', () => {
    const input = 'No tiene frontmatter.';
    const { body, meta } = parseFrontmatter(input);
    expect(body).toBe('No tiene frontmatter.');
    expect(meta).toEqual({});
  });
});
