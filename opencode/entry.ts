// opencode 2.x plugin entry for opencode-condense.
//
// Point opencode at this file in your config and set the decision endpoint in
// the plugin options (or via the CONDENSE_* env vars, see README "Configuration"):
//
//   {
//     "plugin": [
//       [
//         "C:/path/to/opencode-condense/opencode/entry.ts",
//         {
//           "baseUrl": "http://127.0.0.1:8971",
//           "model": "fake-decision",
//           "apiKey": "unused",
//           "compactAtPercent": 60
//         }
//       ]
//     ]
//   }
//
// The plugin is fail-open by contract: any scorer error, timeout or malformed
// answer leaves the conversation untouched and cools the pass down.

import { createCondenseV2Plugin } from './v2-plugin.js';

export default createCondenseV2Plugin();
