import { readFileSync } from 'node:fs';

// Included in desktop/**/* so the installed application uses the same pin
// that the upgrade checks and package preparation validate.
export const HARNESS_UPSTREAM = Object.freeze(JSON.parse(readFileSync(new URL('./upstream/harness.json', import.meta.url), 'utf8')));
export const HARNESS_VERSION = HARNESS_UPSTREAM.version;
