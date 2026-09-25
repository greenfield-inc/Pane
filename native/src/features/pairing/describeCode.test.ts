import { describe, expect, it } from 'vitest';

import { describeConnectionCode } from './describeCode';

// A code in the format `runpane install daemon` prints, with a short token.
const CODE = 'pane-remote://eyJ2IjoxLCJsYWJlbCI6Ik9mZmljZSBNYWMiLCJiYXNlVXJsIjoiaHR0cHM6Ly9vZmZpY2UudGFpbDEyMzQudHMubmV0IiwidG9rZW4iOiJ0b2tlbi0xMjM0NTY3OCIsInRyYW5zcG9ydCI6Imh0dHArc3NlIn0';

describe('describeConnectionCode', () => {
  it('names the host a code connects to, without the token', () => {
    const description = describeConnectionCode(CODE);
    expect(description).toEqual({ label: 'Office Mac', baseUrl: 'https://office.tail1234.ts.net' });
    expect(JSON.stringify(description)).not.toContain('token-1234');
  });

  it('describes nothing for partial or invalid input', () => {
    expect(describeConnectionCode('')).toBeNull();
    expect(describeConnectionCode('pane-remote://')).toBeNull();
    expect(describeConnectionCode('pane-remote://not-base64')).toBeNull();
  });
});
