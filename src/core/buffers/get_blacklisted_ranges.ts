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

// import {
//   concat as observableConcat,
//   Observable,
// } from "rxjs";
// import { ignoreElements } from "rxjs/operators";
import {
  Adaptation,
  Period,
  Representation,
} from "../../manifest";
import { QueuedSourceBuffer } from "../source_buffers";
import SegmentBookkeeper from "./segment_bookkeeper";

export default function getBlacklistedRanges(
  queuedSourceBuffer : QueuedSourceBuffer<unknown>,
  segmentBookkeeper : SegmentBookkeeper,
  contents : Array<{
    period : Period;
    adaptation : Adaptation;
    representation : Representation;
  }>
) : Array<[number, number]> {
  const ranges : Array<[number, number]> = [];
  segmentBookkeeper.synchronizeBuffered(queuedSourceBuffer.getBuffered());

  for (let i = 0; i < segmentBookkeeper.inventory.length; i++) {
    for (let j = 0; j < contents.length; j++) {
      const content = contents[j];
      const bufferedSegment = segmentBookkeeper.inventory[i];
      if (
        bufferedSegment.infos.period.id === content.period.id &&
        bufferedSegment.infos.adaptation.id === content.adaptation.id &&
        bufferedSegment.infos.representation.id === content.representation.id
      ) {
        const range : [number, number] = [
          bufferedSegment.bufferedStart == null ?
            bufferedSegment.start : bufferedSegment.bufferedStart,
          bufferedSegment.bufferedEnd == null ?
            bufferedSegment.end : bufferedSegment.bufferedEnd,
        ];
        ranges.push(range);
      }
    }
  }

  return ranges;
}
