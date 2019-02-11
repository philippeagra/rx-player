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
  Observer,
  of as observableOf,
  Subject,
} from "rxjs";
import {
  catchError,
  distinctUntilChanged,
  map,
  mapTo,
  mergeMap,
  shareReplay,
  take,
  takeUntil,
  tap,
} from "rxjs/operators";
import openMediaSource from "../../../core/init/create_media_source";
import QueuedSourceBuffer from "../../../core/source_buffers/queued_source_buffer";
import arrayFind from "../../../utils/array_find";
import arrayFindIndex from "../../../utils/array_find_index";
import concatMapLatest from "../../../utils/concat_map_latest";

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

/**
 * Fetch data from URL
 * @param {string} url
 * @returns {Observable<ArrayBuffer>}
 */
function loadArrayBufferData(url: string): Observable<ArrayBuffer> {
  return new Observable((obs: Observer<ArrayBuffer>) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = (evt: any) => {
      if (xhr.status >= 200 && xhr.status < 300) {
        obs.next(evt.target.response);
        return;
      }
      obs.error(new Error("ImageLoader: Couldn't load data."));
    };
    xhr.send();
  });
}

/**
 *
 */
export default class ImageLoader {
  private readonly _videoElement : HTMLVideoElement;
  private readonly _ringBufferDepth: number;
  private  _initSegment: ArrayBuffer|null;
  private _thumbnailTrack : IThumbnailTrack|null;
  private _buffered: Array<[number, number, ArrayBuffer]>;

  private _setTime$: Subject<number>;
  private _dispose$: Subject<number>;
  private _mediaSourceInfos$: Observable<any>;

  constructor(
    videoElement: HTMLVideoElement,
    thumbnailTrack: IThumbnailTrack,
    ringBufferLength: number
  ) {
    this._ringBufferDepth = ringBufferLength;
    this._buffered = [];
    this._videoElement = videoElement;
    this._thumbnailTrack = thumbnailTrack;
    this._initSegment = null;

    this._setTime$ = new Subject();
    this._dispose$ = new Subject();
    this._setTime$.next();

    /**
     *
     * @param {HTMLVideoElement} elt
     */
    function prepareSourceBuffer(
      elt: HTMLVideoElement
    ): Observable<{
      mediaSource: MediaSource;
      videoSourceBuffer: QueuedSourceBuffer<any>;
    }> {
      return openMediaSource(elt).pipe(
        map((mediaSource) => {
          const sourceBuffer = mediaSource.addSourceBuffer(thumbnailTrack.codec);
          return {
            mediaSource,
            videoSourceBuffer:
              new QueuedSourceBuffer("video", thumbnailTrack.codec, sourceBuffer),
          };
        })
      );
    }

    /**
     *
     * @param {string} url
     * @param {string} codec
     * @param {Object} videoSourceBuffer
     */
    function appendInitSegment(
      url: string,
      codec: string,
      videoSourceBuffer: QueuedSourceBuffer<any>
    ): Observable<ArrayBuffer> {
      return loadArrayBufferData(url).pipe(
        mergeMap((e) => {
          return videoSourceBuffer.appendBuffer({
            initSegment : e,
            segment: null,
            codec,
            timestampOffset: 0,
          }).pipe(mapTo(e));
        })
      );
    }

    this._mediaSourceInfos$ = prepareSourceBuffer(this._videoElement).pipe(
      mergeMap(({ videoSourceBuffer }) => {
        if (!this._thumbnailTrack) {
          throw new Error("ImageLoader: No thumbnail track provided.");
        }
        const { init, codec } = thumbnailTrack;
        return appendInitSegment(init, codec, videoSourceBuffer).pipe(
          tap((initSegment) => this._initSegment = initSegment),
          mapTo((videoSourceBuffer))
        );
      }),
      catchError(() => {
        throw new Error("ImageLoaderError: Couldn't open media source.");
      }),
      shareReplay({ refCount: true })
    );

    observableCombineLatest(
      this._setTime$.pipe(distinctUntilChanged()),
      this._mediaSourceInfos$
    ).pipe(
      concatMapLatest(([time, videoSourceBuffer]) => {
        const bufferToRemove: Array<[number, number, ArrayBuffer]> = [];
        while (this._buffered.length > this._ringBufferDepth) {
          const newBuffer = this._buffered.shift();
          if (newBuffer) {
            bufferToRemove.push(newBuffer);
          }
        }

        const removeBuffer$: Observable<null> =
          bufferToRemove.length <= 0 ? observableOf(null) :
            observableCombineLatest(...
              bufferToRemove.map(([start, end]) => {
                return videoSourceBuffer.removeBuffer(start, end).pipe(
              );
            })
          ).pipe(mapTo(null));

        return removeBuffer$.pipe(
          catchError((_) => {
            throw new Error("ImageLoaderError: Couldn't remove buffer.");
          }),
          mergeMap(() => {
            if (!this._thumbnailTrack) {
              throw new Error("ImageLoader: No thumbnail track given.");
            }

            const thumbnail: IThumbnail|undefined =
              arrayFind(this._thumbnailTrack.thumbnails, (t) => {
                return t.start <= time && (t.duration + t.start) > time;
              });

            if (!thumbnail) {
              throw new Error("ImageLoaderError: Couldn't find thumbnail.");
            }

          const bufferIdx = arrayFindIndex(this._buffered, ([start, end]) => {
            return start <= time && end > time;
          });

          return (bufferIdx === -1 ? loadArrayBufferData(thumbnail.mediaURL).pipe(
            catchError((_) => {
              throw new Error("ImageLoaderError: Couldn't load thumbnail.");
            })) : observableOf(this._buffered[bufferIdx][2])).pipe(
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
                      "ImageLoaderError: Couldn't append buffer.");
                  }),
                  map(() => {
                    this._buffered.push([
                      thumbnail.start,
                      thumbnail.start + thumbnail.duration,
                      data,
                    ]);
                    this._videoElement.currentTime = time;
                    return time;
                  })
                );
            })
          );
        }),
        take(1)
      );
    }),
    catchError((err) => {
      throw err;
    }),
    takeUntil(this._dispose$)
    ).subscribe();
  }

  /**
   *
   * @param {Object} newTrack
   */
  updateThumbnailTrack(newTrack: IThumbnailTrack): void {
    this._thumbnailTrack = newTrack;
  }

  /**
   *
   * @param {number} time
   */
  setTime(time: number): void {
    this._setTime$.next(time);
  }

  /**
   *
   */
  dispose() {
    this._initSegment = null;
    this._thumbnailTrack = null;
    this._buffered = [];
    this._dispose$.next();
    this._setTime$.complete();
  }
}
