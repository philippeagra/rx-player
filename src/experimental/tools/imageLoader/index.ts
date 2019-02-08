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

import {
  combineLatest as observableCombineLatest,
  Observable,
  of as observableOf,
} from "rxjs";
import {
  catchError,
  exhaustMap,
  map,
  mapTo,
  mergeMap,
  shareReplay,
  tap,
} from "rxjs/operators";
import openMediaSource from "../../../core/init/create_media_source";
import QueuedSourceBuffer from "../../../core/source_buffers/queued_source_buffer";
import arrayFind from "../../../utils/array_find";
import castToObservable from "../../../utils/cast_to_observable";
import PPromise from "../../../utils/promise";

interface IThumbnail {
  start: number;
  duration: number;
  mediaURL: string;
}

interface IThumbnailTrack {
  thumbnails: IThumbnail[];
  init: string;
  codec: string;
}

function loadThumbnail(mediaURL: string): Promise<ArrayBuffer> {
  return new PPromise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", mediaURL, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = (evt: any) => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(evt.target.response);
        return;
      }
      reject();
    };
    xhr.send();
  });
}

export default class ImageLoader {
  private readonly _videoElement : HTMLVideoElement;
  private readonly _readyVideoElement$ : Observable<{
    videoSourceBuffer: QueuedSourceBuffer<any>;
    mediaSource: MediaSource;
  }>;
  private  _initSegment: ArrayBuffer|null;
  private _thumbnailTrack : IThumbnailTrack|null;
  private _buffered: Array<[number, number]>;

  constructor(
    videoElement: HTMLVideoElement,
    thumbnailTrack: IThumbnailTrack
  ) {
    this._buffered = [];
    this._videoElement = videoElement;
    this._thumbnailTrack = thumbnailTrack;
    this._initSegment = null;

    this._readyVideoElement$ = openMediaSource(this._videoElement).pipe(
      mergeMap((mediaSource) => {
        const sourceBuffer =
          mediaSource.addSourceBuffer(thumbnailTrack.codec); // XXX TODO adapt codec
        const videoSourceBuffer =
          new QueuedSourceBuffer("video", "video/mp4", sourceBuffer);

        if (!this._thumbnailTrack) {
          throw new Error();
        }

        return castToObservable(loadThumbnail(thumbnailTrack.init))
          .pipe(
            mergeMap((e) => {
              this._initSegment = e;
              return videoSourceBuffer.appendBuffer({
                initSegment : e,
                segment: null,
                codec: "",
                timestampOffset: 0,
              }) as Observable<any>;
            }),
            mapTo(({ videoSourceBuffer, mediaSource }))
        );
      }),
      shareReplay({ refCount : true })
    );

  }

  updateThumbnailTrack(newTrack: IThumbnailTrack): Promise<IThumbnailTrack|null> {
    return this._readyVideoElement$.pipe(
      catchError(() => {
        throw new Error("ImageLoaderError: Couldn't open media source.");
      }),
      tap(() => this._thumbnailTrack = newTrack),
      map(() => this._thumbnailTrack)
    ).toPromise(PPromise);
    // XXX TODO : Check if currently set image is correct ?
  }

  setTime(time: number): Promise<number> {
    return this._readyVideoElement$.pipe(
      catchError(() => {
        throw new Error("ImageLoaderError: Couldn't open media source.");
      }),
      mergeMap(({ videoSourceBuffer }) => {
        const removeBuffer$: Observable<null> =
          this._buffered.length <= 0 ? observableOf(null) :
            observableCombineLatest(...
              this._buffered.map(([start, end]) => {
                return videoSourceBuffer.removeBuffer(start, end).pipe(
                );
              })
            ).pipe(mapTo(null));
        return removeBuffer$.pipe(
          catchError((_) => {
            throw new Error("ImageLoaderError: Couldn't remove buffer.");
          }),
          exhaustMap(() => {
            this._buffered = [];
            if (!this._thumbnailTrack) {
              throw new Error("ImageLoader");
            }

            const thumbnail: IThumbnail|undefined =
              arrayFind(this._thumbnailTrack.thumbnails, (t) => {
                return t.start <= time && (t.duration + t.start) > time;
              });

            if (!thumbnail) {
              throw new Error("ImageLoaderError: Couldn't find thumbnail.");
            }

            return castToObservable(loadThumbnail(thumbnail.mediaURL)).pipe(
              catchError((_) => {
                throw new Error("ImageLoaderError: Couldn't load thumbnail.");
              }),
              mergeMap((data) => {
                return videoSourceBuffer
                  .appendBuffer({
                    segment: data,
                    initSegment: this._initSegment,
                    codec: "null",
                    timestampOffset: 0,
                  }).pipe(
                    catchError((_) => {
                      throw new Error(
                        "ImageLoaderError: Couldn't load append buffer.");
                    }),
                    map(() => {
                      this._buffered
                        .push([thumbnail.start, thumbnail.start + thumbnail.duration]);
                      this._videoElement.currentTime = time;
                      return time;
                    })
                  );
              })
            );
          })
        );
      })
    ).toPromise(PPromise);
  }

  dispose() {
    this._thumbnailTrack = null;
  }
}
