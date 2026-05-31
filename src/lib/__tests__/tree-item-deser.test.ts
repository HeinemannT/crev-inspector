import { describe, it, expect } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { registerBmpTypes, parseTreeNodeInfo } from '../bmp-types';
import { deserializeStream } from '../java-serial';

describe('TreeItemCommand response deserialization', () => {
  it('deserializes actual protivitigermany2 response correctly', () => {
    mockChromeStorage();
    registerBmpTypes();

    // Actual base64 response from protivitigermany2 v5.5.8.7 — Incident object
    const b64 = 'rO0ABXNyABNqYXZhLnV0aWwuQXJyYXlMaXN0eIHSHZnHYZ0DAAFJAARzaXpleHAAAAABdwQAAAABc3IAOWNvbS5jb3Jwb3JhdGVyLmJtcC5kdG8ucmVzcG9uc2UuSW50ZWdyYXRpb25PYmplY3RSZXNwb25zZReRoaaE7SK9AgABTAAIcmVzcG9uc2V0ABJMamF2YS9sYW5nL09iamVjdDt4cHNyAC1jb20uY29ycG9yYXRlci5ibXAuZHRvLlRyZWVOb2RlSW5mb3JtYXRpb25EdG8AAAAAAAAAAAIACloABmlzTGlua1oAEmlzVGVtcGxhdGVMaW5rZWRUb0wACWVycm9yVGV4dHQAEkxqYXZhL2xhbmcvU3RyaW5nO0wAD2ljb25JbmZvcm1hdGlvbnQAK0xjb20vY29ycG9yYXRlci9ibXAvZHRvL0ljb25JbmZvcm1hdGlvbkR0bztMAAJpZHEAfgAGTAAFbW9kZWx0AC1MY29tL2NvcnBvcmF0ZXIvYmFzZS9nZW5lcmF0aW9uL3N5c3RlbS9Nb2RlbDtMAANyaWR0ACtMY29tL2NvcnBvcmF0ZXIvYmFzZS9nZW5lcmF0aW9uL3N5c3RlbS9SaWQ7TAAEdGV4dHEAfgAGTAAHdG9vbFRpcHEAfgAGTAAEdHlwZXQAL0xjb20vY29ycG9yYXRlci9iYXNlL2dlbmVyYXRpb24vc3lzdGVtL1R5cGVLZXk7eHAAAHBzcgApY29tLmNvcnBvcmF0ZXIuYm1wLmR0by5JY29uSW5mb3JtYXRpb25EdG8AAAAAAAAAAAIAA0wACGljb25OYW1lcQB+AAZMAAhvdmVybGF5c3QAD0xqYXZhL3V0aWwvU2V0O0wABXBhaW50dAAhTGNvbS9jb3Jwb3JhdGVyL2JtcC9kdG8vUGFpbnREdG87eHB0AAxpbmNpZGVudC5wbmdzcgARamF2YS51dGlsLkhhc2hTZXS6RIWVlri3NAMAAHhwdwwAAAAQP0AAAAAAAAB4cHQAAzcxNn5yACtjb20uY29ycG9yYXRlci5iYXNlLmdlbmVyYXRpb24uc3lzdGVtLk1vZGVsAAAAAAAAAAASAAB4cgAOamF2YS5sYW5nLkVudW0AAAAAAAAAABIAAHhwdAAMT1JHQU5JU0FUSU9Oc3IAKWNvbS5jb3Jwb3JhdGVyLmJhc2UuZ2VuZXJhdGlvbi5zeXN0ZW0uUmlkAAAAAAAAAVQCAAFKAAppZGVudGlmaWVyeHBcXQVHe0Ok33QACEluY2lkZW50dAAMNzE2IEluY2lkZW50c3IALWNvbS5jb3Jwb3JhdGVyLmJhc2UuZ2VuZXJhdGlvbi5zeXN0ZW0uVHlwZUtleQAAAAAAAAAAAgABTAAGdHlwZUlkcQB+AAZ4cHQACEluY2lkZW50eA==';

    const buffer = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
    const objects = deserializeStream(buffer);

    // Dump full structure for debugging
    console.log('Objects count:', objects.length);
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      console.log(`\nObject ${i}:`);
      console.log('  $class:', obj?.['$class']);
      if (obj?.['$class'] === 'java.util.ArrayList') {
        const els = obj['$elements'] ?? [];
        console.log('  $elements:', els.length);
        for (let j = 0; j < els.length; j++) {
          const el = els[j];
          console.log(`  [${j}].$class:`, el?.['$class']);
          console.log(`  [${j}] keys:`, Object.keys(el ?? {}));
          if (el?.response) {
            console.log(`  [${j}].response.$class:`, el.response['$class']);
            console.log(`  [${j}].response.id:`, el.response.id);
            console.log(`  [${j}].response.text:`, el.response.text);
            console.log(`  [${j}].response.rid:`, el.response.rid);
            console.log(`  [${j}].response.type:`, el.response.type);
          }
        }
      }
    }

    // Actual assertions
    expect(objects.length).toBe(1);
    const arrayList = objects[0];
    expect(arrayList['$class']).toBe('java.util.ArrayList');

    const response = arrayList['$elements']?.[0];
    expect(response).toBeDefined();

    const dto = response?.response;
    expect(dto).toBeDefined();
    expect(dto['$class']).toContain('TreeNodeInformationDto');

    // Dump ALL fields of the DTO
    console.log('\nFull DTO fields:');
    for (const [k, v] of Object.entries(dto)) {
      const display = typeof v === 'object' && v !== null ? JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() + 'n' : x) : v;
      console.log(`  ${k}: ${display}`);
    }

    // Now test parseTreeNodeInfo
    const parsed = parseTreeNodeInfo(dto);
    console.log('\nParsed result:', parsed);
  });
});
