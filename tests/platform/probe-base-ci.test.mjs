import test from 'node:test';
import assert from 'node:assert/strict';
import {probeBaseMarker} from './probe-base-ci.mjs';
test('基线探测用例',()=>{assert.equal(probeBaseMarker,'probe');});
