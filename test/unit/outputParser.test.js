'use strict';

const assert = require('assert');

const { parseAction, parseToolCalls, extractJsonObject } = require('../../app/core/outputParser');

describe('outputParser.extractJsonObject', () => {
  it('finds an object in surrounding prose', () => {
    assert.strictEqual(extractJsonObject('Sure! {"a":1} hope that helps'), '{"a":1}');
  });

  it('handles nested braces, which a regex cannot', () => {
    const json = '{"code":"function f() { return {a:1}; }"}';
    assert.strictEqual(extractJsonObject(`noise ${json} noise`), json);
  });

  it('ignores braces inside strings', () => {
    const json = '{"code":"if (x) { y(); }","action":"write_file"}';
    assert.strictEqual(extractJsonObject(json), json);
  });

  it('handles escaped quotes inside strings', () => {
    const json = '{"code":"say \\"hi\\" { }","action":"write_file"}';
    assert.strictEqual(extractJsonObject(json), json);
  });

  it('returns null when there is no object', () => {
    assert.strictEqual(extractJsonObject('no json here'), null);
    assert.strictEqual(extractJsonObject('{"unclosed": 1'), null);
  });
});

describe('outputParser.parseAction', () => {
  it('parses a clean action', () => {
    const result = parseAction('{"thought":"looking","action":"read_file","path":"src/app.js"}');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action.action, 'read_file');
    assert.strictEqual(result.action.path, 'src/app.js');
    assert.strictEqual(result.action.thought, 'looking');
  });

  it('recovers from a markdown fence', () => {
    const result = parseAction('```json\n{"action":"list_files"}\n```');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action.action, 'list_files');
  });

  it('recovers from a conversational preamble', () => {
    const result = parseAction('Sure! Here is my action:\n{"action":"list_files"}\nLet me know!');
    assert.strictEqual(result.ok, true);
  });

  it('ignores null placeholder fields', () => {
    const result = parseAction('{"action":"list_files","path":null,"query":null,"code":null}');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action.path, undefined);
  });

  it('preserves whitespace in code, which is file content', () => {
    const result = parseAction('{"action":"write_file","path":"a.js","code":"  indented\\n\\n  lines"}');
    assert.strictEqual(result.action.code, '  indented\n\n  lines');
  });

  it('normalizes action case', () => {
    assert.strictEqual(parseAction('{"action":"READ_FILE","path":"a.js"}').action.action, 'read_file');
  });

  describe('failures resolve to done, never to a guessed action', () => {
    it('handles malformed JSON', () => {
      const result = parseAction('{"action":"read_file", path: unquoted}');
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.action.action, 'done');
      assert.match(result.error, /malformed JSON/i);
    });

    it('handles a response with no JSON at all', () => {
      const result = parseAction('I think we should probably edit the signup file.');
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.action.action, 'done');
      // The user still sees what the model said.
      assert.match(result.action.summary, /signup file/);
    });

    it('handles an empty response', () => {
      const result = parseAction('');
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /empty/i);
    });

    it('refuses an unknown action rather than guessing a near match', () => {
      const result = parseAction('{"action":"remove_file","path":"a.js"}');
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /unknown action/i);
    });

    it('refuses a write_file with no path instead of defaulting one', () => {
      // Defaulting here would write to a guessed location on the user's disk.
      const result = parseAction('{"action":"write_file","code":"hello"}');
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /missing: path/);
    });

    it('refuses a write_file with no code', () => {
      const result = parseAction('{"action":"write_file","path":"a.js"}');
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /missing: code/);
    });

    it('refuses a JSON array', () => {
      assert.strictEqual(parseAction('[{"action":"read_file"}]').ok, false);
    });
  });

  describe('mode restriction', () => {
    it('refuses an action not offered in this mode', () => {
      const result = parseAction('{"action":"write_file","path":"a.js","code":"x"}', {
        allowedActions: ['read_file', 'list_files', 'search_workspace'],
      });
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /not available in this mode/);
    });

    it('always permits done, so a session can end', () => {
      const result = parseAction('{"action":"done","summary":"here is the plan"}', {
        allowedActions: ['read_file'],
      });
      assert.strictEqual(result.ok, true);
    });
  });

  describe('prototype pollution', () => {
    it('drops __proto__ from model output', () => {
      const result = parseAction('{"action":"list_files","__proto__":{"polluted":true}}');
      assert.strictEqual(result.ok, true);
      assert.strictEqual({}.polluted, undefined, 'Object.prototype was polluted');
    });

    it('drops a constructor key', () => {
      const result = parseAction('{"action":"list_files","constructor":{"x":1}}');
      assert.strictEqual(result.ok, true);
    });
  });
});

describe('outputParser.parseToolCalls', () => {
  it('parses native tool calls', () => {
    const calls = parseToolCalls({
      tool_calls: [{ function: { name: 'read_file', arguments: { path: 'src/a.js' } } }],
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'read_file');
    assert.strictEqual(calls[0].args.path, 'src/a.js');
  });

  it('parses arguments delivered as a JSON string', () => {
    const calls = parseToolCalls({
      tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"src/a.js"}' } }],
    });
    assert.strictEqual(calls[0].args.path, 'src/a.js');
  });

  it('skips a call with unparseable arguments rather than inventing them', () => {
    const calls = parseToolCalls({
      tool_calls: [{ function: { name: 'read_file', arguments: '{not json' } }],
    });
    assert.deepStrictEqual(calls, []);
  });

  it('returns an empty array when the model called nothing', () => {
    assert.deepStrictEqual(parseToolCalls({ content: 'All done!' }), []);
    assert.deepStrictEqual(parseToolCalls(null), []);
  });

  it('applies the prototype guard to tool arguments too', () => {
    const calls = parseToolCalls({
      tool_calls: [{ function: { name: 'read_file', arguments: { __proto__: { bad: 1 }, path: 'a.js' } } }],
    });
    assert.strictEqual(calls[0].args.path, 'a.js');
    assert.strictEqual({}.bad, undefined);
  });
});

describe('path plausibility', () => {
  const { parseAction, isPlausiblePath } = require('../../app/core/outputParser');

  it('accepts ordinary paths', () => {
    for (const good of ['src/app.js', 'a.js', './src/deep/nested/file.ts', 'my folder/notes.md']) {
      assert.strictEqual(isPlausiblePath(good), true, good);
    }
  });

  it('rejects a sentence written into the path field', () => {
    // Verbatim from a live llama3.2:1b session.
    const prose =
      'src/greet.js -> README.md (for comparison and understanding of changes needed in this ' +
      'file was not possible due to empty name being returned by read_file function, so I will ' +
      'use src/obsolete.js instead for a better comparison later on.)';
    assert.strictEqual(isPlausiblePath(prose), false);
  });

  it('refuses the action without quoting the bogus path back', () => {
    const prose = 'src/a.js -> src/b.js then compare them because the first one was empty';
    const result = parseAction(JSON.stringify({ action: 'read_file', path: prose, thought: 'x' }));

    assert.strictEqual(result.ok, false);
    // The whole point: this text must not flow onward into an observation, where the
    // model reads it back and copies it into a file.
    assert.ok(!result.error.includes('compare them'), 'the error echoed the model garbage back');
    assert.match(result.error, /just the path relative to the project root/);
  });

  it('rejects a path containing a newline', () => {
    assert.strictEqual(isPlausiblePath('src/app.js\nsrc/other.js'), false);
  });
});

describe('actionSchema', () => {
  const { actionSchema } = require('../../app/core/outputParser');

  it('requires code only on the write_file branch', () => {
    const schema = actionSchema(new Set(['read_file', 'write_file', 'done']));
    const branch = (name) => schema.anyOf.find((b) => b.properties.action.const === name);

    assert.deepStrictEqual(branch('write_file').required, ['thought', 'action', 'path', 'code']);
    assert.deepStrictEqual(branch('read_file').required, ['thought', 'action', 'path']);
  });

  it('omits actions the mode does not offer, but always keeps done', () => {
    const schema = actionSchema(new Set(['read_file']));
    const names = schema.anyOf.map((b) => b.properties.action.const);

    assert.ok(!names.includes('write_file'), 'plan mode was offered a write');
    assert.ok(names.includes('done'), 'no way to end the session');
  });

  it('offers recursive on delete_folder without requiring it', () => {
    // Constrained decoding will not emit a property the schema does not mention, so a
    // missing declaration here would leave Tier B permanently unable to remove a
    // non-empty folder — the flag is the only way past the tool's refusal.
    const schema = actionSchema(new Set(['delete_folder', 'done']));
    const branch = schema.anyOf.find((b) => b.properties.action.const === 'delete_folder');

    assert.strictEqual(branch.properties.recursive.type, 'boolean');
    assert.deepStrictEqual(branch.required, ['thought', 'action', 'path']);
  });
});

describe('folder actions', () => {
  const { parseAction } = require('../../app/core/outputParser');

  it('parses create_folder', () => {
    const result = parseAction(JSON.stringify({ thought: 'make it', action: 'create_folder', path: 'src/main/java' }));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action.action, 'create_folder');
    assert.strictEqual(result.action.path, 'src/main/java');
  });

  it('carries recursive through when it is a real boolean', () => {
    const result = parseAction(JSON.stringify({ action: 'delete_folder', path: 'old', recursive: true }));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action.recursive, true);
  });

  it('accepts the string "true", which small models emit for booleans', () => {
    const result = parseAction(JSON.stringify({ action: 'delete_folder', path: 'old', recursive: 'true' }));

    assert.strictEqual(result.action.recursive, true);
  });

  it('does not read the string "false" as consent', () => {
    // The value is truthy in JavaScript, and it authorises removing a subtree. Anything
    // short of an unambiguous yes leaves the flag unset, and the tool then refuses.
    const result = parseAction(JSON.stringify({ action: 'delete_folder', path: 'old', recursive: 'false' }));

    assert.strictEqual(result.action.recursive, undefined);
  });

  it('leaves recursive unset when it is absent', () => {
    const result = parseAction(JSON.stringify({ action: 'delete_folder', path: 'old' }));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action.recursive, undefined);
  });

  it('refuses a folder action in a mode that was not offered it', () => {
    const result = parseAction(JSON.stringify({ action: 'delete_folder', path: 'old' }), {
      allowedActions: new Set(['read_file', 'list_files']),
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /not available in this mode/);
  });
});
