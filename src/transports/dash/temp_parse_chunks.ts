/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { findBox } from "../../parsers/containers/isobmff/utils";
import { be4toi } from "../../utils/byte_parsing";

export default function parseChunks(buffer: Uint8Array) {
  let header;
  const firstMoofIndex = findBox(buffer, 0x6d6f6f66);
  if (firstMoofIndex > -1) {
    header = buffer.subarray(0, firstMoofIndex);
  }

  const chunks = [];
  let pos = firstMoofIndex;

  if (pos > -1) {
    while (pos < buffer.length) {
      const moofLen = be4toi(buffer, pos);
      if (moofLen + pos > buffer.length) {
        pos = buffer.length + 1;
      } else {
        const mdatLen = be4toi(buffer, moofLen + pos);
        if (moofLen + mdatLen + pos <= buffer.length) {
          const chunk = buffer.subarray(pos, pos + moofLen + mdatLen);
          chunks.push(chunk);
          pos += (moofLen + mdatLen);
        } else {
          pos = buffer.length + 1;
        }
      }
    }
  }

  return {
    header,
    chunks,
  };
}
