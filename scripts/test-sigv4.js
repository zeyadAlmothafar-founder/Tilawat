// Checks the SigV4 signer in scripts/upload-r2.js against AWS's published test vectors.
//   node scripts/test-sigv4.js
import assert from 'node:assert/strict';
import { signRequest, signingKey } from './upload-r2.js';

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

// AWS SigV4 test suite, "get-vanilla" (region us-east-1, service "service").
check('get-vanilla', () => {
  const r = signRequest({
    ...CREDS,
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
    region: 'us-east-1',
    service: 'service',
  });
  assert.equal(r.canonicalRequest, [
    'GET', '/', '',
    'host:example.amazonaws.com', 'x-amz-date:20150830T123600Z', '',
    'host;x-amz-date',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'));
  assert.equal(r.stringToSign, [
    'AWS4-HMAC-SHA256', '20150830T123600Z', '20150830/us-east-1/service/aws4_request',
    'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
  ].join('\n'));
  assert.equal(r.headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

// AWS docs, "Examples of how to derive a signing key for Signature Version 4" (iam, 20120215).
check('derived signing key', () => {
  assert.equal(signingKey(CREDS.secretAccessKey, '20120215', 'us-east-1', 'iam').toString('hex'),
    'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
});

console.log(`${passed} SigV4 checks passed`);
